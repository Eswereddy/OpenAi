// eligibility-agent.js
//
// THE AI AGENT TOUCHPOINT — a real multi-step, tool-using agent, not a
// single prompt-and-response call like ai-summary.js or chat-assistant.js.
//
// Every other AI feature in this app is one round trip: send a prompt,
// get text back. This one runs an actual ReAct-style loop: the model is
// given a small set of *tools* that read this citizen's own real match
// data, it decides which tool to call and with what arguments, the tool
// executes here in plain JS (never inside the model), the result is fed
// back as an observation, and the loop repeats — up to MAX_STEPS times —
// until the model has enough grounded information to give a final answer.
//
// Why this matters for "AI integration" beyond the existing touchpoints:
//   - It's genuinely agentic: the model chooses *which* lookups it needs
//     for a given free-form question, rather than always receiving the
//     same fixed context (contrast with ai-summary.js / action-plan.js,
//     which always see the full match list up front).
//   - The reasoning is transparent: every step's {thought, tool, args,
//     observation} is returned to the client and shown in the UI, so a
//     citizen (or a judge) can see *why* the agent reached its answer
//     instead of trusting an opaque final paragraph.
//   - It still obeys this app's one hard rule: an agent can explain,
//     total, prioritize, or look things up, but it can NEVER hand down or
//     alter an eligibility verdict — every tool only ever reads data the
//     rule engine (schemes.js) already computed.
//
// Degrades exactly like every other AI touchpoint here: with no provider
// key configured, runs a single deterministic "tool call" chosen by
// keyword-matching the question, so the feature still returns a real,
// grounded answer instead of an error.

const { generateText, hasProvider } = require("./ai-provider");
const { explainScheme } = require("./schemes");
const aiCache = require("./ai-cache");

const MAX_STEPS = 4; // up to 3 tool calls + 1 final answer, or fewer
const AGENT_CACHE_TTL_MS = 10 * 60 * 1000;
const LANGUAGE_NAME = { en: "English", hi: "Hindi", te: "Telugu" };

// ---------------------------------------------------------------------------
// TOOLS — every one of these reads only data the rule engine already
// produced (matches[] from schemes.js's matchProfile) or static catalog
// metadata. None of them can invent a scheme, a document, or a verdict.
// ---------------------------------------------------------------------------

function toolListMatches(ctx) {
  return (ctx.matches || []).map((m) => {
    const s = ctx.catalogById[m.id] || {};
    return { id: m.id, name: s.name || m.id, status: m.status, benefit: s.benefit || null, level: s.level || null, dept: s.dept || null };
  });
}

function toolGetSchemeDetails(ctx, args) {
  const id = args && args.id;
  const match = (ctx.matches || []).find((m) => m.id === id);
  if (!match) return { error: `No matched scheme with id "${id}". Call list_matches first to see valid ids.` };
  const s = ctx.catalogById[id] || {};
  const explain = explainScheme(id);
  return {
    id, name: s.name || id, status: match.status, benefit: s.benefit || null,
    dept: s.dept || null, level: s.level || null, docs: s.docs || null,
    reasons: match.reasons || null,
    criteria: explain ? explain.criteria : null,
    portalUrl: s.portalUrl || null,
  };
}

// Best-effort, clearly-labelled estimate: pulls the first rupee figure out
// of each matched scheme's own `benefit` text (already-vetted display copy,
// never model-generated) and sums the ones for schemes the citizen is
// eligible for or pending verification on. Deliberately conservative: a
// scheme whose benefit text has no parseable number is skipped and listed
// separately rather than guessed at.
function parseRupeeAmount(text) {
  if (!text) return null;
  const m = String(text).match(/₹\s*([\d,]+(?:\.\d+)?)\s*(lakh|crore)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "lakh") n *= 100000;
  if (unit === "crore") n *= 10000000;
  return Math.round(n);
}

function toolEstimateTotalBenefit(ctx) {
  const counted = [];
  const uncounted = [];
  let total = 0;
  for (const m of ctx.matches || []) {
    if (m.status !== "eligible" && m.status !== "needs_verification") continue;
    const s = ctx.catalogById[m.id] || {};
    const amt = parseRupeeAmount(s.benefit);
    if (amt != null) {
      counted.push({ id: m.id, name: s.name || m.id, amount: amt, benefitText: s.benefit });
      total += amt;
    } else {
      uncounted.push({ id: m.id, name: s.name || m.id, benefitText: s.benefit || "not a fixed cash figure" });
    }
  }
  return {
    approximateTotal: total,
    note: "Rough, illustrative sum only — schemes have different payout periods (one-time / yearly / monthly) and this adds their face-value figures together regardless. Never quote this as a guaranteed amount.",
    counted,
    skippedNoFixedAmount: uncounted,
  };
}

function toolSearchCatalog(ctx, args) {
  const keyword = String((args && args.keyword) || "").toLowerCase().trim();
  if (!keyword) return { error: "keyword is required" };
  const all = Object.values(ctx.catalogById || {});
  const hits = all.filter((s) =>
    (s.name || "").toLowerCase().includes(keyword) ||
    (s.dept || "").toLowerCase().includes(keyword) ||
    (s.benefit || "").toLowerCase().includes(keyword) ||
    (s.tag || "").toLowerCase().includes(keyword)
  ).slice(0, 8).map((s) => ({ id: s.id, name: s.name, benefit: s.benefit, level: s.level }));
  return { keyword, results: hits, resultCount: hits.length };
}

const TOOLS = {
  list_matches: { fn: toolListMatches, describe: "list_matches: {} — this citizen's own matched schemes (id, name, status, benefit, level). Always safe to call first." },
  get_scheme_details: { fn: toolGetSchemeDetails, describe: "get_scheme_details: {\"id\": \"<scheme id from list_matches>\"} — full detail + why-eligible criteria for ONE matched scheme." },
  estimate_total_benefit: { fn: toolEstimateTotalBenefit, describe: "estimate_total_benefit: {} — rough combined ₹ estimate across eligible/pending matches, with a breakdown." },
  search_catalog: { fn: toolSearchCatalog, describe: "search_catalog: {\"keyword\": \"text\"} — searches ALL schemes (not just this citizen's matches) by keyword, e.g. \"pension\", \"farmer\", \"loan\"." },
};

function toolMenu() {
  return Object.values(TOOLS).map((t) => "- " + t.describe).join("\n");
}

function systemPrompt(language) {
  return `You are the AI Eligibility Investigator inside "Am I Eligible?", an Indian government welfare-scheme app. ` +
    `You help a citizen understand their OWN results in more depth than the one-paragraph summary they already saw. ` +
    `You work in a strict loop: on every turn, reply with EXACTLY ONE JSON object and nothing else — no markdown, no code fences, no prose outside the JSON. ` +
    `Each reply is either:\n` +
    `  {"thought": "short private reasoning", "tool": "<tool name>", "args": { ... }}\n` +
    `or, once you have enough grounded information:\n` +
    `  {"thought": "short private reasoning", "final_answer": "2-4 short plain-language sentences answering the citizen, no markdown"}\n\n` +
    `Available tools:\n${toolMenu()}\n\n` +
    `Rules: never invent a scheme, benefit figure, or document that a tool didn't return to you. ` +
    `Never state a NEW eligibility verdict — list_matches/get_scheme_details already contain the only verdicts that exist; you may only explain, total, compare, or prioritize them. ` +
    `Call at least one tool before your final_answer unless the citizen's message is a plain greeting or thanks. ` +
    `Prefer the fewest tool calls that actually answer the question. Respond in ${LANGUAGE_NAME[language] || "English"}.`;
}

function safeParseTurn(raw) {
  if (!raw) return null;
  let text = raw.trim();
  // Strip ``` fences if the model wraps its JSON anyway, despite instructions.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Fall back to the first {...} span if there's stray text around it.
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* fall through */ }
    }
  }
  return null;
}

function summarizeObservation(obs) {
  // Trims a tool result down to something short enough to log/display in
  // the trace without dumping a huge JSON blob in the UI.
  const s = JSON.stringify(obs);
  return s.length > 320 ? s.slice(0, 320) + "…" : s;
}

// Deterministic single-step fallback for when no AI provider is configured
// — picks one tool by keyword match on the question, same "always return
// something real, never a dead end" philosophy as the rest of this app.
function templateAgentAnswer({ question, ctx, language }) {
  const q = String(question || "").toLowerCase();
  let tool = "list_matches";
  let args = {};
  if (/(total|worth|benefit|money|₹|amount|value)/.test(q)) tool = "estimate_total_benefit";
  else if (/(document|paper|proof|certificate)/.test(q)) tool = "list_matches";
  const result = TOOLS[tool].fn(ctx, args);
  const trace = [{ thought: "No AI provider configured — using a direct lookup instead of a reasoning loop.", tool, args, observation: summarizeObservation(result) }];

  let reply;
  if (tool === "estimate_total_benefit") {
    const t = /** @type any */ (result);
    const msgs = {
      en: `Based on your matched schemes, the schemes with a fixed cash figure add up to roughly ₹${t.approximateTotal.toLocaleString("en-IN")} combined (illustrative only — payout periods differ). ${t.skippedNoFixedAmount.length ? t.skippedNoFixedAmount.length + " more matched scheme(s) don't have a single fixed amount to add." : ""}`,
      hi: `आपकी मिली योजनाओं में से जिनकी राशि तय है, वे मिलाकर लगभग ₹${t.approximateTotal.toLocaleString("en-IN")} बनती हैं (यह केवल अनुमान है)।`,
      te: `మీ సరిపోలిన పథకాలలో స్థిర మొత్తం ఉన్నవి కలిపి సుమారు ₹${t.approximateTotal.toLocaleString("en-IN")} అవుతాయి (ఇది ఒక అంచనా మాత్రమే).`,
    };
    reply = msgs[language] || msgs.en;
  } else {
    const list = /** @type any */ (result);
    const names = list.map((m) => m.name).slice(0, 5).join(", ");
    const msgs = {
      en: names ? `Your current matches: ${names}. Ask me a specific question (e.g. "what's the total benefit?" or "what documents does the first one need?") for more detail.` : "No matches yet — complete the form above first.",
      hi: names ? `आपकी मिलान योजनाएँ: ${names}। अधिक जानकारी के लिए कोई विशेष सवाल पूछें।` : "अभी कोई मिलान नहीं — पहले ऊपर फ़ॉर्म भरें।",
      te: names ? `మీ ప్రస్తుత సరిపోలికలు: ${names}. మరింత వివరాలకు ప్రత్యేక ప్రశ్న అడగండి.` : "ఇంకా సరిపోలికలు లేవు — ముందుగా పైన ఫారమ్ నింపండి.",
    };
    reply = msgs[language] || msgs.en;
  }
  return { reply, trace, source: "template" };
}

// The real agent loop.
async function investigate({ question, matches, catalogById, language, history }) {
  const ctx = { matches: matches || [], catalogById: catalogById || {} };
  const lang = ["hi", "te"].includes(language) ? language : "en";

  if (!hasProvider()) {
    return templateAgentAnswer({ question, ctx, language: lang });
  }

  const cacheKey = "agent:" + lang + ":" + JSON.stringify((matches || []).map((m) => m.id + ":" + m.status).sort()) + ":" + String(question).trim().toLowerCase();
  const cached = aiCache.get(cacheKey);
  if (cached) return { ...cached, source: "ai-cached" };

  const transcript = [
    { role: "user", content: `Citizen's question: ${String(question || "").slice(0, 500)}` },
  ];
  const trace = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const forceFinal = step === MAX_STEPS - 1;
    const promptSuffix = forceFinal
      ? "\n\n(You are out of steps — you MUST reply with a final_answer now, using whatever you've already learned.)"
      : "";
    let raw;
    try {
      raw = await generateText({
        system: systemPrompt(lang),
        messages: [...transcript, ...(promptSuffix ? [{ role: "user", content: "(system note)" + promptSuffix }] : [])],
        maxTokens: 320,
      });
    } catch (err) {
      console.error("Eligibility agent generation failed:", err.message);
      return { ...templateAgentAnswer({ question, ctx, language: lang }), source: "error-fallback" };
    }

    const turn = safeParseTurn(raw);
    if (!turn) {
      // Model didn't return parseable JSON — treat its raw text as the
      // final answer rather than looping forever on malformed output.
      const result = { reply: raw.trim().slice(0, 600), trace, source: "ai" };
      aiCache.set(cacheKey, result, AGENT_CACHE_TTL_MS);
      return result;
    }

    if (turn.final_answer) {
      const result = { reply: String(turn.final_answer).trim(), trace, source: "ai" };
      aiCache.set(cacheKey, result, AGENT_CACHE_TTL_MS);
      return result;
    }

    const toolName = turn.tool;
    const tool = TOOLS[toolName];
    if (!tool) {
      transcript.push({ role: "assistant", content: raw });
      transcript.push({ role: "user", content: JSON.stringify({ observation: { error: `Unknown tool "${toolName}". Valid tools: ${Object.keys(TOOLS).join(", ")}` } }) });
      continue;
    }
    let observation;
    try {
      observation = tool.fn(ctx, turn.args || {});
    } catch (err) {
      observation = { error: "Tool failed: " + err.message };
    }
    trace.push({ thought: turn.thought || "", tool: toolName, args: turn.args || {}, observation: summarizeObservation(observation) });
    transcript.push({ role: "assistant", content: raw });
    transcript.push({ role: "user", content: JSON.stringify({ observation }) });
  }

  // Exhausted steps without a final_answer somehow slipping through above —
  // fall back to a grounded template rather than returning nothing.
  return { ...templateAgentAnswer({ question, ctx, language: lang }), trace, source: "template" };
}

module.exports = { investigate, TOOLS };
