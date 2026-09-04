// chat-assistant.js
// A small FAQ chatbot, grounded in this app's own scheme catalog. Purely
// additive: this file, its endpoint in server.js, and its widget in
// public/index.html are new — nothing in the existing match/summary flow
// is touched. Same "explains, never decides" boundary as ai-summary.js:
// eligibility verdicts still come only from schemes.js / rule-engine.js.
//
// SECURITY: reuses the same OPENAI_API_KEY / ANTHROPIC_API_KEY env vars as
// ai-summary.js. No key is ever hardcoded here.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const MAX_HISTORY_TURNS = 6; // trims a runaway client-side history to something sane
const MAX_MESSAGE_LEN = 500;

// Builds a compact, plain-text version of the scheme catalog so the model
// answers from the app's own real data instead of general knowledge — it
// should never invent a scheme, benefit figure, or document requirement
// that isn't in this list.
function buildCatalogContext(catalogById) {
  const schemes = Object.values(catalogById || {});
  if (!schemes.length) return "(No scheme catalog available.)";
  return schemes.slice(0, 20).map((s) => {
    const docs = Array.isArray(s.documents) ? s.documents.join(", ") : (s.documents || "");
    return `- ${s.name}${s.benefit ? ` — benefit: ${s.benefit}` : ""}${s.dept ? ` — dept: ${s.dept}` : ""}${docs ? ` — docs: ${docs}` : ""}`;
  }).join("\n");
}

function systemPrompt(catalogById, language) {
  return `You are the help assistant embedded in "Am I Eligible?", an Indian government welfare-scheme discovery tool. ` +
    `Answer only questions about the schemes below, how the eligibility checker works, what documents are needed, or how to apply. ` +
    `Keep answers to 2-4 short sentences, plain language, no markdown. ` +
    `Never state a final eligibility verdict yourself — that always comes from the checker's own questionnaire, not from you; ` +
    `if asked "am I eligible", tell them to use the form above and explain what it checks. ` +
    `Never invent a scheme, benefit amount, or document requirement that isn't in the list below. ` +
    `If a question is unrelated to this app or these schemes, politely say so and redirect to what you can help with. ` +
    `Respond in ${language === "hi" ? "Hindi" : "English"}.\n\n` +
    `Known schemes:\n${buildCatalogContext(catalogById)}`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }));
}

async function callOpenAI(system, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "system", content: system }, ...messages],
        max_completion_tokens: 220,
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

async function callAnthropic(system, messages) {
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
        max_tokens: 220,
        system,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Anthropic API responded ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!text) throw new Error("Empty response from model");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function answerQuestion({ message, history, catalogById, language }) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return {
      reply: language === "hi"
        ? "यह सहायक फ़िलहाल उपलब्ध नहीं है। कृपया ऊपर दिए गए फ़ॉर्म का उपयोग करें या \"क्यों?\" लिंक देखें।"
        : "This assistant isn't available right now. Please use the form above, or check each scheme's \"Why?\" link for details.",
      source: "unavailable",
    };
  }
  const trimmedMessage = String(message || "").slice(0, MAX_MESSAGE_LEN);
  const messages = [...sanitizeHistory(history), { role: "user", content: trimmedMessage }];
  const system = systemPrompt(catalogById, language);
  try {
    const reply = OPENAI_API_KEY
      ? await callOpenAI(system, messages)
      : await callAnthropic(system, messages);
    return { reply, source: "ai" };
  } catch (err) {
    console.error("Chat assistant failed:", err.message);
    return {
      reply: language === "hi"
        ? "माफ़ करें, अभी जवाब नहीं दे पा रहे। कृपया दोबारा कोशिश करें।"
        : "Sorry, I couldn't get an answer just now. Please try again in a moment.",
      source: "error",
    };
  }
}

module.exports = { answerQuestion };
