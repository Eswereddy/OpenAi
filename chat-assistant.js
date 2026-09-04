// chat-assistant.js
// A small FAQ chatbot, grounded in this app's own scheme catalog. Purely
// additive: this file, its endpoint in server.js, and its widget in
// public/index.html are new — nothing in the existing match/summary flow
// is touched. Same "explains, never decides" boundary as ai-summary.js:
// eligibility verdicts still come only from schemes.js / rule-engine.js.
//
// Provider selection (OpenAI / Anthropic / Groq) and API keys live in
// ai-provider.js — see that file (and README.md) for how to get a free
// Groq key.

const { generateText, hasProvider } = require("./ai-provider");
const aiCache = require("./ai-cache");
const CHAT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — the quick-question chips send the exact same text repeatedly across visitors, so this is where caching pays off most

const MAX_HISTORY_TURNS = 6; // trims a runaway client-side history to something sane
const MAX_MESSAGE_LEN = 500;

// Builds a compact, plain-text version of the scheme catalog so the model
// answers from the app's own real data instead of general knowledge — it
// should never invent a scheme, benefit figure, or document requirement
// that isn't in this list. `docs` is the actual field name schemes carry
// (see schemes.js / db/index.js) — using the right field here is what
// keeps the chatbot's document answers grounded instead of empty.
function buildCatalogContext(catalogById) {
  const schemes = Object.values(catalogById || {});
  if (!schemes.length) return "(No scheme catalog available.)";
  return schemes.slice(0, 20).map((s) => {
    const docs = Array.isArray(s.docs) ? s.docs.join(", ") : (s.docs || "");
    return `- ${s.name}${s.benefit ? ` — benefit: ${s.benefit}` : ""}${s.dept ? ` — dept: ${s.dept}` : ""}${docs ? ` — docs: ${docs}` : ""}`;
  }).join("\n");
}

function systemPrompt(catalogById, language, matchedSchemeNames) {
  const personalLine = (Array.isArray(matchedSchemeNames) && matchedSchemeNames.length)
    ? `\n\nThis citizen already ran the checker above and was matched to: ${matchedSchemeNames.join(", ")}. ` +
      `If they ask something like "which should I do first" or "what's next", prioritize answering about ` +
      `these specific matched schemes rather than the catalog in general — but you can still discuss any ` +
      `other scheme below if they ask about it directly.`
    : "";
  return `You are the help assistant embedded in "Am I Eligible?", an Indian government welfare-scheme discovery tool. ` +
    `Answer only questions about the schemes below, how the eligibility checker works, what documents are needed, or how to apply. ` +
    `Keep answers to 2-4 short sentences, plain language, no markdown. ` +
    `Never state a final eligibility verdict yourself — that always comes from the checker's own questionnaire, not from you; ` +
    `if asked "am I eligible", tell them to use the form above and explain what it checks. ` +
    `Never invent a scheme, benefit amount, or document requirement that isn't in the list below. ` +
    `If a question is unrelated to this app or these schemes, politely say so and redirect to what you can help with. ` +
    `Respond in ${language === "hi" ? "Hindi" : "English"}.` +
    personalLine +
    `\n\nKnown schemes:\n${buildCatalogContext(catalogById)}`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_TURNS * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LEN) }));
}

async function answerQuestion({ message, history, catalogById, language, matchedSchemeNames }) {
  if (!hasProvider()) {
    return {
      reply: language === "hi"
        ? "यह सहायक फ़िलहाल उपलब्ध नहीं है। कृपया ऊपर दिए गए फ़ॉर्म का उपयोग करें या \"क्यों?\" लिंक देखें।"
        : "This assistant isn't available right now. Please use the form above, or check each scheme's \"Why?\" link for details.",
      source: "unavailable",
    };
  }
  const trimmedMessage = String(message || "").slice(0, MAX_MESSAGE_LEN);
  const messages = [...sanitizeHistory(history), { role: "user", content: trimmedMessage }];
  // Defensive: only pass through short, plain strings — this list goes
  // straight into the system prompt, so it's sanitized the same way any
  // other untrusted client input would be before reaching a model call.
  const safeMatchedNames = Array.isArray(matchedSchemeNames)
    ? matchedSchemeNames.filter((n) => typeof n === "string" && n.trim()).slice(0, 10).map((n) => n.slice(0, 80))
    : [];
  const system = systemPrompt(catalogById, language, safeMatchedNames);

  // Only cache fresh, first-turn questions — once there's real history the
  // conversation is effectively unique, and caching a mid-conversation
  // reply under the wrong prior context would risk a reply that doesn't
  // fit. This is exactly the case the quick-question chips hit (first
  // message, no history yet), which is also where repeat traffic is
  // heaviest — nearly every visitor taps the same "What documents do I
  // need?" chip.
  const isFreshQuestion = !Array.isArray(history) || history.length === 0;
  const cacheKey = isFreshQuestion
    ? "chat:" + language + ":" + safeMatchedNames.slice().sort().join(",") + ":" + trimmedMessage.trim().toLowerCase()
    : null;
  if (cacheKey) {
    const cached = aiCache.get(cacheKey);
    if (cached) return { reply: cached, source: "ai-cached" };
  }

  try {
    const reply = await generateText({ system, messages, maxTokens: 220 });
    if (cacheKey) aiCache.set(cacheKey, reply, CHAT_CACHE_TTL_MS);
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
