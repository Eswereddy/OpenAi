// action-plan.js
// The "AI agent" touchpoint: not just explaining a result (ai-summary.js)
// or answering an open-ended question (chat-assistant.js), but reasoning
// across every match — including the "not eligible" and "needs
// verification" ones the citizen might otherwise skip past — to produce a
// short, prioritized list of concrete next actions that would get them
// verified faster or unlock schemes they're close to qualifying for.
//
// Same boundary as every other AI touchpoint in this app: it never decides
// or changes eligibility, and it never invents a document, action, or
// scheme. Every input it's given already came out of the rule engine's own
// `reasons.action` / `reasons.watch` fields (see schemes.js's RESULT MODEL
// comment) — this only prioritizes and rephrases what the engine already
// said was worth doing, in plain, encouraging language. If no provider is
// configured or the call fails, it falls back to a deterministic list built
// from those exact same fields, so the feature can never block a citizen
// from getting a useful next step.

const { generateText, hasProvider } = require("./ai-provider");
const aiCache = require("./ai-cache");
const PLAN_CACHE_TTL_MS = 15 * 60 * 1000;
const LANGUAGE_NAME = { en: "English", hi: "Hindi", te: "Telugu" };

// Pull out exactly what the rule engine already flagged as "worth doing"
// for this profile: pending-verification items to confirm, and near-miss /
// missing-info items that could turn a "not eligible" or "insufficient
// info" into a real match. Caps keep the prompt small and the model from
// ever seeing (and so ever inventing from) more than a citizen's actual
// results.
function collectActionItems(matches, catalogById) {
  const items = [];
  for (const m of matches || []) {
    const scheme = (catalogById && catalogById[m.id]) || {};
    const name = scheme.name || m.id;
    const watch = (m.reasons && Array.isArray(m.reasons.watch)) ? m.reasons.watch : [];
    const action = (m.reasons && Array.isArray(m.reasons.action)) ? m.reasons.action : [];
    if (m.status === "needs_verification") {
      watch.forEach((w) => items.push({ scheme: name, kind: "verify", text: w }));
    }
    if (m.status === "not_eligible" || m.status === "insufficient_info") {
      action.forEach((a) => items.push({ scheme: name, kind: "unlock", text: a }));
    }
  }
  // De-dupe identical action text across schemes (several schemes often
  // share the same underlying ask, e.g. "confirm your BPL/SECC status").
  const seen = new Set();
  return items.filter((it) => {
    const key = it.kind + ":" + it.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function buildPrompt(profile, items, eligibleCount, language) {
  const profileLine = [
    profile.occupation ? `occupation: ${profile.occupation}` : null,
    profile.state ? `state: ${profile.state}` : null,
  ].filter(Boolean).join(", ");

  const itemLines = items.map((it, i) =>
    `${i + 1}. [${it.kind === "verify" ? "confirm for " + it.scheme : "could unlock " + it.scheme}] ${it.text}`
  ).join("\n");

  return `A citizen used a government welfare-scheme checker. They already have ${eligibleCount} confirmed/likely-eligible ` +
    `scheme match${eligibleCount === 1 ? "" : "es"} (already shown to them elsewhere — do not re-list those). ` +
    `Below is a raw list of follow-up items the checker's own rules engine flagged: things to verify for schemes ` +
    `they're pending on, and gaps that — if resolved — could unlock schemes they're currently missing. ` +
    `Turn this into a short, prioritized action plan: at most 5 numbered steps, each one short sentence, ` +
    `plain language, most impactful/easiest first. Do not invent any action, document, or scheme beyond what's listed. ` +
    `No headings, no markdown, just a numbered list. Respond in ${LANGUAGE_NAME[language] || "English"}.\n\n` +
    `Citizen profile: ${profileLine || "not provided"}\n\n` +
    `Flagged items:\n${itemLines}`;
}

// Deterministic fallback: the raw, de-duped action items themselves, as a
// numbered list — no AI needed to make this useful, since the rule engine
// already wrote each one in plain language.
function templatePlan(items, eligibleCount, language) {
  if (!items.length) {
    if (eligibleCount > 0) {
      if (language === "hi") return "फ़िलहाल कोई और कार्रवाई ज़रूरी नहीं — जो योजनाएँ मिली हैं उनके लिए ऊपर दिए गए पोर्टल लिंक से आवेदन करें।";
      if (language === "te") return "ప్రస్తుతం ఇంకేమీ చేయాల్సిన అవసరం లేదు — పైన కనిపించిన పథకాలకు అక్కడి పోర్టల్ లింక్ ద్వారా దరఖాస్తు చేసుకోండి.";
      return "No further action items right now — go ahead and apply to your matched schemes above using the portal links on each card.";
    }
    if (language === "hi") return "इस प्रोफ़ाइल के लिए फ़िलहाल कोई सुझाव नहीं है। ऊपर अपने उत्तर बदलकर दोबारा जाँच करें।";
    if (language === "te") return "ఈ ప్రొఫైల్‌కు ప్రస్తుతం సూచనలు లేవు. పైన మీ వివరాలు మార్చి మళ్ళీ చూడండి.";
    return "No specific next steps for this profile right now. Try adjusting a detail above and checking again.";
  }
  const lines = items.slice(0, 5).map((it, i) => `${i + 1}. ${it.text}`);
  const intro = language === "hi" ? "अगले कदम:" : language === "te" ? "తదుపరి చర్యలు:" : "Next steps:";
  return `${intro}\n${lines.join("\n")}`;
}

async function generateActionPlan({ profile, matches, catalogById, language }) {
  const items = collectActionItems(matches || [], catalogById || {});
  const eligibleCount = (matches || []).filter((m) => m.status === "eligible" || m.status === "needs_verification").length;

  if (!hasProvider()) {
    return { plan: templatePlan(items, eligibleCount, language), source: "template" };
  }
  if (!items.length) {
    // Nothing to prioritize — skip the model call entirely rather than
    // ask it to elaborate on an empty list.
    return { plan: templatePlan(items, eligibleCount, language), source: "template" };
  }

  const prompt = buildPrompt(profile || {}, items, eligibleCount, language);
  const cacheKey = "actionplan:" + prompt;
  const cached = aiCache.get(cacheKey);
  if (cached) return { plan: cached, source: "ai-cached" };

  try {
    const text = await generateText({ system: null, messages: [{ role: "user", content: prompt }], maxTokens: 350 });
    aiCache.set(cacheKey, text, PLAN_CACHE_TTL_MS);
    return { plan: text, source: "ai" };
  } catch (err) {
    console.error("AI action plan generation failed, using template fallback:", err.message);
    return { plan: templatePlan(items, eligibleCount, language), source: "template" };
  }
}

module.exports = { generateActionPlan, collectActionItems };
