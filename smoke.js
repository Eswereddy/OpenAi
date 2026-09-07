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

  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
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

    // POST /api/action-plan — should return a plan (template fallback with
    // no AI key configured in this test run) built from the farmer profile's
    // own matches above, and never 500 regardless of provider config.
    const planRes = await fetch(`${BASE}/api/action-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { occupation: "Farmer", state: "Andhra Pradesh" }, matches: farmerBody.matches, language: "en" }),
    });
    const planBody = await planRes.json();
    check("POST /api/action-plan returns 200", planRes.status === 200);
    check("action-plan response includes a plan string", typeof planBody.plan === "string" && planBody.plan.length > 0);

    // POST /api/agent — the multi-step AI agent (template fallback with no
    // AI key configured in this test run, same as action-plan/checklist
    // above). Should ground its answer in the farmer profile's own matches
    // and always include a trace array, even in the fallback path.
    const agentRes = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "What is my total potential benefit?", matches: farmerBody.matches, language: "en" }),
    });
    const agentBody = await agentRes.json();
    check("POST /api/agent returns 200", agentRes.status === 200);
    check("agent response includes a reply string", typeof agentBody.reply === "string" && agentBody.reply.length > 0);
    check("agent response includes a trace array", Array.isArray(agentBody.trace));

    // POST /api/agent without a question, or without matches, should both
    // be a clean 400 — same boundary-validation standard as every other
    // write-ish endpoint.
    const agentNoQRes = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matches: farmerBody.matches }),
    });
    check("POST /api/agent without question returns 400", agentNoQRes.status === 400);
    const agentNoMatchesRes = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    });
    check("POST /api/agent without matches returns 400", agentNoMatchesRes.status === 400);

    // POST /api/checklist — consolidated document checklist for the same
    // farmer matches; should always return an array (empty is valid too),
    // never error.
    const checklistRes = await fetch(`${BASE}/api/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matches: farmerBody.matches, language: "en" }),
    });
    const checklistBody = await checklistRes.json();
    check("POST /api/checklist returns 200", checklistRes.status === 200);
    check("checklist response is an array", Array.isArray(checklistBody.checklist));
    check(
      "checklist consolidates a known farmer document (Aadhaar) with a tip",
      checklistBody.checklist.some((c) => /aadhaar/i.test(c.document) && typeof c.tip === "string" && c.tip.length > 0)
    );

    // Malformed input (matches missing) on both new endpoints should be a
    // clean 400, not a 500 — same boundary-validation standard as /api/match.
    const planBadRes = await fetch(`${BASE}/api/action-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: {} }),
    });
    check("POST /api/action-plan without matches returns 400", planBadRes.status === 400);
    const checklistBadRes = await fetch(`${BASE}/api/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    check("POST /api/checklist without matches returns 400", checklistBadRes.status === 400);

    // POST /api/parse-profile — "fill by talking". No AI key is set in this
    // test environment, so this exercises the dependency-free heuristic
    // fallback path (see profile-parser.js) rather than a live model call —
    // still enough to catch "the endpoint doesn't start" or "always 500s".
    const parseRes = await fetch(`${BASE}/api/parse-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "I am a 34 year old farmer in Andhra Pradesh with 2 acres and a bank account", language: "en" }),
    });
    const parseBody = await parseRes.json();
    check("POST /api/parse-profile returns 200", parseRes.status === 200);
    check("parse-profile picks up age from free text", parseBody.fields && parseBody.fields.age === 34);
    check("parse-profile picks up state from free text", parseBody.fields && parseBody.fields.state === "Andhra Pradesh");
    check("parse-profile picks up occupation from free text", parseBody.fields && parseBody.fields.occupation === "farmer");

    // Same heuristic path, but in Hindi and Telugu — regression test for the
    // regional-language keyword coverage in profile-parser.js's
    // heuristicParse(). Guards specifically against the "\b won't match a
    // boundary between two non-Latin characters" class of bug (age regex
    // silently matched nothing in either language until this was fixed).
    const parseHiRes = await fetch(`${BASE}/api/parse-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "मैं 34 साल का किसान हूं, आंध्र प्रदेश में, आय लगभग 1.2 लाख सालाना है", language: "hi" }),
    });
    const parseHiBody = await parseHiRes.json();
    check("parse-profile (Hindi) picks up age", parseHiBody.fields && parseHiBody.fields.age === 34);
    check("parse-profile (Hindi) picks up state", parseHiBody.fields && parseHiBody.fields.state === "Andhra Pradesh");
    check("parse-profile (Hindi) picks up occupation", parseHiBody.fields && parseHiBody.fields.occupation === "farmer");
    check("parse-profile (Hindi) picks up income", parseHiBody.fields && parseHiBody.fields.income === 120000);

    const parseTeRes = await fetch(`${BASE}/api/parse-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "నేను ఆంధ్రప్రదేశ్‌లో 34 ఏళ్ల రైతును, ఆదాయం సంవత్సరానికి 1.2 లక్షలు, నాకు 2 ఎకరాలు ఉన్నాయి", language: "te" }),
    });
    const parseTeBody = await parseTeRes.json();
    check("parse-profile (Telugu) picks up age", parseTeBody.fields && parseTeBody.fields.age === 34);
    check("parse-profile (Telugu) picks up state", parseTeBody.fields && parseTeBody.fields.state === "Andhra Pradesh");
    check("parse-profile (Telugu) picks up occupation", parseTeBody.fields && parseTeBody.fields.occupation === "farmer");
    check("parse-profile (Telugu) picks up landHolding", parseTeBody.fields && parseTeBody.fields.landHolding === 2);

    // Template fallbacks (no AI key in this test env) must also produce
    // real Telugu/Hindi text for the other four AI endpoints, not silently
    // fall back to English because of an unrecognised language code.
    const summaryTeRes = await fetch(`${BASE}/api/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: { occupation: "farmer", state: "Andhra Pradesh" },
        matches: [{ id: "pmkisan", status: "eligible", reasons: { met: ["landholding farmer"] } }],
        language: "te",
      }),
    });
    const summaryTeBody = await summaryTeRes.json();
    check("summary (Telugu) template is in Telugu script", /[\u0C00-\u0C7F]/.test(summaryTeBody.summary || ""));

    const checklistTeRes = await fetch(`${BASE}/api/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matches: [{ id: "pmkisan", status: "eligible" }], language: "te" }),
    });
    const checklistTeBody = await checklistTeRes.json();
    const aadhaarTipTe = (checklistTeBody.checklist || []).find((it) => /aadhaar/i.test(it.document));
    check("checklist (Telugu) Aadhaar tip is in Telugu script", !!aadhaarTipTe && /[\u0C00-\u0C7F]/.test(aadhaarTipTe.tip));

    const parseBadRes = await fetch(`${BASE}/api/parse-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    check("POST /api/parse-profile with empty text returns 400", parseBadRes.status === 400);

    // POST /api/schemes/:id/verify — human-confirmed provenance update
    const verifyRes = await fetch(`${BASE}/api/schemes/pmkisan/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAuthority: "Test Ministry", sourceNote: "smoke test", verifiedAt: "2026-01-01" }),
    });
    const verifyBody = await verifyRes.json();
    check("POST /api/schemes/pmkisan/verify returns 200", verifyRes.status === 200);
    check("verify bumps the version number", verifyBody.scheme && verifyBody.scheme.version >= 2);

    // GET /api/impact — NEW FEATURE: homepage impact ticker
    const impactRes = await fetch(`${BASE}/api/impact`);
    const impactBody = await impactRes.json();
    check("GET /api/impact returns 200", impactRes.status === 200);
    check("impact response has citizensHelped/totalBenefitInr fields", typeof impactBody.citizensHelped === "number" && typeof impactBody.totalBenefitInr === "number");
    check("impact reflects this run's submissions", impactBody.citizensHelped >= 1);

    // POST /api/feedback — NEW FEATURE: feedback loop
    const feedbackRes = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemeId: "pmkisan", helpful: true, statusShown: "eligible" }),
    });
    check("POST /api/feedback returns 200", feedbackRes.status === 200);

    const feedbackBadRes = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemeId: "not-a-real-scheme", helpful: true }),
    });
    check("POST /api/feedback with unknown schemeId returns 400", feedbackBadRes.status === 400);

    const feedbackMissingHelpfulRes = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemeId: "pmkisan" }),
    });
    check("POST /api/feedback without helpful returns 400", feedbackMissingHelpfulRes.status === 400);

    const feedbackStatsRes = await fetch(`${BASE}/api/feedback/stats`);
    const feedbackStatsBody = await feedbackStatsRes.json();
    check("GET /api/feedback/stats returns 200", feedbackStatsRes.status === 200);
    const pmkisanFeedback = (feedbackStatsBody.feedback || []).find((f) => f.schemeId === "pmkisan");
    check("feedback stats aggregate the pmkisan vote just recorded", !!pmkisanFeedback && pmkisanFeedback.total >= 1);

    // GET /api/schemes/:id/reminder.ics — NEW FEATURE: "remind me later" calendar file
    const reminderRes = await fetch(`${BASE}/api/schemes/pmkisan/reminder.ics?name=${encodeURIComponent("PM-KISAN")}&status=eligible`);
    const reminderBody = await reminderRes.text();
    check("GET reminder.ics returns 200", reminderRes.status === 200);
    check("reminder.ics has calendar content-type", (reminderRes.headers.get("content-type") || "").includes("text/calendar"));
    check("reminder.ics is a valid VCALENDAR", reminderBody.includes("BEGIN:VCALENDAR") && reminderBody.includes("BEGIN:VALARM") && reminderBody.includes("SUMMARY:Follow up: PM-KISAN"));

    // GET /api/ping — NEW FEATURE: online/offline banner heartbeat
    const pingRes = await fetch(`${BASE}/api/ping`);
    const pingBody = await pingRes.json();
    check("GET /api/ping returns 200", pingRes.status === 200);
    check("ping response includes a timestamp", typeof pingBody.t === "number");

    // An unknown /api/* path must return clean JSON, never an HTML 404 page
    // — a fetch() call in the frontend should never have to sniff a body to
    // know a JSON call failed.
    const unknownApiRes = await fetch(`${BASE}/api/does-not-exist`);
    const unknownApiBody = await unknownApiRes.json();
    check("unknown /api/* route returns JSON 404", unknownApiRes.status === 404 && (unknownApiRes.headers.get("content-type") || "").includes("application/json"));
    check("unknown /api/* route has an error message", typeof unknownApiBody.error === "string" && unknownApiBody.error.length > 0);

    // GET /api/schemes — every scheme must carry a Central/State level tag
    const allSchemes = schemesBody.schemes || [];
    check("every scheme has a non-empty level field", allSchemes.length > 0 && allSchemes.every((s) => typeof s.level === "string" && s.level.length > 0));
    check("at least one scheme is classified State", allSchemes.some((s) => s.level.startsWith("State")));

    // Offline/live parity — public/index.html bundles its own copy of the
    // catalog (LOCAL_SCHEMES) for when /api/match can't be reached. Every
    // scheme id in the live database must also appear in that bundle, or
    // offline citizens silently see fewer results than online ones (this
    // caught a real 8-scheme gap once — keep it as a permanent regression
    // guard, not a one-time check).
    const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const localSchemesMatch = indexHtml.match(/window\.LOCAL_SCHEMES = \(function\(\)\{[\s\S]*?\n\}\)\(\);/);
    const localIds = localSchemesMatch ? [...localSchemesMatch[0].matchAll(/\{\s*id\s*:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]) : [];
    const missingOffline = allSchemes.map((s) => s.id).filter((id) => !localIds.includes(id));
    check("every live scheme also exists in the offline LOCAL_SCHEMES bundle", missingOffline.length === 0);

    // POST /api/schemes/reminder-plans — batch version of the single reminder-plan endpoint
    const reminderPlansRes = await fetch(`${BASE}/api/schemes/reminder-plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["pmkisan", "pmfby"] }),
    });
    const reminderPlansBody = await reminderPlansRes.json();
    check("POST /api/schemes/reminder-plans returns 200", reminderPlansRes.status === 200);
    check("reminder-plans returns a plan per requested id", Array.isArray(reminderPlansBody.plans) && reminderPlansBody.plans.length === 2);

    // POST /api/schemes/reminders/bulk.ics — combined calendar file for several matches
    const bulkIcsRes = await fetch(`${BASE}/api/schemes/reminders/bulk.ics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ schemeId: "pmkisan", schemeName: "PM-KISAN", statusLabel: "Likely eligible" }] }),
    });
    const bulkIcsBody = await bulkIcsRes.text();
    check("POST /api/schemes/reminders/bulk.ics returns 200", bulkIcsRes.status === 200);
    check("bulk.ics is a valid VCALENDAR", bulkIcsBody.includes("BEGIN:VCALENDAR") && bulkIcsBody.includes("SUMMARY:Follow up: PM-KISAN"));

    // POST /api/qrcode — QR code PNG for sharing a result
    const qrRes = await fetch(`${BASE}/api/qrcode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "https://example.com/?ref=test" }),
    });
    const qrBuf = Buffer.from(await qrRes.arrayBuffer());
    check("POST /api/qrcode returns 200", qrRes.status === 200);
    check("qrcode response is a PNG", qrBuf.length > 8 && qrBuf[0] === 0x89 && qrBuf.slice(1, 4).toString() === "PNG");

    // POST /api/summary — falls back to a deterministic template with no AI key configured
    const summaryRes = await fetch(`${BASE}/api/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: { age: 40, occupation: "Farmer", farmland: true },
        matches: [{ id: "pmkisan", status: "eligible", reasons: { met: ["Occupation: Farmer"], watch: [], action: [] } }],
      }),
    });
    const summaryBody = await summaryRes.json();
    check("POST /api/summary returns 200", summaryRes.status === 200);
    check("summary response has non-empty text", typeof summaryBody.summary === "string" && summaryBody.summary.length > 0);
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
