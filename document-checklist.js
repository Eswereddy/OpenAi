// document-checklist.js
// Solves a specific, concrete pain point: a citizen who matches 5-6 schemes
// currently has to open each scheme card separately to see its document
// list, then mentally de-duplicate "Aadhaar card" across all of them. This
// builds one consolidated checklist instead — every unique document, which
// of the matched schemes need it, and a short "how to get it" tip — so
// there's one list to work from before starting any application.
//
// Deliberately mostly deterministic, not AI-written end to end: document
// names and which schemes need them come straight from the rule engine's
// own catalog (schemes.js `docs` field via the DB), never invented. The
// built-in TIP_LIBRARY below covers the common Indian ID/income/land
// documents that appear across this app's schemes with a short, generic,
// factual pointer (where to get or update it) — no scheme-specific
// procedure is claimed. For any document that isn't in that library, an AI
// call (if configured) is asked for ONE short, generic tip grounded only in
// the document's name; with no provider configured, or if that call fails,
// it gets a safe generic fallback tip instead. This keeps the checklist
// itself always fully correct and only ever uses AI for the smallest,
// lowest-risk part — the "where to get it" nudge on top.

const { generateText, hasProvider } = require("./ai-provider");
const aiCache = require("./ai-cache");
const TIP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a document's "how to get it" tip doesn't change per-session, so this can live much longer than the summary/chat caches

// Matched case-insensitively / by substring against each scheme's document
// name, since the same document appears with slightly different wording
// across schemes ("Bank passbook" vs "Bank account (Aadhaar-seeded)").
const TIP_LIBRARY = [
  { match: /aadhaar/i, en: "Free. Apply or update at your nearest Aadhaar Seva Kendra, or online at uidai.gov.in.", hi: "निःशुल्क। नज़दीकी आधार सेवा केंद्र पर या uidai.gov.in पर आवेदन/अपडेट करें।" },
  { match: /ration card|secc|family id/i, en: "Apply through your state's Public Distribution System (PDS) office or Common Service Centre (CSC).", hi: "अपने राज्य के खाद्य/PDS कार्यालय या कॉमन सर्विस सेंटर (CSC) से आवेदन करें।" },
  { match: /income certificate|bpl/i, en: "Issued by your Tehsildar / Revenue office, or apply online via your state's e-district portal.", hi: "तहसीलदार/राजस्व कार्यालय से जारी होता है, या राज्य के ई-डिस्ट्रिक्ट पोर्टल से आवेदन करें।" },
  { match: /caste|ews certificate/i, en: "Issued by your Tehsildar / Revenue office; carry proof of residence and community records.", hi: "तहसीलदार/राजस्व कार्यालय से जारी होता है; निवास प्रमाण और सामुदायिक रिकॉर्ड साथ रखें।" },
  { match: /land record|khatauni|land ownership|land\/property/i, en: "Available at your local revenue/land records office, or your state's online land-records portal.", hi: "स्थानीय राजस्व/भू-अभिलेख कार्यालय या राज्य के ऑनलाइन भू-अभिलेख पोर्टल पर उपलब्ध।" },
  { match: /bank (account|passbook)/i, en: "Open a zero-balance account (e.g. under PM Jan Dhan Yojana) at any nearby bank branch or business correspondent.", hi: "किसी भी नज़दीकी बैंक शाखा या बिज़नेस कॉरेस्पॉन्डेंट पर ज़ीरो-बैलेंस खाता (जैसे PM जन धन योजना के तहत) खोलें।" },
  { match: /disability certificate|udid/i, en: "Issued after assessment at a government hospital / district medical board; apply via the UDID portal (swavlambancard.gov.in).", hi: "सरकारी अस्पताल/जिला मेडिकल बोर्ड में जांच के बाद जारी होता है; UDID पोर्टल (swavlambancard.gov.in) से आवेदन करें।" },
  { match: /death certificate/i, en: "Issued by your local municipal body / gram panchayat that registered the death.", hi: "स्थानीय नगर निकाय/ग्राम पंचायत से जारी होता है जहाँ मृत्यु दर्ज हुई थी।" },
  { match: /age proof/i, en: "Aadhaar card, birth certificate, or voter ID all work as age proof for most schemes.", hi: "अधिकांश योजनाओं के लिए आधार कार्ड, जन्म प्रमाण पत्र या वोटर आईडी उम्र के प्रमाण के रूप में मान्य हैं।" },
  { match: /labour\/registration card|construction/i, en: "Register with your state's Building & Other Construction Workers (BOCW) Welfare Board — usually at the local labour office.", hi: "अपने राज्य के भवन एवं अन्य निर्माण कामगार (BOCW) कल्याण बोर्ड में पंजीकरण करें — आमतौर पर स्थानीय श्रम कार्यालय में।" },
  { match: /school id|mark ?sheet|marksheet/i, en: "Available from your current or most recently attended school/institution.", hi: "अपने वर्तमान या पिछले स्कूल/संस्थान से प्राप्त करें।" },
  { match: /mcp card/i, en: "Issued free at your local government hospital or Anganwadi centre when you register a pregnancy.", hi: "गर्भावस्था पंजीकरण के समय स्थानीय सरकारी अस्पताल या आंगनवाड़ी केंद्र में निःशुल्क जारी होता है।" },
  { match: /sowing certificate/i, en: "Issued by your local Patwari / agriculture department after they record what you've sown that season.", hi: "पटवारी/कृषि विभाग द्वारा उस मौसम की बुवाई दर्ज करने के बाद जारी किया जाता है।" },
  { match: /trade|craft/i, en: "A local trade body, ITI, or district industries centre can issue proof of your traditional trade.", hi: "स्थानीय व्यापार संस्था, आईटीआई या जिला उद्योग केंद्र आपके पारंपरिक व्यवसाय का प्रमाण जारी कर सकता है।" },
  { match: /auto-debit consent/i, en: "Sign this at your bank branch when enrolling — it lets the small annual premium be deducted automatically.", hi: "नामांकन के समय अपनी बैंक शाखा में हस्ताक्षर करें — इससे वार्षिक प्रीमियम स्वतः कट जाता है।" },
];

const GENERIC_TIP = {
  en: "Check with your local Common Service Centre (CSC), e-mitra kiosk, or the scheme's official portal for how to obtain this.",
  hi: "इसे प्राप्त करने के तरीके के लिए अपने नज़दीकी कॉमन सर्विस सेंटर (CSC), ई-मित्र कियोस्क या योजना के आधिकारिक पोर्टल से संपर्क करें।",
};

function libraryTip(docName, language) {
  const entry = TIP_LIBRARY.find((t) => t.match.test(docName));
  if (!entry) return null;
  return language === "hi" ? entry.hi : entry.en;
}

// Builds the consolidated, deduplicated document -> schemes map straight
// from the matched schemes' own catalog `docs` field. This part never
// touches AI — it's a pure aggregation of data the rule engine already
// returned, so it's exactly as trustworthy as the scheme cards themselves.
function buildChecklist(matches, catalogById) {
  const positiveIds = (matches || [])
    .filter((m) => m.status === "eligible" || m.status === "needs_verification")
    .map((m) => m.id);
  const byDoc = new Map(); // doc name -> Set(scheme names)
  for (const id of positiveIds) {
    const scheme = (catalogById && catalogById[id]) || {};
    const docs = Array.isArray(scheme.docs) ? scheme.docs : [];
    for (const doc of docs) {
      if (!doc) continue;
      if (!byDoc.has(doc)) byDoc.set(doc, new Set());
      byDoc.get(doc).add(scheme.name || id);
    }
  }
  return Array.from(byDoc.entries()).map(([doc, schemeSet]) => ({
    document: doc,
    neededFor: Array.from(schemeSet),
  }));
}

async function tipFor(docName, language) {
  const known = libraryTip(docName, language);
  if (known) return known;

  if (!hasProvider()) return GENERIC_TIP[language] || GENERIC_TIP.en;

  const cacheKey = "doctip:" + language + ":" + docName.toLowerCase();
  const cached = aiCache.get(cacheKey);
  if (cached) return cached;

  const prompt = `In one short sentence (under 20 words, plain language, no markdown), give a generic, factual tip on ` +
    `where an Indian citizen would typically obtain or apply for this document: "${docName}". ` +
    `If you are not confident about a specific, correct process, just say to check with the local Common Service Centre ` +
    `or the relevant government office — never invent a specific portal name or fee you are not sure of. ` +
    `Respond in ${language === "hi" ? "Hindi" : "English"}.`;

  try {
    const text = await generateText({ system: null, messages: [{ role: "user", content: prompt }], maxTokens: 60 });
    aiCache.set(cacheKey, text, TIP_CACHE_TTL_MS);
    return text;
  } catch (err) {
    console.error(`Document tip generation failed for "${docName}", using generic fallback:`, err.message);
    return GENERIC_TIP[language] || GENERIC_TIP.en;
  }
}

async function generateChecklist({ matches, catalogById, language }) {
  const items = buildChecklist(matches || [], catalogById || {});
  if (!items.length) return { checklist: [], source: "template" };

  // Cap concurrent AI calls to keep this snappy and cheap even when a
  // profile matches many schemes with many unique documents — the library
  // above already covers the documents that appear across almost every
  // real match, so only a handful of calls (often zero) actually happen.
  const withTips = await Promise.all(items.map(async (it) => ({
    ...it,
    tip: await tipFor(it.document, language),
  })));
  const anyAiTip = hasProvider() && items.some((it) => !libraryTip(it.document, language));
  return { checklist: withTips, source: anyAiTip ? "mixed" : "template" };
}

module.exports = { generateChecklist, buildChecklist };
