// db/index.js
// SQLite is the right choice for this prototype: zero external service to
// provision, ships as a single file, and is a straightforward swap for
// Postgres later (the queries below are plain SQL, no SQLite-specific syntax
// beyond AUTOINCREMENT). At real scale this table would move to Postgres and
// the submissions table would be the seed for an analytics warehouse.

const path = require("path");
const Database = require("better-sqlite3");
const { SCHEME_METADATA } = require("../schemes");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS schemes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dept TEXT,
    benefit TEXT,
    tag TEXT,
    docs TEXT
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    age INTEGER,
    gender TEXT,
    state TEXT,
    occupation TEXT,
    income_band REAL,
    category TEXT,
    matched_count INTEGER,
    matched_scheme_ids TEXT
  );
`);
// Note: no name, phone, Aadhaar, or other identifying fields are ever stored —
// only the coarse profile attributes needed to compute matches and to later
// analyse which schemes are under-discovered in which segments.

function seedSchemesIfEmpty() {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM schemes").get();
  if (c > 0) return;
  const insert = db.prepare(
    "INSERT INTO schemes (id, name, dept, benefit, tag, docs) VALUES (@id, @name, @dept, @benefit, @tag, @docs)"
  );
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run({ ...row, docs: JSON.stringify(row.docs) });
  });
  insertMany(SCHEME_METADATA);
}
seedSchemesIfEmpty();

function getAllSchemes() {
  return db
    .prepare("SELECT id, name, dept, benefit, tag, docs FROM schemes ORDER BY name")
    .all()
    .map((row) => ({ ...row, docs: JSON.parse(row.docs) }));
}

function logSubmission(profile, matches) {
  db.prepare(`
    INSERT INTO submissions (age, gender, state, occupation, income_band, category, matched_count, matched_scheme_ids)
    VALUES (@age, @gender, @state, @occupation, @income_band, @category, @matched_count, @matched_scheme_ids)
  `).run({
    age: profile.age ?? null,
    gender: profile.gender ?? null,
    state: profile.state ?? null,
    occupation: profile.occupation ?? null,
    income_band: profile.income ?? null,
    category: profile.category ?? null,
    matched_count: matches.length,
    matched_scheme_ids: JSON.stringify(matches.map((m) => m.id)),
  });
}

function getStats() {
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM submissions").get();
  const { avg } = db.prepare("SELECT AVG(matched_count) AS avg FROM submissions").get();
  const byOccupation = db
    .prepare("SELECT occupation, COUNT(*) AS n FROM submissions WHERE occupation IS NOT NULL GROUP BY occupation ORDER BY n DESC LIMIT 5")
    .all();
  const topStates = db
    .prepare("SELECT state, COUNT(*) AS n FROM submissions WHERE state IS NOT NULL GROUP BY state ORDER BY n DESC LIMIT 5")
    .all();
  return {
    totalSubmissions: total,
    avgMatchesPerCitizen: avg ? Math.round(avg * 10) / 10 : 0,
    byOccupation,
    topStates,
  };
}

module.exports = { db, getAllSchemes, logSubmission, getStats };
