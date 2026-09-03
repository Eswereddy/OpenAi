// db/index.js
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
    docs TEXT,
    portal_name TEXT,
    portal_url TEXT,
    source_authority TEXT,
    source_note TEXT,
    last_verified TEXT,
    version INTEGER DEFAULT 1
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

// Migration for DB files created before portal_name/portal_url existed —
// CREATE TABLE IF NOT EXISTS above won't add columns to an already-existing
// table, so add them explicitly. Each is wrapped individually since SQLite
// throws if the column is already there (no "IF NOT EXISTS" for ALTER TABLE
// ADD COLUMN), and errors here are expected/harmless on a fresh DB.
for (const stmt of [
  "ALTER TABLE schemes ADD COLUMN portal_name TEXT",
  "ALTER TABLE schemes ADD COLUMN portal_url TEXT",
  "ALTER TABLE schemes ADD COLUMN source_authority TEXT",
  "ALTER TABLE schemes ADD COLUMN source_note TEXT",
  "ALTER TABLE schemes ADD COLUMN last_verified TEXT",
  "ALTER TABLE schemes ADD COLUMN version INTEGER DEFAULT 1",
]) {
  try { db.exec(stmt); } catch (_) { /* column already exists */ }
}

function seedSchemesIfEmpty() {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM schemes").get();
  const insert = db.prepare(`
    INSERT INTO schemes (id, name, dept, benefit, tag, docs, portal_name, portal_url, source_authority, source_note, last_verified, version)
    VALUES (@id, @name, @dept, @benefit, @tag, @docs, @portalName, @portalUrl, @sourceAuthority, @sourceNote, @lastVerified, @version)
    ON CONFLICT(id) DO UPDATE SET
      portal_name      = excluded.portal_name,
      portal_url       = excluded.portal_url,
      -- Only backfill provenance fields when the row doesn't already have
      -- them — a scheme that's been through markSchemeVerified() has real,
      -- human-confirmed data that a code re-seed must never overwrite with
      -- the static defaults from schemes.js.
      source_authority = COALESCE(schemes.source_authority, excluded.source_authority),
      source_note      = COALESCE(schemes.source_note, excluded.source_note),
      last_verified     = COALESCE(schemes.last_verified, excluded.last_verified),
      version           = COALESCE(schemes.version, excluded.version)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run({ ...row, docs: JSON.stringify(row.docs) });
  });
  // Always run: on a fresh DB this inserts every scheme; on an existing DB
  // (from before portal links existed) the ON CONFLICT clause backfills
  // portal_name/portal_url onto rows that were seeded before this feature,
  // without touching name/dept/benefit/etc that a real deployment might
  // have since edited by hand.
  insertMany(SCHEME_METADATA);
  void c;
}
seedSchemesIfEmpty();

function getAllSchemes() {
  return db
    .prepare(`
      SELECT id, name, dept, benefit, tag, docs,
             portal_name AS portalName, portal_url AS portalUrl,
             source_authority AS sourceAuthority, source_note AS sourceNote,
             last_verified AS lastVerified, version
      FROM schemes ORDER BY name
    `)
    .all()
    .map((row) => ({ ...row, docs: JSON.parse(row.docs) }));
}

// Records a real, human-confirmed check against the official source — the
// only legitimate way lastVerified/version should ever move forward. Never
// call this from a code path that hasn't actually looked at the official
// portal/notification; seeding defaults (above) deliberately never touch
// last_verified once it's set, for the same reason.
function markSchemeVerified(id, { sourceAuthority, sourceNote, verifiedAt } = {}) {
  const existing = db.prepare("SELECT * FROM schemes WHERE id = ?").get(id);
  if (!existing) return null;
  const date = verifiedAt || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  db.prepare(`
    UPDATE schemes SET
      source_authority = @sourceAuthority,
      source_note = @sourceNote,
      last_verified = @lastVerified,
      version = @version
    WHERE id = @id
  `).run({
    id,
    sourceAuthority: sourceAuthority || existing.source_authority,
    sourceNote: sourceNote || existing.source_note,
    lastVerified: date,
    version: (existing.version || 1) + 1,
  });
  return db.prepare("SELECT id, source_authority AS sourceAuthority, source_note AS sourceNote, last_verified AS lastVerified, version FROM schemes WHERE id = ?").get(id);
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

module.exports = { db, getAllSchemes, logSubmission, getStats, markSchemeVerified };
