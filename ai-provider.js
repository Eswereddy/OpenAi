// ai-provider.js
// One shared, thin client for every AI touchpoint in this app (summary,
// chat, action plan, document checklist). Three providers are supported —
// Groq, OpenAI, and Anthropic — and every caller only ever talks to
// generateText() below, never to a provider directly.
//
// PROVIDER ORDER: Groq is tried FIRST, with OpenAI and then Anthropic as
// automatic backups. This is a genuine runtime failover, not just "use
// whichever key happens to be set": if you configure more than one key,
// generateText() tries Groq, and only moves on to OpenAI/Anthropic if Groq
// is unconfigured, errors out, times out, or comes back empty. That means
// a rate limit or an outage on one provider doesn't take the AI features
// down — it just quietly falls through to the next one and keeps serving
// real generated text.
//
// WHY GROQ IS FIRST: this app is built for a hackathon/low-budget audience
// that may not have a paid OpenAI/Anthropic key on hand. Groq
// (console.groq.com) issues a free API key with no card required and a
// generous free-tier rate limit, running fast open models (openai/gpt-oss
// -120b by default, etc.) — enough to power every AI feature in this app
// end-to-end at zero cost and with very low latency. See README.md for the
// 2-minute setup. OpenAI and Anthropic remain fully supported as backups —
// set either (or both) alongside Groq for extra redundancy, or on their own
// if you'd rather not use Groq at all.
//
// SECURITY: every key below comes ONLY from environment variables, set
// outside the codebase — a local .env (gitignored) or your host's dashboard
// (Render → your service → Environment). Never hardcode a key here or
// anywhere else: this repo is public, and a key committed to git history
// stays exposed even after the line is deleted.

const REQUEST_TIMEOUT_MS = 8000;
// One retry on the SAME provider for transient errors (timeouts, 429 rate
// limits, 5xx) before moving on to the next configured provider. Cheap
// insurance against a single flaky request without adding real latency to
// the common case (first attempt succeeding).
const RETRIES_PER_PROVIDER = 1;
const RETRY_DELAY_MS = 350;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Groq decommissioned llama-3.3-70b-versatile on 2026-08-16 (announced
// 2026-06-17); using it now makes every Groq call fail with a
// model_decommissioned error. openai/gpt-oss-120b is Groq's own recommended
// 1:1 replacement — same "general use" tier, still fast, still free-tier
// eligible. Override via GROQ_MODEL if Groq ships something better later.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-5-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq and OpenAI both speak the same OpenAI-compatible chat-completions
// shape, so one function serves both — just a different URL, key, model,
// and token-limit field name (Groq accepts the classic `max_tokens`; newer
// OpenAI models want `max_completion_tokens`).
async function callOpenAICompatible({ url, apiKey, model, system, messages, maxTokens, tokenField }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: system ? [{ role: "system", content: system }, ...messages] : messages,
        [tokenField]: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) throw new Error("empty response from model");
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroq(system, messages, maxTokens) {
  return callOpenAICompatible({
    url: GROQ_URL, apiKey: GROQ_API_KEY, model: GROQ_MODEL,
    system, messages, maxTokens, tokenField: "max_tokens",
  });
}

async function callOpenAI(system, messages, maxTokens) {
  return callOpenAICompatible({
    url: OPENAI_URL, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL,
    system, messages, maxTokens, tokenField: "max_completion_tokens",
  });
}

async function callAnthropic(system, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    if (!res.ok) {
      const err = new Error(`responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();
    if (!text) throw new Error("empty response from model");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Provider order lives in exactly one place. Groq first (fast + free),
// OpenAI and Anthropic as backups — each entry is only included if its key
// is actually set, so this list also doubles as "what's configured".
function configuredProviders() {
  const all = [
    { name: "groq", key: GROQ_API_KEY, model: GROQ_MODEL, call: callGroq },
    { name: "openai", key: OPENAI_API_KEY, model: OPENAI_MODEL, call: callOpenAI },
    { name: "anthropic", key: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL, call: callAnthropic },
  ];
  return all.filter((p) => !!p.key);
}

function hasProvider() {
  return configuredProviders().length > 0;
}

// Which provider would be tried first — for surfacing in /api/stats and
// logs, useful to confirm a free Groq key is wired up correctly without
// printing it.
function activeProviderName() {
  const list = configuredProviders();
  return list.length ? list[0].name : null;
}

// Full ordered list of configured provider names, e.g. ["groq", "openai"].
// Lets /api/stats show the whole failover chain, not just the primary.
function providerChain() {
  return configuredProviders().map((p) => p.name);
}

// Tracks which provider actually served the most recent successful call,
// and how many providers/attempts it took — visible via lastProviderUsed()
// so /api/stats can show real evidence of the failover working, not just
// which key is configured.
let lastOutcome = { provider: null, attempts: 0, at: null };

function lastProviderUsed() {
  return { ...lastOutcome };
}

function isRetryable(err) {
  if (err && err.name === "AbortError") return true; // timeout
  if (err && typeof err.status === "number") return err.status === 429 || err.status >= 500;
  return false;
}

// Single entry point every feature calls. `system` may be null (some
// prompts, like ai-summary's, are a single self-contained user message).
// Tries each configured provider in order (Groq → OpenAI → Anthropic),
// retrying transient errors once on the same provider before moving to the
// next. Throws only if every configured provider fails, or none is
// configured at all — callers already handle that with their own
// deterministic template fallback.
async function generateText({ system, messages, maxTokens }) {
  const providers = configuredProviders();
  if (!providers.length) throw new Error("No AI provider configured");

  const errors = [];
  let attempts = 0;

  for (const provider of providers) {
    for (let attempt = 0; attempt <= RETRIES_PER_PROVIDER; attempt++) {
      attempts++;
      try {
        const text = await provider.call(system, messages, maxTokens);
        lastOutcome = { provider: provider.name, attempts, at: new Date().toISOString() };
        return text;
      } catch (err) {
        const retryableHere = attempt < RETRIES_PER_PROVIDER && isRetryable(err);
        console.error(
          `AI provider "${provider.name}" attempt ${attempt + 1} failed:`,
          err && err.message,
          retryableHere ? "(retrying)" : "(giving up on this provider)"
        );
        if (retryableHere) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        errors.push(`${provider.name}: ${err && err.message}`);
        break;
      }
    }
  }

  lastOutcome = { provider: null, attempts, at: new Date().toISOString() };
  throw new Error(`All configured AI providers failed — ${errors.join("; ")}`);
}

module.exports = {
  generateText,
  hasProvider,
  activeProviderName,
  providerChain,
  lastProviderUsed,
};
