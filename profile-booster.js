// profile-booster.js
// NEW FEATURE — the 7th AI touchpoint: "What should I fill in next?"
//
// Problem this solves: a citizen who answers only the required fields gets a
// real, honest result — but some schemes come back "insufficient_info"
// because the rule engine genuinely can't tell without one more fact (an
// income figure, a BPL/ration card, a disability flag, a bank account).
// Nothing on the results page today tells them *which one fact* would do
// the most good, so they either give up or re-fill the whole form guessing.
//
// This module never invents a missing fact or a new field. It only reads
// the `reasons.watch` strings the rule engine (schemes.js) already attached
// to each "insufficient_info" / "needs_verification" match, groups the
// underlying profile field each one is really asking for, and asks an LLM
// to turn that into a short, prioritized, plain-language nudge — "answering
// your household income could unlock up to 3 more schemes". If no provider
// is configured (or the call fails), it degrades to a deterministic
// ranked list built from the same watch strings — same "never blocks the
// citizen" guarantee as every other AI file in this app.

const { generateText, hasProvider } = require("./ai-provider");
const aiCache = require("./ai-cache");
const BOOSTER_CACHE_TTL_MS = 15 * 60 * 1000;

// Maps a watch-string's telltale phrase to the actual form field it's
// really asking about, and a short human label for the fallback template.
// Order matters only for tie-breaking; ranking itself is by how many
// distinct matches raised the same underlying field.
const FIELD_HINTS = [
  { test: /household income/i, field: "income", label: "your household income" },
  { test: /bpl\/ration card|bpl card|ration card/i, field: "bplCard", label: "whether you hold a BPL/ration card" },
  { test: /bank account/i, field: "bankAccount", label: "whether you have a bank account" },
  { test: /disability/i, field: "disability", label: "whether you have a disability" },
  { test: /widow/i, field: "widow", label: "your widow status" },
  { test: /pucca house|kutcha/i, field: "noPuccaHouse", label: "your housing status" },
  { test: /maternity|pregnan/i, field: "maternity", label: "your maternity status" },
  { test: /category/i, field: "category", label: "your social category (SC/ST/OBC/EWS)" },
];

// Pulls one { field, label, schemeNames[] } entry per distinct missing
// field out of the matches the rule engine already returned — grounding
// this entirely in real, already-computed data, never a guess.
function collectGaps(matches, catalogById) {
  const gaps = new Map(); // field -> { label, schemeNames: Set }
  for (const m of matches || []) {
    if (m.status !== "insufficient_info" && m.status !== "needs_verification") continue;
    const watch = (m.reasons && m.reasons.watch) || [];
    for (const line of watch) {
      const hint = FIELD_HINTS.find((h) => h.test.test(line));
      if (!hint) continue;
      if (!gaps.has(hint.field)) gaps.set(hint.field, { label: hint.label, schemeNames: new Set() });
      const scheme = (catalogById && catalogById[m.id]) || {};
      gaps.get(hint.field).schemeNames.add(scheme.name || m.id);
    }
  }
  return [...gaps.entries()]
    .map(([field, v]) => ({ field, label: v.label, schemeNames: [...v.schemeNames] }))
    .sort((a, b) => b.schemeNames.length - a.schemeNames.length)
    .slice(0, 3);
}

function templateBoost(gaps, language) {
  if (!gaps.length) {
    if (language === "hi") return { tips: [], summary: "अभी और जानकारी की ज़रूरत नहीं — आपके सभी जवाब पूरे हैं।" };
    if (language === "te") return { tips: [], summary: "ప్రస్తుతం మరింత సమాచారం అవసరం లేదు — మీ సమాధానాలు పూర్తయ్యాయి." };
    return { tips: [], summary: "No extra info needed right now — your answers already cover every match." };
  }
  const tips = gaps.map((g) => {
    const count = g.schemeNames.length;
    if (language === "hi") return `${g.label} बताएं — इससे ${count} और योजना${count === 1 ? "" : "ओं"} की जाँच हो सकेगी।`;
    if (language === "te") return `${g.label} తెలియజేయండి — దీనితో మరో ${count} పథకా${count === 1 ? "నికి" : "లకు"} తనిఖీ చేయవచ్చు.`;
    return `Add ${g.label} — this could confirm up to ${count} more scheme${count === 1 ? "" : "s"}.`;
  });
  const summary = language === "hi"
    ? "इन्हें भरकर अपने नतीजे और पुख्ता करें:"
    : language === "te"
    ? "వీటిని పూరించి మీ ఫలితాలను మరింత ఖచ్చితం చేయండి:"
    : "Fill these in to sharpen your results:";
  return { tips, summary };
}

function buildPrompt(gaps, language) {
  const lines = gaps.map((g, i) => `${i + 1}. Field: ${g.label} — currently unknown, affects: ${g.schemeNames.join(", ")}`).join("\n");
  return `A citizen using a government welfare-scheme checker has some schemes stuck at "needs more info" purely because these fields weren't filled in. ` +
    `Write 1 short encouraging sentence, then up to 3 short bullet-style nudges (no markdown bullets, just short sentences), each naming ONE field below and how many schemes it affects. ` +
    `Never suggest a field not listed. Never invent a scheme name beyond what's listed. Keep the whole reply under 60 words. ` +
    `Respond in ${{ hi: "Hindi", te: "Telugu" }[language] || "English"}.\n\nFields:\n${lines}`;
}

async function generateBoost({ matches, catalogById, language }) {
  const gaps = collectGaps(matches || [], catalogById || {});

  if (!gaps.length) return { ...templateBoost(gaps, language), source: "template", fields: [] };

  if (!hasProvider()) {
    return { ...templateBoost(gaps, language), source: "template", fields: gaps.map((g) => g.field) };
  }

  const prompt = buildPrompt(gaps, language);
  const cacheKey = "boost:" + prompt;
  const cached = aiCache.get(cacheKey);
  if (cached) return { summary: cached, tips: [], source: "ai-cached", fields: gaps.map((g) => g.field) };

  try {
    const text = await generateText({ system: null, messages: [{ role: "user", content: prompt }], maxTokens: 150 });
    aiCache.set(cacheKey, text, BOOSTER_CACHE_TTL_MS);
    return { summary: text, tips: [], source: "ai", fields: gaps.map((g) => g.field) };
  } catch (err) {
    console.error("AI profile-booster generation failed, using template fallback:", err.message);
    return { ...templateBoost(gaps, language), source: "template", fields: gaps.map((g) => g.field) };
  }
}

module.exports = { generateBoost, collectGaps };
