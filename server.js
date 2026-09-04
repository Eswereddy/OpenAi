// server.js
// Thin Express API in front of the rules engine (schemes.js) and the SQLite
// database (db/index.js). Kept deliberately simple: five endpoints, no
// auth needed because no personal or sensitive data is ever collected.

const path = require("path");
const express = require("express");
const { matchProfile, explainScheme } = require("./schemes");
const { getAllSchemes, logSubmission, getStats, markSchemeVerified, purgeOldSubmissions } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/schemes — full catalog of scheme metadata (name, benefit, docs, etc.)
// Read from the database, which is the source of truth for displayable
// content, then stitch in `criteria` — the plain-English rule list from
// schemes.js — since eligibility *rules* live in code (versioned with the
// app), not in the DB (which holds editable/verifiable provenance). This
// is what lets every scheme card in the UI answer "why do you say this?"
// without a second round-trip.
app.get("/api/schemes", (req, res) => {
  try {
    const schemes = getAllSchemes().map((s) => {
      const explanation = explainScheme(s.id);
      return { ...s, criteria: explanation ? explanation.criteria : [] };
    });
    res.json({ schemes });
  } catch (err) {
    console.error("GET /api/schemes failed:", err);
    res.status(500).json({ error: "Could not load schemes." });
  }
});

// POST /api/match — the core endpoint. Takes a citizen's profile (no name,
// no ID numbers — just coarse attributes) and returns which schemes match,
// with an explanation for each. Also logs an anonymised summary so a real
// deployment could see which schemes are most/least discovered by region.
app.post("/api/match", (req, res) => {
  try {
    const profile = req.body || {};
    const matches = matchProfile(profile);
    // matches now includes "not_eligible" / "insufficient_info" entries too
    // (so the citizen sees the full, honest picture) — but the stats table
    // is meant to answer "how many schemes did this person likely qualify
    // for", so only count the positive statuses there.
    const positiveMatches = matches.filter(m => m.status === "eligible" || m.status === "needs_verification");
    logSubmission(profile, positiveMatches);
    res.json({ matches });
  } catch (err) {
    console.error("POST /api/match failed:", err);
    res.status(500).json({ error: "Could not compute matches." });
  }
});

// GET /api/stats — aggregate, anonymised numbers only. This is the seed of
// the "how would this work at scale" story: which occupations and states are
// asking, and how many schemes people typically qualify for but likely never
// knew about.
app.get("/api/stats", (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    console.error("GET /api/stats failed:", err);
    res.status(500).json({ error: "Could not load stats." });
  }
});

// POST /api/schemes/:id/verify — records that a human actually checked this
// scheme's data against its official source (a notification, the scheme's
// own portal, etc). This is deliberately a real action, not a data-entry
// shortcut: it's how last_verified/version move forward, and it's the only
// path that does — a re-seed from schemes.js never overwrites these once set
// (see the ON CONFLICT clause in db/index.js). No auth layer here since this
// demo has none at all, but a real deployment would restrict this to staff.
app.post("/api/schemes/:id/verify", (req, res) => {
  try {
    const { sourceAuthority, sourceNote, sourceUrl, verifiedAt } = req.body || {};
    const updated = markSchemeVerified(req.params.id, { sourceAuthority, sourceNote, sourceUrl, verifiedAt });
    if (!updated) return res.status(404).json({ error: "Unknown scheme id." });
    res.json({ scheme: updated });
  } catch (err) {
    console.error("POST /api/schemes/:id/verify failed:", err);
    res.status(500).json({ error: "Could not record verification." });
  }
});

// GET /api/schemes/:id/why — the "Why do you say this?" endpoint. Returns
// the full provenance chain for one scheme: the plain-English criteria the
// engine actually evaluated (derived live from schemes.js's
// populationRules/requirementRules, so it can't drift from the real rules),
// plus who owns the underlying facts, where to go verify them, and how
// stale the entry is. Reads live from the DB for sourceAuthority/sourceUrl/
// lastVerified/version so a human re-verification (via /verify above) is
// reflected immediately, without needing a redeploy.
app.get("/api/schemes/:id/why", (req, res) => {
  try {
    const explanation = explainScheme(req.params.id);
    if (!explanation) return res.status(404).json({ error: "Unknown scheme id." });
    const dbRow = getAllSchemes().find((s) => s.id === req.params.id);
    res.json({
      ...explanation,
      sourceAuthority: (dbRow && dbRow.sourceAuthority) || explanation.sourceAuthority,
      sourceNote: (dbRow && dbRow.sourceNote) || explanation.sourceNote,
      sourceUrl: (dbRow && dbRow.sourceUrl) || explanation.sourceUrl,
      lastVerified: (dbRow && dbRow.lastVerified) || explanation.lastVerified,
      version: (dbRow && dbRow.version) || explanation.version,
    });
  } catch (err) {
    console.error("GET /api/schemes/:id/why failed:", err);
    res.status(500).json({ error: "Could not load provenance." });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Am I Eligible? backend running on port ${PORT}`));

// Data-minimisation: run the retention purge on boot and once a day after
// that, so anonymous submission rows don't accumulate indefinitely. A real
// deployment would use a proper scheduled job (cron, a queue, etc.) instead
// of an in-process timer that resets on every restart — this is enough to
// demonstrate the retention policy actually runs, not a production scheduler.
try {
  const purged = purgeOldSubmissions();
  if (purged) console.log(`Startup retention purge: removed ${purged} submission row(s) past the retention window.`);
} catch (err) {
  console.error("Startup retention purge failed:", err);
}
setInterval(() => {
  try { purgeOldSubmissions(); } catch (err) { console.error("Scheduled retention purge failed:", err); }
}, 24 * 60 * 60 * 1000);
