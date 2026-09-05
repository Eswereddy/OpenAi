// profile-parser.js
// The 5th AI touchpoint: "Fill by talking". A citizen speaks or types one
// free-form sentence describing themselves instead of filling in each form
// field by hand, and this turns it into the SAME structured fields the
// eligibility form already collects — never a new set of fields, never a
// new eligibility path. Autofill only; the citizen still sees every field
// filled in and can review or correct anything before pressing "Check my
// eligibility". The rule engine in schemes.js remains the only thing that
// ever decides eligibility — this file only helps populate its inputs.
//
// Same boundary discipline as every other AI file here (see ai-summary.js):
// never invent a value the citizen didn't actually say. Every field is
// either lifted straight from their own words or left blank for them to
// fill in manually — no guessing, no defaults.
//
// Degrades to a dependency-free regex/keyword parser when no AI provider is
// configured, so "fill by talking" still does something useful offline or
// with zero API keys set, instead of just disappearing — same "always still
// works" principle as the rest of this app's AI layer.

const { generateText, hasProvider } = require("./ai-provider");

const STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Delhi","Jammu and Kashmir","Ladakh","Puducherry","Chandigarh"];
const OCCUPATIONS = ["farmer","student","construction","unemployed","self-employed","daily-wage","salaried","homemaker","retired","other"];
const CATEGORIES = ["general","obc","sc","st","ews","minority"];
const GENDERS = ["female","male","other"];

// Kept intentionally to the fields most people can actually describe in one
// or two spoken sentences — the same set the offline live-preview matches
// against. Occupation-specific follow-up fields (education level, crop
// type, labour-card status, etc.) stay as manual questions the form reveals
// once occupation is set; asking someone to narrate all of those in one go
// would defeat the point of making this faster than typing.
const FIELD_SPEC = `{
  "age": number or null,
  "gender": one of ${JSON.stringify(GENDERS)} or null,
  "state": one of ${JSON.stringify(STATES)} (must match one of these exactly, or null if not mentioned or unclear),
  "occupation": one of ${JSON.stringify(OCCUPATIONS)} or null,
  "income": number in rupees PER YEAR (convert phrases like "1.2 lakh a year" -> 120000, "15000 a month" -> 180000) or null,
  "category": one of ${JSON.stringify(CATEGORIES)} or null,
  "landHolding": number of acres of farmland owned/worked, only if mentioned, or null,
  "hasBankAccount": true, false, or null,
  "noPuccaHouse": true if they say they do NOT have a pucca/concrete house, false if they say they do, otherwise null,
  "isDisabled": true, false, or null,
  "isWidow": true, false, or null,
  "isMaternity": true if pregnant or has a child under 1 year old, otherwise null,
  "hasBplCard": true, false, or null
}`;

const SPOKEN_LANGUAGE_NAME = { en: "English", hi: "Hindi", te: "Telugu" };

function buildPrompt(text, language) {
  const langName = SPOKEN_LANGUAGE_NAME[language] || "English";
  return `A citizen is speaking to a government welfare-scheme eligibility form and describing themselves in their own words, instead of filling in each field by hand one at a time. Extract ONLY the fields they actually stated into this exact JSON shape (use null for anything not mentioned or genuinely ambiguous — never guess, infer, or invent a value that wasn't said):\n\n${FIELD_SPEC}\n\nRespond with ONLY the JSON object — no markdown code fences, no commentary, no explanation.\n\nWhat they said (may be in ${langName} or a mix of English and ${langName}, and may contain speech-recognition errors — use your best judgement but stay conservative): "${text.replace(/"/g, "'")}"`;
}

function cleanNumber(v, { min = 0, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// Same discipline as validate.js at the API boundary: an out-of-range or
// unrecognised value is dropped back to "not provided", never coerced into
// a nearby "valid" one that would misrepresent what the citizen actually
// said.
function normalizeFields(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  if (raw.age != null) { const n = cleanNumber(raw.age, { min: 0, max: 120 }); if (n != null) out.age = n; }
  if (raw.gender != null && GENDERS.includes(raw.gender)) out.gender = raw.gender;
  if (raw.state != null) {
    const match = STATES.find((s) => s.toLowerCase() === String(raw.state).trim().toLowerCase());
    if (match) out.state = match;
  }
  if (raw.occupation != null && OCCUPATIONS.includes(raw.occupation)) out.occupation = raw.occupation;
  if (raw.income != null) { const n = cleanNumber(raw.income, { min: 0, max: 100000000 }); if (n != null) out.income = n; }
  if (raw.category != null && CATEGORIES.includes(raw.category)) out.category = raw.category;
  if (raw.landHolding != null) { const n = cleanNumber(raw.landHolding, { min: 0, max: 100000 }); if (n != null) out.landHolding = n; }
  for (const key of ["hasBankAccount", "noPuccaHouse", "isDisabled", "isWidow", "isMaternity", "hasBplCard"]) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}

// ---- Dependency-free heuristic fallback (no AI key configured) ----
// Deliberately conservative: only sets a field when a fairly unambiguous
// pattern matches. Missing a field here just means the citizen fills that
// one box by hand — same safe failure mode as the AI path returning null.
function heuristicParse(text) {
  const t = ` ${text.toLowerCase()} `;
  const out = {};

  const ageMatch = t.match(/\b(\d{1,3})\s*(?:years?|yrs?|साल|वर्ष|సంవత్సరాలు|ఏళ్[ళల]ు?)(?:\s*old)?/) || t.match(/\bage\s*(?:is|:)?\s*(\d{1,3})\b/);
  if (ageMatch) { const n = Number(ageMatch[1]); if (n >= 0 && n <= 120) out.age = n; }

  if (/\bfemale\b|\bwoman\b|\bwife\b|महिला|पत्नी|స్త్రీ|మహిళ|భార్య/.test(t)) out.gender = "female";
  else if (/\bmale\b|\bman\b|\bhusband\b|पुरुष|पति|పురుషుడు|భర్త/.test(t)) out.gender = "male";

  for (const s of STATES) { if (t.includes(s.toLowerCase())) { out.state = s; break; } }

  // Hindi and Telugu state names for the few most commonly spoken ones —
  // the AI path (when a key is configured) covers the rest; this is only
  // the offline last resort, not the primary translation mechanism.
  const REGIONAL_STATE_HINTS = {
    "आंध्र प्रदेश": "Andhra Pradesh", "तेलंगाना": "Telangana", "बिहार": "Bihar",
    "उत्तर प्रदेश": "Uttar Pradesh", "महाराष्ट्र": "Maharashtra", "राजस्थान": "Rajasthan",
    "मध्य प्रदेश": "Madhya Pradesh", "पंजाब": "Punjab", "गुजरात": "Gujarat",
    "कर्नाटक": "Karnataka", "तमिलनाडु": "Tamil Nadu", "केरल": "Kerala",
    "पश्चिम बंगाल": "West Bengal", "ओडिशा": "Odisha", "दिल्ली": "Delhi",
    "ఆంధ్రప్రదేశ్": "Andhra Pradesh", "తెలంగాణ": "Telangana", "తమిళనాడు": "Tamil Nadu",
    "కర్ణాటక": "Karnataka", "కేరళ": "Kerala", "ఒడిశా": "Odisha", "మహారాష్ట్ర": "Maharashtra",
  };
  if (!out.state) { for (const hint in REGIONAL_STATE_HINTS) { if (t.includes(hint)) { out.state = REGIONAL_STATE_HINTS[hint]; break; } } }

  const occMap = [
    [/\bfarm(er|ing)\b|\bagricultur|किसान|खेती|రైతు|వ్యవసాయం/, "farmer"],
    [/\bstudent\b|\bstudying\b|\bcollege\b|\bschool\b|छात्र|विद्यार्थी|విద్యార్థి|చదువుతున్న/, "student"],
    [/\bconstruction\b|\bmason\b|\bbuilding worker\b|निर्माण मजदूर|मिस्त्री|నిర్మాణ కార్మికుడు|మేస్త్రి/, "construction"],
    [/\bunemployed\b|\bjobless\b|\blooking for (a )?job\b|बेरोज़गार|बेरोजगार|నిరుద్యోగి|ఉద్యోగం లేదు/, "unemployed"],
    [/\bself[- ]employed\b|\bown (shop|business)\b|\bsmall business\b|स्वरोजगार|छोटा व्यवसाय|స్వయం ఉపాధి|చిన్న వ్యాపారం/, "self-employed"],
    [/\bdaily[- ]wage\b|\bdaily wage labour|दिहाड़ी मजदूर|రోజువారీ కూలీ|దినసరి కూలి/, "daily-wage"],
    [/\bsalaried\b|\bprivate job\b|\bworking in a company\b|वेतनभोगी|జీతం ఉద్యోగి|ప్రైవేట్ ఉద్యోగం/, "salaried"],
    [/\bhomemaker\b|\bhousewife\b|गृहिणी|గృహిణి/, "homemaker"],
    [/\bretired\b|\bpension(er)?\b|सेवानिवृत्त|पेंशनभोगी|పదవీ విరమణ|పింఛనుదారు/, "retired"],
  ];
  for (const [re, val] of occMap) { if (re.test(t)) { out.occupation = val; break; } }

  const incomeLakh = t.match(/([\d.]+)\s*lakh|([\d.]+)\s*लाख|([\d.]+)\s*లక్ష/);
  const incomeMonthly = t.match(/(?:rs\.?|₹)?\s*([\d,]+)\s*(?:rupees)?\s*(?:per month|\/month|a month|monthly|महीना|माह|నెలకు|నెలవారీ)/);
  const incomeRaw = t.match(/(?:income|earn(?:s|ing)?|आय|ఆదాయం)\s*(?:is|of|:)?\s*(?:rs\.?|₹)?\s*([\d,]+)/);
  if (incomeLakh) out.income = Math.round(parseFloat(incomeLakh[1] || incomeLakh[2] || incomeLakh[3]) * 100000);
  else if (incomeMonthly) out.income = Math.round(parseFloat(incomeMonthly[1].replace(/,/g, "")) * 12);
  else if (incomeRaw) out.income = Math.round(parseFloat(incomeRaw[1].replace(/,/g, "")));

  for (const c of ["obc", "sc", "st", "ews"]) { if (new RegExp(`\\b${c}\\b`).test(t)) { out.category = c; break; } }
  if (/\bminority\b|अल्पसंख्यक|మైనారిటీ/.test(t)) out.category = "minority";
  if (!out.category && /\bgeneral category\b|सामान्य वर्ग|జనరల్ కేటగిరీ/.test(t)) out.category = "general";

  const landMatch = t.match(/([\d.]+)\s*acres?|([\d.]+)\s*एकड़|([\d.]+)\s*ఎకరా/);
  if (landMatch) out.landHolding = parseFloat(landMatch[1] || landMatch[2] || landMatch[3]);

  if (/\bno bank account\b|\bdon'?t have a bank account\b|\bwithout a bank account\b|बैंक खाता नहीं|బ్యాంకు ఖాతా లేదు/.test(t)) out.hasBankAccount = false;
  else if (/\bbank account\b|बैंक खाता|బ్యాంకు ఖాతా/.test(t)) out.hasBankAccount = true;

  if (/\bno pucca\b|\bkutcha house\b|\bdon'?t have a (pucca|concrete) house\b|पक्का घर नहीं|పక్కా ఇల్లు లేదు/.test(t)) out.noPuccaHouse = true;

  if (/\bdisab(led|ility)\b|\bdivyang\b|दिव्यांग|विकलांग|దివ్యాంగ|వికలాంగ/.test(t)) out.isDisabled = true;
  if (/\bwidow\b|विधवा|వితంతువు/.test(t)) out.isWidow = true;
  if (/\bpregnant\b|\bmaternity\b|\bchild under (one|1) year\b|गर्भवती|గర్భవతి/.test(t)) out.isMaternity = true;
  if (/\bbpl\b|\bration card\b|राशन कार्ड|రేషన్ కార్డు/.test(t)) out.hasBplCard = true;

  return out;
}

async function parseProfileFromText({ text, language }) {
  const trimmed = (text || "").trim().slice(0, 1000);
  if (!trimmed) return { fields: {}, source: "empty" };

  if (!hasProvider()) {
    return { fields: heuristicParse(trimmed), source: "heuristic" };
  }

  try {
    const prompt = buildPrompt(trimmed, ["hi", "te"].includes(language) ? language : "en");
    const raw = await generateText({ system: null, messages: [{ role: "user", content: prompt }], maxTokens: 300 });
    const jsonStr = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    return { fields: normalizeFields(parsed), source: "ai" };
  } catch (err) {
    console.error("AI profile parse failed, using heuristic fallback:", err.message);
    return { fields: heuristicParse(trimmed), source: "heuristic" };
  }
}

module.exports = { parseProfileFromText, heuristicParse, normalizeFields, STATES, OCCUPATIONS, CATEGORIES, GENDERS };
