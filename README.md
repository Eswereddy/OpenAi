# Am I Eligible? — Welfare Scheme Discovery

A prototype for the OpenAI Codex India hackathon. India runs 1,000+ welfare
schemes; most eligible citizens never find out they qualify. This app takes
a short, occupation-aware questionnaire (a handful of core questions, plus a
few extra ones only for farmers, students, or construction workers) and
tells you which of 17 real, well-known schemes you likely qualify for — in
plain language, with an explanation for every match.

## Architecture

```
public/index.html   Frontend — form, results, WhatsApp share. Calls the API
                     first; falls back to identical on-device logic if the
                     network is slow or unavailable (real concern on the
                     connections this is built for).
schemes.js           The rules engine — scheme metadata + eligibility logic.
validate.js           Input sanitization at the API boundary — drops
                      out-of-range/malformed fields (negative age, a
                      50,000-character string) back to "not provided"
                      rather than letting them reach the rules engine.
db/index.js          SQLite setup — seeds scheme metadata into a real table,
                      and logs anonymised match summaries (no names, no ID
                      numbers, no phone numbers — ever).
rule-engine.js        Small generic interpreter that runs each scheme's
                      declarative population rules ({field, operator, value})
                      against a citizen's profile — adding scheme #18 means
                      adding data, not a new `if` branch.
ai-provider.js         Shared client for the three supported AI providers
                      (OpenAI / Anthropic / Groq — Groq is free, see below).
                      Every other AI file calls into this one instead of
                      talking to a provider directly.
ai-summary.js          The AI layer. Turns the rule engine's already-decided
                      matches into one short, personalized, plain-language
                      paragraph via an LLM. Never decides eligibility itself
                      — it explains a verdict schemes.js already computed —
                      and degrades to a deterministic template if no API key
                      is set or the call fails, so the feature can never
                      block a citizen from seeing their results.
chat-assistant.js      The AI chatbot. Answers open-ended questions
                      ("what documents does PM-KISAN need?") grounded in
                      this app's own scheme catalog. Never hands down a
                      final eligibility verdict — that stays the rule
                      engine's job.
action-plan.js         The AI agent layer. Reasons across every match —
                      including "not eligible" and "needs verification"
                      ones — and turns the rule engine's own flagged
                      follow-ups into a short, prioritized action plan.
                      Degrades to a plain numbered list of those same
                      follow-ups if no AI key is set.
document-checklist.js  Consolidates and de-duplicates every matched
                      scheme's required documents into one checklist, with
                      a short "how to get it" tip per document (a built-in
                      library for common documents; AI only fills gaps for
                      uncommon ones).
server.js            Express API: GET /api/schemes, POST /api/match,
                      POST /api/summary, POST /api/chat, POST /api/action-plan,
                      POST /api/checklist, GET /api/stats,
                      GET /api/schemes/:id/why, POST /api/schemes/:id/verify.
test/smoke.js         Zero-dependency smoke test hitting every endpoint
                      against a real running server. `npm test`.
```

## AI integration

Four AI touchpoints, all grounded in this app's own scheme data (never
inventing schemes, benefits, or documents) and all degrading gracefully
with no external call if unconfigured:

**1. AI summary** — after a match, `POST /api/summary` turns the
already-computed results into one short, personalized paragraph. See
`ai-summary.js`.

**2. AI chatbot** — a floating "Ask about schemes" widget (bottom-right on
every page, with voice input) answers open-ended questions — documents
needed, who a scheme is for, how to apply — via `POST /api/chat`. It's
explicitly instructed never to hand down a final eligibility verdict
itself; that stays the rule engine's job. See `chat-assistant.js`.

**3. AI action plan (agent)** — a "🧭 What should I do next?" button on the
results page calls `POST /api/action-plan`, which reasons across *every*
match (not just the successful ones) and returns a short, prioritized list
of concrete next steps — confirm this, get that document, check that
list — built only from what the rule engine already flagged as pending or
missing. See `action-plan.js`.

**4. Document checklist** — a "📋 Build my document checklist" button calls
`POST /api/checklist`, which consolidates every matched scheme's document
list into one de-duplicated checklist with a short "where to get it" tip
per document, so a citizen matching 5+ schemes doesn't have to cross-check
each scheme card by hand. See `document-checklist.js`.

Set one of these environment variables to enable all four AI features at
once (see `ai-provider.js` for priority order if more than one is set):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or export OPENAI_API_KEY=sk-...
# or export GROQ_API_KEY=gsk_...   ← free, no card required, see below
npm start
```

### Get a free API key in under 2 minutes

You don't need a paid OpenAI or Anthropic key to run this project.
[Groq](https://console.groq.com/keys) issues a free API key — no credit
card, generous free-tier rate limits, running fast open models (Llama
3.3 by default). To use it:

1. Go to https://console.groq.com/keys and sign in (Google/GitHub works).
2. Click "Create API Key" and copy it.
3. Copy `env.example.txt` to `.env` and paste it in as `GROQ_API_KEY`.
4. `npm start` — all four AI features above now work end-to-end for free.

`OPENAI_SUMMARY_MODEL` / `ANTHROPIC_SUMMARY_MODEL` / `GROQ_MODEL`
optionally override each provider's model. With no key set at all, every
AI endpoint still returns a real, useful result — just a deterministic
template/consolidation built from the same match data instead of a
generated one — so the app runs identically with or without AI configured.

Why this split: the database holds *displayable* scheme content (name,
benefit, documents) so it can be updated without a code deploy. The
eligibility *rules* live in code, which is how most real eligibility engines
are actually built — rules need version control and testing, not just rows
in a table.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy

This repo deploys as-is to Render, Railway, or any Node host — `render.yaml`
and `Procfile` are already in the repo, so most hosts pick up the build/start
commands automatically:
- Build command: `npm install`
- Start command: `npm start`
- Health check: `GET /healthz`
- No environment variables required for the demo (`DB_PATH` and `PORT` are
  optional overrides; both have sane defaults).

## What's real vs. mocked

**Real:** the full citizen journey, the rule-based matching engine, the
database, the live/offline fallback, the WhatsApp share link, and all four
AI layers (a real call to OpenAI/Anthropic/Groq when a key is set —
summary, chatbot, action plan, and document checklist).

**Mocked:** the schemes reflect publicly known, general eligibility
criteria — not a live government feed. "Start application" does not submit
to any real system. No Aadhaar, OTP, or payment data is collected anywhere.

## How this could scale

- Swap SQLite for Postgres; no query changes needed.
- Pull scheme content from myScheme / state portals via API instead of a
  static seed.
- Add regional languages and an SMS/IVR fallback for feature-phone users.
- Use the `submissions` table (already anonymised) to see which schemes are
  under-discovered by state or occupation, and prioritise outreach there.

## Production architecture

The hackathon build is a straight line — Frontend → Express → SQLite → rule
engine — which is right for a 48-hour prototype but not how this would run
at national scale. Two things would change: where scheme rules come from,
and what happens when a user has no signal.

**Getting rules from government sources to the user, safely:**

```
Official Government Sources
         ↓
  Scheme Data Pipeline
         ↓
 Validation / Review
         ↓
Versioned Scheme Rules
         ↓
User → Questionnaire → Eligibility Engine
         ↓
   Explainable Results
      ↓           ↓
 Documents    Official Portal
```

Today the seed data *is* the versioned rules — hand-curated once, from public
sources. At scale that step becomes a pipeline: scheme data is pulled from
myScheme and state portals, run through a validation/review stage (so a
scraped change to, say, an income threshold can't silently reach citizens
before a human confirms it), and only then published as a new *version* of
the scheme rules the eligibility engine reads from. Versioning matters
because eligibility rules change with budgets and policy — citizens who
checked in March and citizens who check in July need to be able to see they
got different (correct) answers, not a bug. The eligibility engine's output
stays what it is today: an explainable match, plus a path to the actual
documents needed and the official portal to apply — this app is a discovery
layer in front of government systems, never a replacement for them.

**Getting an answer to a user with no signal:**

```
User
 ↓
Local rule cache
 ↓
Offline eligibility engine
```

This is the fallback that already exists in `public/index.html` — the
on-device logic that runs when the API call is slow or fails — described as
its own path rather than an afterthought bolted onto the online one. The
rules engine (`schemes.js`) is small and dependency-free specifically so it
can ship to the client as a cached bundle and run identically offline; the
"local rule cache" is just that bundle, refreshed opportunistically whenever
the device does have connectivity, so a user on a poor connection is always
evaluated against a recent version of the rules rather than being blocked
until a request succeeds.
