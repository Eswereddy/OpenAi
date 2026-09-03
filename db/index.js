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
    source_url TEXT,
    last_verified TEXT,
    version INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    age_band TEXT,
    gender TEXT,
    state TEXT,
    occupation TEXT,
    income_band TEXT,
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
  "ALTER TABLE schemes ADD COLUMN source_url TEXT",
  "ALTER TABLE schemes ADD COLUMN last_verified TEXT",
  "ALTER TABLE schemes ADD COLUMN version INTEGER DEFAULT 1",
  // Older DBs from before this fix stored an exact "age" and a raw
  // (mislabeled) "income_band" value. This adds the real bucketed column;
  // the pre-existing income_band column is reused as-is below — SQLite's
  // type affinity happily stores text like "1L-2.5L" in a REAL column.
  "ALTER TABLE submissions ADD COLUMN age_band TEXT",
]) {
  try { db.exec(stmt); } catch (_) { /* column already exists */ }
}

function seedSchemesIfEmpty() {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM schemes").get();
  const insert = db.prepare(`
    INSERT INTO schemes (id, name, dept, benefit, tag, docs, portal_name, portal_url, source_authority, source_note, source_url, last_verified, version)
    VALUES (@id, @name, @dept, @benefit, @tag, @docs, @portalName, @portalUrl, @sourceAuthority, @sourceNote, @sourceUrl, @lastVerified, @version)
    ON CONFLICT(id) DO UPDATE SET
      portal_name      = excluded.portal_name,
      portal_url       = excluded.portal_url,
      -- Only backfill provenance fields when the row doesn't already have
      -- them — a scheme that's been through markSchemeVerified() has real,
      -- human-confirmed data that a code re-seed must never overwrite with
      -- the static defaults from schemes.js.
      source_authority = COALESCE(schemes.source_authority, excluded.source_authority),
      source_note      = COALESCE(schemes.source_note, excluded.source_note),
      source_url        = COALESCE(schemes.source_url, excluded.source_url),
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
             source_url AS sourceUrl, last_verified AS lastVerified, version
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
function markSchemeVerified(id, { sourceAuthority, sourceNote, sourceUrl, verifiedAt } = {}) {
  const existing = db.prepare("SELECT * FROM schemes WHERE id = ?").get(id);
  if (!existing) return null;
  const date = verifiedAt || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  db.prepare(`
    UPDATE schemes SET
      source_authority = @sourceAuthority,
      source_note = @sourceNote,
      source_url = @sourceUrl,
      last_verified = @lastVerified,
      version = @version
    WHERE id = @id
  `).run({
    id,
    sourceAuthority: sourceAuthority || existing.source_authority,
    sourceNote: sourceNote || existing.source_note,
    sourceUrl: sourceUrl || existing.source_url,
    lastVerified: date,
    version: (existing.version || 1) + 1,
  });
  return db.prepare("SELECT id, source_authority AS sourceAuthority, source_note AS sourceNote, source_url AS sourceUrl, last_verified AS lastVerified, version FROM schemes WHERE id = ?").get(id);
}

// Buckets a profile down to coarse, non-identifying categories before
// anything touches disk. The matching engine (schemes.js) still gets the
// citizen's exact age/income — it needs precision to check real eligibility
// ceilings like "income above ₹3.5 lakh". This function is only ever
// applied to the copy that gets logged for analytics, never to the copy
// used for matching.
function ageBand(age) {
  if (!Number.isFinite(age)) return null;
  if (age < 18) return "<18";
  if (age <= 25) return "18-25";
  if (age <= 35) return "26-35";
  if (age <= 45) return "36-45";
  if (age <= 60) return "46-60";
  return "60+";
}

function incomeBand(incomeLakhs) {
  // profile.income arrives already converted to ₹ lakhs by the frontend,
  // and is Infinity when the citizen didn't provide one — never 0.
  if (!Number.isFinite(incomeLakhs)) return null;
  if (incomeLakhs < 0.5) return "<50k";
  if (incomeLakhs < 1) return "50k-1L";
  if (incomeLakhs < 2.5) return "1L-2.5L";
  if (incomeLakhs < 5) return "2.5L-5L";
  if (incomeLakhs < 8) return "5L-8L";
  return "8L+";
}

function logSubmission(profile, matches) {
  db.prepare(`
    INSERT INTO submissions (age_band, gender, state, occupation, income_band, category, matched_count, matched_scheme_ids)
    VALUES (@age_band, @gender, @state, @occupation, @income_band, @category, @matched_count, @matched_scheme_ids)
  `).run({
    age_band: ageBand(profile.age),
    gender: profile.gender ?? null,
    state: profile.state ?? null,
    occupation: profile.occupation ?? null,
    income_band: incomeBand(profile.income),
    category: profile.category ?? null,
    matched_count: matches.length,
    matched_scheme_ids: JSON.stringify(matches.map((m) => m.id)),
  });
}

// Data-minimisation: don't keep individual anonymous rows forever just
// because storage is cheap. Aggregate stats (getStats, below) only need
// counts, not indefinitely-retained rows — so periodically collapse rows
// older than the retention window down to nothing, on the theory that
// whatever insight they held has already been folded into earlier runs
// of getStats() or would be by a real reporting job. A production
// deployment would run this on a schedule (see server.js) rather than
// rely on someone remembering to call it; it would probably also roll
// purged rows into a monthly aggregate table instead of just deleting,
// so month-over-month trend lines survive the purge. Out of scope for
// this prototype, but this is the seam where that would plug in.
const DEFAULT_RETENTION_DAYS = 180;
function purgeOldSubmissions(retentionDays = DEFAULT_RETENTION_DAYS) {
  const result = db
    .prepare(`DELETE FROM submissions WHERE created_at < datetime('now', ?)`)
    .run(`-${retentionDays} days`);
  return result.changes;
}

function getStats() {
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM submissions").get();
  const { avg } = db.prepare("SELECT AVG(matched_count) AS avg FROM submissions").get();
  const { schemesIndexed } = db.prepare("SELECT COUNT(*) AS schemesIndexed FROM schemes").get();
  const byOccupation = db
    .prepare("SELECT occupation, COUNT(*) AS n FROM submissions WHERE occupation IS NOT NULL GROUP BY occupation ORDER BY n DESC LIMIT 5")
    .all();
  const topStates = db
    .prepare("SELECT state, COUNT(*) AS n FROM submissions WHERE state IS NOT NULL GROUP BY state ORDER BY n DESC LIMIT 5")
    .all();
  return {
    totalSubmissions: total,
    // null (not 0) when there's no data yet — 0 would claim "citizens average
    // zero matches", which is a different (and misleading) statement from
    // "we don't have enough submissions to compute this yet". The frontend
    // renders null as "—" instead of a fabricated number.
    avgMatchesPerCitizen: total > 0 && avg != null ? Math.round(avg * 10) / 10 : null,
    schemesIndexed,
    byOccupation,
    topStates,
  };
}

module.exports = { db, getAllSchemes, logSubmission, getStats, markSchemeVerified, purgeOldSubmissions };
