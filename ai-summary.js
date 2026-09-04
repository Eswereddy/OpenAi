// ai-summary.js
// Turns the rule engine's already-computed matches into one short,
// personalized, plain-language paragraph — "why you likely qualify, and
// what to do first" — using an LLM.
//
// Important boundary: this file never decides eligibility. schemes.js and
// rule-engine.js remain the single source of truth for every status and
// reason; this only explains, in plain words, a verdict that was already
// computed before it's ever called. If no provider is configured or the
// call fails, callers get a clear, honest template built from the same
// match data instead of a hard failure — same "still works with poor
// connectivity" principle as the rest of this app, applied to the AI layer.
//
// Provider selection (OpenAI / Anthropic / Groq) and API keys live in
// ai-provider.js — see that file (and README.md) for how to get a free
// Groq key.

const { generateText, hasProvider } = require("./ai-provider");
const aiCache = require("./ai-cache");
const SUMMARY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — long enough to cover repeat clicks during a demo/judging pass, short enough that a scheme-data edit shows up the same session

// Trim a match list down to just what the prompt needs. Keeps the request
// small and, more importantly, keeps the model from ever inventing a scheme
// name, benefit figure, or reason that didn't come out of the rules engine.
function summarizeMatchesForPrompt(matches, catalogById) {
  return matches
    .filter((m) => m.status === "eligible" || m.status === "needs_verification")
    .slice(0, 8)
    .map((m) => {
      const scheme = (catalogById && catalogById[m.id]) || {};
      return {
        name: scheme.name || m.id,
        benefit: scheme.benefit || null,
        status: m.status,
        reasons: Array.isArray(m.reasons && m.reasons.met) ? m.reasons.met.slice(0, 3) : [],
      };
    });
}

function buildPrompt(profile, matchSummaries, language) {
  const profileLine = [
    profile.occupation ? `occupation: ${profile.occupation}` : null,
    profile.state ? `state: ${profile.state}` : null,
    profile.age != null ? `age: ${profile.age}` : null,
  ].filter(Boolean).join(", ");

  const schemeLines = matchSummaries.map((s, i) =>
    `${i + 1}. ${s.name} (${s.status === "eligible" ? "likely eligible" : "needs verification"})` +
    (s.benefit ? ` — benefit: ${s.benefit}` : "") +
    (s.reasons.length ? ` — matched on: ${s.reasons.join("; ")}` : "")
  ).join("\n");

  return `A citizen using a government welfare-scheme checker just received these results. ` +
    `Write a short, warm, plain-language summary (3-5 sentences, no headings, no markdown) explaining ` +
    `what they likely qualify for and what to do first. Be encouraging but never overstate certainty — ` +
    `use "likely" / "worth checking" language for anything marked "needs verification". ` +
    `Do not invent any scheme, benefit amount, or eligibility reason beyond what's listed below. ` +
    `Respond in ${language === "hi" ? "Hindi" : "English"}.\n\n` +
    `Citizen profile: ${profileLine || "not provided"}\n\n` +
    `Matched schemes:\n${schemeLines}`;
}

// Deterministic fallback used whenever no provider is configured or the API
// call fails — never blocks the citizen from seeing a useful summary.
function templateSummary(matchSummaries, language) {
  if (!matchSummaries.length) {
    return language === "hi"
      ? "इस प्रोफ़ाइल के लिए फ़िलहाल कोई योजना नहीं मिली। ऊपर अपने उत्तर बदलकर दोबारा जाँच करें।"
      : "No schemes matched this profile from today's answers. Try adjusting a detail above and checking again.";
  }
  const top = matchSummaries[0];
  const count = matchSummaries.length;
  if (language === "hi") {
    return `आपके उत्तरों के आधार पर आप ${count} योजना${count === 1 ? "" : "ओं"} के लिए उपयुक्त हो सकते हैं। ` +
      `सबसे पहले "${top.name}" देखें${top.benefit ? ` (लाभ: ${top.benefit})` : ""} — ` +
      `नीचे दिए गए कार्ड में पूरी जानकारी और आवेदन का तरीका है।`;
  }
  return `Based on your answers, you may qualify for ${count} scheme${count === 1 ? "" : "s"}. ` +
    `Start with "${top.name}"${top.benefit ? ` (benefit: ${top.benefit})` : ""} — ` +
    `the card below has the full details and how to apply.`;
}

async function generateSummary({ profile, matches, catalogById, language }) {
  const matchSummaries = summarizeMatchesForPrompt(matches || [], catalogById || {});

  if (!hasProvider()) {
    return { summary: templateSummary(matchSummaries, language), source: "template" };
  }

  const prompt = buildPrompt(profile || {}, matchSummaries, language);

  // Cache key: same profile line + same matched schemes/reasons + same
  // language → same prompt → no reason to pay for and wait on a fresh
  // call. Keying on the prompt itself (not raw profile) means the cache
  // stays correct even if unrelated profile fields change without
  // affecting what actually got sent to the model.
  const cacheKey = "summary:" + prompt;
  const cached = aiCache.get(cacheKey);
  if (cached) return { summary: cached, source: "ai-cached" };

  try {
    const text = await generateText({ system: null, messages: [{ role: "user", content: prompt }], maxTokens: 300 });
    aiCache.set(cacheKey, text, SUMMARY_CACHE_TTL_MS);
    return { summary: text, source: "ai" };
  } catch (err) {
    console.error("AI summary generation failed, using template fallback:", err.message);
    return { summary: templateSummary(matchSummaries, language), source: "template" };
  }
}

module.exports = { generateSummary, summarizeMatchesForPrompt, templateSummary };
