# Am I Eligible? — Welfare Scheme Discovery

A prototype for the OpenAI Codex India hackathon. India runs 1,000+ welfare
schemes; most eligible citizens never find out they qualify. This app takes
a short, occupation-aware questionnaire (a handful of core questions, plus a
few extra ones only for farmers, students, or construction workers) and
tells you which of **21** real, well-known schemes you likely qualify for —
in plain language, with an explanation for every match, in **English,
Hindi, or Telugu** (see "Language support" below).

**Two things judges look for, addressed directly:** AI integration is five
grounded touchpoints, not one bolted-on chatbot — see "AI integration"
below, especially the newest one, **fill-by-talking form autofill**. And the
user's actual pain point (typing through a long, unfamiliar government form
on a slow phone) is attacked at the point where people actually drop off:
before and during the form, not just after — a live per-scheme *and*
rupee-value estimate as you type ("6 schemes look possible so far — up to
₹1.8 lakh in benefits"), a way to skip typing altogether by just describing
yourself in one sentence, a "what if?" slider to feel how sensitive your
result is to income, and a read-aloud option on every AI explanation for
anyone who'd rather listen than read. See "How the AI touchpoints connect
into one loop" below for how these chain together into a single journey.

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
                      (Groq / OpenAI / Anthropic — Groq is free and tried
                      first, see below). If more than one key is set,
                      failed/timed-out/rate-limited calls automatically
                      retry on the next configured provider instead of
                      falling straight to the template fallback. Every
                      other AI file calls into this one instead of
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
profile-parser.js      The AI form-fill layer. Turns one free-form sentence
                      ("I'm a 34 year old farmer in Andhra Pradesh...") into
                      the same structured fields the eligibility form
                      already collects — never a new field, never an
                      eligibility verdict. Degrades to a dependency-free
                      regex/keyword parser (with basic Hindi and Telugu
                      coverage) if no AI key is set or the call fails.
document-checklist.js  Consolidates and de-duplicates every matched
                      scheme's required documents into one checklist, with
                      a short "how to get it" tip per document (a built-in
                      library for common documents; AI only fills gaps for
                      uncommon ones).
server.js            Express API: GET /api/schemes, POST /api/match,
                      POST /api/summary, POST /api/chat, POST /api/action-plan,
                      POST /api/checklist, POST /api/parse-profile,
                      GET /api/stats, GET /api/schemes/:id/why,
                      POST /api/schemes/:id/verify.
test/smoke.js         Zero-dependency smoke test hitting every endpoint
                      against a real running server. `npm test`.
```

## AI integration

Five AI touchpoints, all grounded in this app's own scheme data (never
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

**5. Fill by talking (AI form-fill)** — a "✨ Fill by talking" box above the
form (with voice input) lets a citizen describe themselves in one or two
plain sentences instead of tapping through every field: `POST
/api/parse-profile` turns that sentence into the same structured fields the
form itself collects — age, state, occupation, income, category, and a
handful of common flags — and pre-fills the real inputs so the citizen can
review and correct anything before submitting. It never invents a value
they didn't say, never fills a field they didn't mention, and never
touches eligibility itself — the rule engine still only ever reads what's
actually in the form. This is the most direct answer to "how easily are you
integrating AI into your product": it removes typing, not judgement. See
`profile-parser.js`.

Set one of these environment variables to enable all five AI features at
once:

```bash
export GROQ_API_KEY=gsk_...       # ← free, no card required, tried first
# or export OPENAI_API_KEY=sk-...
# or export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

**Automatic failover:** you're not limited to one. Set two or all three and
the app tries them in order — **Groq → OpenAI → Anthropic** — at runtime,
per request. If Groq is unset, times out, hits a rate limit, or errors, the
same call automatically retries on OpenAI, then Anthropic, before ever
falling back to the deterministic template. This means a single provider
outage or rate-limit spike no longer degrades the demo — it just quietly
routes around it. `GET /api/stats` exposes `aiProvider` (the primary),
`aiProviderChain` (the full configured order), and `aiLastProviderUsed`
(which provider actually served the most recent call, and how many
attempts it took) so the failover is visible, not just theoretical. See
`ai-provider.js` for the exact retry logic.

### Get a free API key in under 2 minutes

You don't need a paid OpenAI or Anthropic key to run this project.
[Groq](https://console.groq.com/keys) issues a free API key — no credit
card, generous free-tier rate limits, running fast open models (GPT-OSS
120B by default — Groq's recommended replacement for the now-decommissioned
Llama 3.3 70B). To use it:

1. Go to https://console.groq.com/keys and sign in (Google/GitHub works).
2. Click "Create API Key" and copy it.
3. Copy `env.example.txt` to `.env` and paste it in as `GROQ_API_KEY`.
4. `npm start` — all five AI features above now work end-to-end for free.

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

### Language support (English, Hindi, Telugu)

The full citizen journey — not just the AI paragraphs — works in three
languages. A toggle in the header (English → हिंदी → తెలుగు → English)
switches:

- **The static UI itself**: header, disclaimers, "how it works", privacy
  and connectivity panels, and the main profile-form fields (`data-i18n`
  attributes in `public/index.html`, translated via the `EN`/`HI`/`TE`
  dictionaries there).
- **All five AI touchpoints**: summary, chatbot, action plan, document
  checklist, and fill-by-talking each accept a `language` field and
  respond in that language — including their deterministic
  template/heuristic fallbacks when no AI key is set, so switching
  languages never depends on an API call succeeding. `server.js`'s
  `normalizeLanguage()` is the single source of truth for which language
  codes are accepted (`en` / `hi` / `te`); every AI module maps that code
  to a display language name or a pre-written string.
- **Fill by talking's offline heuristic parser** (`profile-parser.js`):
  Hindi and Telugu keyword/number patterns for age, gender, occupation,
  state, income, land, and the yes/no flags, so "fill by talking" still
  extracts real fields from Hindi or Telugu speech even with zero AI keys
  configured.
- **Voice input and read-aloud**: speech recognition and
  `SpeechSynthesis` both switch to `hi-IN` / `te-IN` alongside the
  language toggle.

Telugu was added specifically because a large share of this app's
target users — rural and semi-urban citizens applying for
occupation-linked schemes — are Telugu speakers in Andhra Pradesh and
Telangana; Hindi alone leaves them exactly as underserved as English
alone did. Adding a fourth language later is additive: one more
dictionary object in `index.html`, one more branch in each AI module's
language-name map, and (optionally) a few more heuristic keyword
patterns — none of the existing plumbing changes shape.

### How the AI touchpoints connect into one loop

These aren't five separate bolt-ons — they chain into a single citizen
journey, each step handing off to the next:

```
Try an example (1 click)  →  or:  Speak/type a sentence
        ↓                              ↓
        └──────────────→  AI extracts fields   →  Form is pre-filled
                              (profile-parser.js)      (citizen reviews/edits)
        ↓
Live on-device count + ₹ estimate as the form is completed
        ↓
Submit  →  rule engine decides eligibility (never AI)
        ↓
AI summary explains the verdict in plain language  →  🔊 Read aloud
        (ai-summary.js)                                 (same text, spoken —
                                                          closes the loop with
                                                          the voice input above)
        ↓
🔧 "What if?" income slider — instantly re-runs the same on-device rules
   at a different income, no AI call needed, so the citizen can feel how
   sensitive their result is before ever contacting a scheme office
        ↓
🧭 AI action plan + 📋 AI document checklist — also readable aloud
        ↓
Print / WhatsApp share
```

The two newest links — read-aloud and the income simulator — are
deliberately NOT extra AI calls: read-aloud is the browser's own
`SpeechSynthesis`, and the simulator re-runs the same dependency-free rule
engine that already powers the offline fallback and the live preview. Both
exist specifically to close gaps in the *user flow*, not to add AI for its
own sake — an AI call it doesn't need would just be slower and less
reliable than a browser API or a rule engine that's already sitting there.

The "try an example" chips exist for a different audience than a real
citizen: someone deciding in the first few seconds whether this is worth
their time at all (a judge, a first-time visitor). One click runs the exact
same pipeline a real citizen's own sentence would — same API call, same
autofill, same rule engine, same AI summary — just with a realistic
pre-written sentence instead of the person's own words, and it auto-submits
after the fields visibly fill in so the whole journey is visible without
typing anything.

## Latest additions

Two features aimed at the two drop-off points the five AI touchpoints above
don't cover — "I'll come back to this later" and "I'd rather talk to a
person":

**🔔 Remind me to follow up** — a "Remind me" link on every eligible /
needs-verification scheme card downloads a real `.ics` calendar file
(`GET /api/schemes/:id/reminder.ics`, see `reminder.js`) that any phone or
desktop calendar app already knows how to import. Welfare schemes often need
a citizen to come back later — before the next sowing season for crop
insurance, before a new academic year for a scholarship, or just to check a
pending verification — and that follow-up shouldn't depend on remembering a
browser tab. Each scheme gets a sensible follow-up horizon based on its own
real application cycle (documented in `reminder.js`), never a fabricated
"deadline" — the event text always says this is a nudge, not an official
date, and points back to the real portal to confirm it.

**🏢 Find in-person help near you** — a button next to "Share on WhatsApp"
for citizens who'd rather have someone else fill the form: a short panel
explaining what a Common Service Centre (CSC) is and linking straight to the
two real, official, national entry points (csc.gov.in and myScheme). Fully
static and client-side — no new API call, no per-district directory this
prototype can't keep current — and it says plainly that it can't look up an
exact nearby address rather than inventing one.

**🔊 Read questions aloud (voice-guided form)** — a toggle next to the
language switcher that reads each field's own label aloud the moment it
gets focus, in whichever of English/Hindi/Telugu is currently selected. The
existing read-aloud buttons on AI summaries close the loop on the *output*
side of the app; this closes the same gap on the *input* side, for anyone
who finds a long, unfamiliar form easier to listen to than read. Reuses the
same browser `SpeechSynthesis` call the AI-summary read-aloud buttons
already use — no new dependency, works fully offline, off by default.

**📝 Auto-save and resume your answers** — every change to the form is
saved locally (never sent anywhere), and a citizen who closes the tab,
loses signal, or gets interrupted mid-form sees a "pick up where you left
off?" banner next time they open the page with an empty form. Distinct from
the QR/link share feature above (which is for handing your answers to
someone *else*) — this is for the same person coming back later. A draft
older than 7 days is treated as stale and dropped rather than resurfacing
answers that may no longer be current.

## Newest additions — broader coverage

Four more real, well-known central schemes, chosen specifically to cover
citizen groups the original 17 didn't reach — **women without a BPL card
seeking an LPG connection, informal street vendors, aspiring micro-
entrepreneurs, and SC/ST or women founders** — taking total coverage from
17 to **21** schemes:

- **PM Ujjwala Yojana (PMUY)** — free LPG connection for BPL/low-income
  women (`pmujjwala`).
- **PM SVANidhi** — collateral-free working-capital loans for street
  vendors (`pmsvanidhi`).
- **PM Mudra Yojana** — collateral-free business loans up to ₹10 lakh for
  aspiring micro-entrepreneurs (`pmmudra`).
- **Stand-Up India** — ₹10 lakh–₹1 crore bank loans for SC/ST or women
  founders starting a first-time enterprise (`standupindia`).

Each was added as **pure data** — a `{ id, name, dept, benefit, tag, docs,
populationRules, check }` entry in `schemes.js` plus matching `PORTALS` /
`VERIFICATION_BASE` rows — using only profile fields the form already
collects (occupation, gender, category, income, BPL status), so **no new
form fields, no new AI prompts, and no changes to `server.js`'s API
surface** were needed. Every new scheme was also mirrored into the
offline fallback copy inside `public/index.html` (`window.LOCAL_SCHEMES`)
so the on-device journey stays identical to the live one, exactly as the
existing 17 schemes already work — and both copies were checked against
the same set of test profiles to confirm they agree.

`standupindia`'s rule ("SC/ST **or** woman entrepreneur") is the one case
the declarative rule engine can't express directly (it's AND-only by
design — see `rule-engine.js`), so that specific OR condition lives in the
scheme's own `check()` function, the same pattern the existing BOCW scheme
already uses for its extra fields — not a new engine capability, just the
existing "population rules narrow, `check()` does the rest" escape hatch
used a second time.

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
database, the live/offline fallback, the WhatsApp share link, and all five
AI layers (a real call to OpenAI/Anthropic/Groq when a key is set —
summary, chatbot, action plan, document checklist, and fill-by-talking
form autofill).

**Mocked:** the schemes reflect publicly known, general eligibility
criteria — not a live government feed. "Start application" does not submit
to any real system. No Aadhaar, OTP, or payment data is collected anywhere.

## How this could scale

- Swap SQLite for Postgres; no query changes needed.
- Pull scheme content from myScheme / state portals via API instead of a
  static seed.
- Add more regional languages and an SMS/IVR fallback for feature-phone users.
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

**Getting an answer to a user with no signal:

User
 ↓
Local rule cache
 ↓
Offline eligibility engine

This is the fallback that already exists in public/index.html — the on-device logic that runs when the API call is slow or fails — described as its own path rather than an afterthought bolted onto the online one. The rules engine (schemes.js) is small and dependency-free specifically so it can ship to the client as a cached bundle and run identically offline; the "local rule cache" is just that bundle, refreshed opportunistically whenever the device does have connectivity, so a user on a poor connection is always evaluated against a recent version of the rules rather than being blocked until a request succeeds.
