// ai-provider.js
// One shared, thin client for every AI touchpoint in this app (summary,
// chat, action plan, document checklist). Three providers are supported —
// OpenAI, Anthropic, and Groq — and whichever has a key configured is used.
// Every caller still owns its own deterministic fallback; this module only
// ever returns generated text or throws, it never decides what happens when
// no provider is configured.
//
// WHY GROQ IS HERE: this app is built for a hackathon audience that may not
// have a paid OpenAI/Anthropic key on hand. Groq (console.groq.com) issues
// a free API key with no card required and a generous free-tier rate limit,
// running fast open models (Llama 3.3, etc.) — enough to power every AI
// feature in this app end-to-end at zero cost. See README.md for the
// 2-minute setup.
//
// SECURITY: every key below comes ONLY from environment variables, set
// outside the codebase — a local .env (gitignored) or your host's dashboard
// (Render → your service → Environment). Never hardcode a key here or
// anywhere else: this repo is public, and a key committed to git history
// stays exposed even after the line is deleted.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Groq's chat completions endpoint is OpenAI-compatible, so it reuses the
// same request/response shape as callOpenAI below — just a different base
// URL, key, model, and token-limit field name (Groq uses the standard
// `max_tokens`, not OpenAI's newer `max_completion_tokens`).
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function hasProvider() {
  return !!(OPENAI_API_KEY || ANTHROPIC_API_KEY || GROQ_API_KEY);
}

// Which provider will actually be used, for surfacing in /api/stats and
// logs — useful during judging to show "yes, this is really calling an AI",
// and to confirm a free Groq key is wired up correctly without printing it.
function activeProviderName() {
  if (OPENAI_API_KEY) return "openai";
  if (ANTHROPIC_API_KEY) return "anthropic";
  if (GROQ_API_KEY) return "groq";
  return null;
}

async function callOpenAI(system, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        max_completion_tokens: maxTokens,
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

async function callAnthropic(system, messages, maxTokens) {
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
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
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

async function callGroq(system, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Groq API responded ${res.status}`);
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) throw new Error("Empty response from model");
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

// Single entry point every feature calls. `system` may be null (some
// prompts, like ai-summary's, are a single self-contained user message).
async function generateText({ system, messages, maxTokens }) {
  if (OPENAI_API_KEY) return callOpenAI(system, messages, maxTokens);
  if (ANTHROPIC_API_KEY) return callAnthropic(system, messages, maxTokens);
  if (GROQ_API_KEY) return callGroq(system, messages, maxTokens);
  throw new Error("No AI provider configured");
}

module.exports = { generateText, hasProvider, activeProviderName };
