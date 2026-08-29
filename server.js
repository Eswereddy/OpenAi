// server.js
// Thin Express API in front of the rules engine (schemes.js) and the SQLite
// database (db/index.js). Kept deliberately simple: three endpoints, no
// auth needed because no personal or sensitive data is ever collected.

const path = require("path");
const express = require("express");
const { matchProfile } = require("./schemes");
const { getAllSchemes, logSubmission, getStats } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/schemes — full catalog of scheme metadata (name, benefit, docs, etc.)
// Read from the database, which is the source of truth for displayable content.
app.get("/api/schemes", (req, res) => {
  try {
    res.json({ schemes: getAllSchemes() });
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
    logSubmission(profile, matches);
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

app.get("/healthz", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Am I Eligible? backend running on port ${PORT}`));
