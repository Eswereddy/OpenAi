/**
 * seed-real-schemes.js
 *
 * Replaces/updates your `schemes` table with the 15 real, sourced schemes
 * from schemes-seed-data.js — WITHOUT needing to know your exact table
 * schema in advance. It inspects the live database, matches our fields to
 * whatever column names you actually have, and tells you exactly what it
 * did. Nothing is silently dropped: anything it can't map to a real column
 * gets stored as JSON in a fallback `extra_data` column it creates if needed.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   1. Put this file and schemes-seed-data.js in the same folder as your
 *      db (or anywhere — you pass the db path as an argument).
 *   2. npm install better-sqlite3   (if you don't already have it)
 *   3. node seed-real-schemes.js ./path/to/your.db
 *
 *      If you don't know your db file's path, check db/index.js for a
 *      line like `new Database("something.db")` or `sqlite3.Database(...)`
 *      — that string is your path. Common defaults this script will also
 *      try automatically if you don't pass one:
 *        ./data.db  ./database.sqlite  ./db.sqlite  ./schemes.db
 *        ./db/data.db  ./db/database.sqlite
 *
 *   4. Restart your server (`npm start`) after seeding — it doesn't
 *      auto-reload the DB while running.
 *
 * ── WHAT IF YOU USE `sqlite3` INSTEAD OF `better-sqlite3`? ──────────────
 *   This script assumes better-sqlite3 (synchronous, very common for
 *   small projects). If `require("better-sqlite3")` fails and you know
 *   your project uses the async `sqlite3` package instead, tell me and
 *   I'll rewrite this with callbacks/promises instead of guessing wrong.
 * ─────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");
const { SCHEMES_SEED } = require("./schemes-seed-data");

let Database;
try {
  Database = require("better-sqlite3");
} catch (e) {
  console.error(
    "\n[!] Couldn't load 'better-sqlite3'. Install it first:\n" +
    "    npm install better-sqlite3\n" +
    "If your project actually uses the 'sqlite3' package (async, callback-based)\n" +
    "instead, tell me and I'll rewrite this script for that driver.\n"
  );
  process.exit(1);
}

const CANDIDATE_PATHS = [
  "./data.db", "./database.sqlite", "./db.sqlite", "./schemes.db",
  "./db/data.db", "./db/database.sqlite", "./db/schemes.db",
];

function resolveDbPath() {
  const argPath = process.argv[2];
  if (argPath) {
    if (!fs.existsSync(argPath)) {
      console.error(`[!] File not found: ${argPath}`);
      process.exit(1);
    }
    return argPath;
  }
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`[i] No path given — found and using: ${p}`);
      return p;
    }
  }
  console.error(
    "\n[!] Couldn't auto-find your database file. Run again with the path:\n" +
    "    node seed-real-schemes.js ./path/to/your.db\n"
  );
  process.exit(1);
}

// Field -> list of column-name synonyms we'll look for, in priority order.
const FIELD_SYNONYMS = {
  id: ["id", "scheme_id", "schemeId"],
  name: ["name", "schemeName", "title", "scheme_name"],
  level: ["level", "authority", "govLevel"],
  category: ["category", "sector", "type"],
  benefit: ["benefit", "benefitAmount", "amount", "assistance"],
  description: ["description", "summary", "details"],
  eligibility: ["eligibility", "criteria", "eligibilityCriteria"],
  docs: ["docs", "documents", "requiredDocs", "documentsRequired"],
  source: ["source", "sourceUrl", "reference"],
};

function main() {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schemes'")
    .get();

  if (!tableExists) {
    console.log("[i] No 'schemes' table found — creating one with a full schema.");
    db.exec(`
      CREATE TABLE schemes (
        id TEXT PRIMARY KEY,
        name TEXT,
        level TEXT,
        category TEXT,
        benefit TEXT,
        description TEXT,
        eligibility TEXT,
        docs TEXT,
        source TEXT,
        extra_data TEXT
      );
    `);
  }

  const columns = db.prepare("PRAGMA table_info(schemes)").all().map(c => c.name);
  console.log("[i] Existing columns in 'schemes':", columns.join(", "));

  // Map each of our fields to a real column, if one exists.
  const colMap = {};
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    const match = synonyms.find(s => columns.includes(s));
    if (match) colMap[field] = match;
  }
  console.log("[i] Field mapping used:", colMap);

  const unmapped = Object.keys(FIELD_SYNONYMS).filter(f => !colMap[f]);
  let extraDataCol = columns.includes("extra_data") ? "extra_data" : null;
  if (unmapped.length && !extraDataCol) {
    console.log(
      `[i] These fields have no matching column: ${unmapped.join(", ")}.\n` +
      `    Adding a fallback 'extra_data' column so nothing is lost.`
    );
    db.exec("ALTER TABLE schemes ADD COLUMN extra_data TEXT;");
    extraDataCol = "extra_data";
  }

  const idCol = colMap.id;
  const nameCol = colMap.name;
  if (!idCol && !nameCol) {
    console.error("[!] Couldn't find an id or name column to key rows on — aborting to avoid duplicate rows.");
    process.exit(1);
  }

  let inserted = 0, updated = 0;
  const insertStmtCache = {};

  for (const scheme of SCHEMES_SEED) {
    const row = {};
    for (const [field, col] of Object.entries(colMap)) {
      let val = scheme[field];
      if (val === undefined) continue;
      if (typeof val === "object") val = JSON.stringify(val);
      row[col] = val;
    }
    if (extraDataCol) {
      const leftover = {};
      unmapped.forEach(f => { if (scheme[f] !== undefined) leftover[f] = scheme[f]; });
      if (Object.keys(leftover).length) row[extraDataCol] = JSON.stringify(leftover);
    }

    const keyCol = idCol || nameCol;
    const keyVal = idCol ? scheme.id : scheme.name;

    const existing = db.prepare(`SELECT rowid FROM schemes WHERE ${keyCol} = ?`).get(keyVal);
    const cols = Object.keys(row);
    if (!cols.length) continue;

    if (existing) {
      const setClause = cols.map(c => `${c} = @${c}`).join(", ");
      const stmtKey = "u:" + setClause;
      if (!insertStmtCache[stmtKey]) {
        insertStmtCache[stmtKey] = db.prepare(`UPDATE schemes SET ${setClause} WHERE ${keyCol} = @__key`);
      }
      insertStmtCache[stmtKey].run({ ...row, __key: keyVal });
      updated++;
    } else {
      const colNames = cols.join(", ");
      const placeholders = cols.map(c => `@${c}`).join(", ");
      const stmtKey = "i:" + colNames;
      if (!insertStmtCache[stmtKey]) {
        insertStmtCache[stmtKey] = db.prepare(`INSERT INTO schemes (${colNames}) VALUES (${placeholders})`);
      }
      insertStmtCache[stmtKey].run(row);
      inserted++;
    }
  }

  console.log(`\n[✓] Done. Inserted ${inserted} new schemes, updated ${updated} existing rows.`);
  console.log(`[i] Restart your server for the app to see the new data.`);
  db.close();
}

main();
