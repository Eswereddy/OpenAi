# Am I Eligible? — Welfare Scheme Discovery

A prototype for the OpenAI Codex India hackathon. India runs 1,000+ welfare
schemes; most eligible citizens never find out they qualify. This app takes
five short answers and tells you which of 16 real, well-known schemes you
likely qualify for — in plain language, with an explanation for every match.

## Architecture

```
public/index.html   Frontend — form, results, WhatsApp share. Calls the API
                     first; falls back to identical on-device logic if the
                     network is slow or unavailable (real concern on the
                     connections this is built for).
schemes.js           The rules engine — scheme metadata + eligibility logic.
db/index.js          SQLite setup — seeds scheme metadata into a real table,
                      and logs anonymised match summaries (no names, no ID
                      numbers, no phone numbers — ever).
server.js            Express API: GET /api/schemes, POST /api/match,
                      GET /api/stats.
```

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

This repo deploys as-is to Render, Railway, or any Node host:
- Build command: `npm install`
- Start command: `npm start`
- No environment variables required for the demo.

## What's real vs. mocked

**Real:** the full citizen journey, the rule-based matching engine, the
database, the live/offline fallback, the WhatsApp share link.

**Mocked:** the 17 schemes reflect publicly known, general eligibility
criteria — not a live government feed. "Start application" does not submit
to any real system. No Aadhaar, OTP, or payment data is collected anywhere.

## How this could scale

- Swap SQLite for Postgres; no query changes needed.
- Pull scheme content from myScheme / state portals via API instead of a
  static seed.
- Add regional languages and an SMS/IVR fallback for feature-phone users.
- Use the `submissions` table (already anonymised) to see which schemes are
  under-discovered by state or occupation, and prioritise outreach there.
