// test/smoke.js
//
// Zero-dependency smoke test: boots the real server as a child process
// (against a throwaway SQLite file, never the real data.db), hits every
// endpoint, and checks the shape/logic of the responses. Not a substitute
// for real unit tests on the rule engine, but it catches the class of bug
// that matters most for a demo — "the server doesn't start" or "an
// endpoint 500s" — in a few seconds, with no extra dependencies to install.
//
// Run with: npm test

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3999;
const DB_PATH = path.join(__dirname, "smoke-test.db");
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

async function main() {
  try { fs.unlinkSync(DB_PATH); } catch (_) { /* fine if it doesn't exist */ }

  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH },
    stdio: "pipe",
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d));
  server.stderr.on("data", (d) => (serverOutput += d));

  try {
    const up = await waitForServer();
    check("server starts and responds on /healthz", up);
    if (!up) {
      console.log("--- server output ---\n" + serverOutput);
      process.exitCode = 1;
      return;
    }

    // GET /api/schemes — full catalog with stitched-in criteria
    const schemesRes = await fetch(`${BASE}/api/schemes`);
    const schemesBody = await schemesRes.json();
    check("GET /api/schemes returns 200", schemesRes.status === 200);
    check("GET /api/schemes returns a non-empty scheme list", Array.isArray(schemesBody.schemes) && schemesBody.schemes.length > 0);
    check("each scheme has stitched-in criteria", schemesBody.schemes.every((s) => Array.isArray(s.criteria)));

    // POST /api/match — a farmer profile should clearly get PM-KISAN
    const farmerRes = await fetch(`${BASE}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        age: 40, gender: "male", state: "Andhra Pradesh", occupation: "Farmer",
        income: 1.5, category: "General", farmland: true, bankAccount: true,
      }),
    });
    const farmerBody = await farmerRes.json();
    check("POST /api/match returns 200", farmerRes.status === 200);
    const pmkisan = (farmerBody.matches || []).find((m) => m.id === "pmkisan");
    check("a landholding farmer matches pm-kisan as eligible", !!pmkisan && pmkisan.status === "eligible");

    // Missing income must never produce a false "eligible" on an
    // income-gated scheme — this is the specific bug class the Infinity
    // sentinel in schemes.js exists to prevent.
    const blankIncomeRes = await fetch(`${BASE}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: 65, gender: "female", state: "Bihar", occupation: "Unemployed" }),
    });
    const blankIncomeBody = await blankIncomeRes.json();
    const pension = (blankIncomeBody.matches || []).find((m) => m.id === "ignoaps");
    check(
      "blank income never yields a false 'eligible' on an income-gated scheme",
      !pension || pension.status !== "eligible"
    );

    // Malformed JSON must return clean JSON, not an HTML page with a stack
    // trace (a real information leak on a public API).
    const badJsonRes = await fetch(`${BASE}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const badJsonBody = await badJsonRes.json().catch(() => null);
    check("malformed JSON returns 400 with a JSON error body", badJsonRes.status === 400 && badJsonBody && typeof badJsonBody.error === "string");

    // A negative age must be dropped back to "not provided", never passed
    // through to the rules engine as a literal -5.
    const negAgeRes = await fetch(`${BASE}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: -5, income: -100, occupation: "Farmer" }),
    });
    check("a negative age/income is accepted (sanitized) rather than erroring", negAgeRes.status === 200);

    // GET /api/stats — should reflect the two submissions just logged
    const statsRes = await fetch(`${BASE}/api/stats`);
    const statsBody = await statsRes.json();
    check("GET /api/stats returns 200", statsRes.status === 200);
    check("GET /api/stats counted this run's submissions", statsBody.totalSubmissions >= 2);

    // GET /api/schemes/:id/why — provenance for a known scheme
    const whyRes = await fetch(`${BASE}/api/schemes/pmkisan/why`);
    const whyBody = await whyRes.json();
    check("GET /api/schemes/pmkisan/why returns 200", whyRes.status === 200);
    check("why-response includes plain-English criteria", Array.isArray(whyBody.criteria) && whyBody.criteria.length > 0);

    // GET /api/schemes/:id/why — unknown scheme should 404, not 500
    const whyMissingRes = await fetch(`${BASE}/api/schemes/not-a-real-scheme/why`);
    check("GET /api/schemes/<unknown>/why returns 404", whyMissingRes.status === 404);

    // POST /api/schemes/:id/verify — human-confirmed provenance update
    const verifyRes = await fetch(`${BASE}/api/schemes/pmkisan/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAuthority: "Test Ministry", sourceNote: "smoke test", verifiedAt: "2026-01-01" }),
    });
    const verifyBody = await verifyRes.json();
    check("POST /api/schemes/pmkisan/verify returns 200", verifyRes.status === 200);
    check("verify bumps the version number", verifyBody.scheme && verifyBody.scheme.version >= 2);
  } finally {
    server.kill();
    try { fs.unlinkSync(DB_PATH); } catch (_) { /* fine */ }
    try { fs.unlinkSync(DB_PATH + "-wal"); } catch (_) { /* fine */ }
    try { fs.unlinkSync(DB_PATH + "-shm"); } catch (_) { /* fine */ }
  }

  console.log(`\n${failures === 0 ? "All checks passed." : failures + " check(s) failed."}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
