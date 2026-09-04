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
// SECURITY: API keys come ONLY from environment variables (OPENAI_API_KEY /
// ANTHROPIC_API_KEY), set outside the codebase — in a local .env (gitignored)
// or in your host's dashboard (Render → your service → Environment). Never
// hardcode a key into this file or any other: this repo is public, and a key
// committed to git history stays exposed even after you delete the line.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

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

async function callOpenAI(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 300,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI API responded ${res.status}`);
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) throw new Error("Empty response from model");
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Anthropic API responded ${res.status}`);
    const data = await res.json();
    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();
    if (!text) throw new Error("Empty response from model");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSummary({ profile, matches, catalogById, language }) {
  const matchSummaries = summarizeMatchesForPrompt(matches || [], catalogById || {});

  // Prefer whichever provider has a key configured. OpenAI first since
  // that's what's currently set up for this deployment; Anthropic works
  // identically if that key is used instead.
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return { summary: templateSummary(matchSummaries, language), source: "template" };
  }

  const prompt = buildPrompt(profile || {}, matchSummaries, language);
  try {
    const text = OPENAI_API_KEY ? await callOpenAI(prompt) : await callAnthropic(prompt);
    return { summary: text, source: "ai" };
  } catch (err) {
    console.error("AI summary generation failed, using template fallback:", err.message);
    return { summary: templateSummary(matchSummaries, language), source: "template" };
  }
}

module.exports = { generateSummary, summarizeMatchesForPrompt, templateSummary };
