// impact-stats.js
// NEW FEATURE: the homepage "impact ticker" — a live, honest social-proof
// number ("₹X matched so far across Y citizens") built entirely from real
// rows already logged in submissions (db/index.js), never a fabricated or
// hardcoded figure. Additive-only module: it doesn't change db/index.js or
// schemes.js, it just reads from the same SQLite handle and the same
// SCHEME_METADATA those files already export.
//
// The ₹ estimate reuses the exact same "parse a benefit string into a
// number" idea already shipped client-side in public/index.html
// (parseBenefitValue) — reimplemented here server-side so the ticker can be
// computed once per request from real logged matches rather than trusting
// a number the browser sends us. Kept intentionally conservative: recurring
// benefits (e.g. "₹6,000/year") are counted as one year, not a lifetime
// projection, so the number stays defensible rather than inflated.

const { db } = require("./db");
const { SCHEME_METADATA } = require("./schemes");

// Same parsing idea as parseBenefitValue() in public/index.html: pull the
// first rupee figure out of a free-text benefit description. "up to ₹2.67
// lakh" -> 267000, "₹6,000/year" -> 6000, "₹5 lakh/year health cover" ->
// 500000. Falls back to 0 for benefits with no extractable number (e.g.
// pure non-cash support), which just means that scheme contributes 0 to
// the rupee total while still counting toward "citizens helped".
function parseBenefitValue(benefit) {
  if (!benefit || typeof benefit !== "string") return 0;
  const lakhMatch = benefit.match(/([\d,]+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) return Math.round(parseFloat(lakhMatch[1].replace(/,/g, "")) * 100000);
  const croreMatch = benefit.match(/([\d,]+(?:\.\d+)?)\s*crore/i);
  if (croreMatch) return Math.round(parseFloat(croreMatch[1].replace(/,/g, "")) * 10000000);
  const plainMatch = benefit.match(/₹\s*([\d,]+(?:\.\d+)?)/);
  if (plainMatch) return Math.round(parseFloat(plainMatch[1].replace(/,/g, "")));
  return 0;
}

const BENEFIT_VALUE_BY_ID = Object.fromEntries(
  SCHEME_METADATA.map((s) => [s.id, parseBenefitValue(s.benefit)])
);

// Cached for a short window — this runs a full table scan over submissions
// on every call, which is fine at hackathon/demo scale but pointless to
// redo on every homepage load within the same few seconds.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 15_000;

function computeImpact() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;

  const rows = db.prepare("SELECT matched_scheme_ids FROM submissions").all();
  let citizensHelped = 0;
  let totalMatches = 0;
  let totalBenefitInr = 0;

  for (const row of rows) {
    let ids = [];
    try { ids = JSON.parse(row.matched_scheme_ids || "[]"); } catch (_) { ids = []; }
    if (!Array.isArray(ids) || ids.length === 0) continue;
    citizensHelped++;
    totalMatches += ids.length;
    for (const id of ids) totalBenefitInr += BENEFIT_VALUE_BY_ID[id] || 0;
  }

  cache = {
    citizensHelped,
    totalMatches,
    totalBenefitInr,
    schemesIndexed: SCHEME_METADATA.length,
    // Rounded, human copy the frontend can show directly without doing its
    // own crore/lakh math.
    totalBenefitDisplay: formatInr(totalBenefitInr),
  };
  cacheAt = now;
  return cache;
}

function formatInr(n) {
  if (!n || n <= 0) return "₹0";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(n >= 100000000 ? 0 : 1)} crore`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(n >= 1000000 ? 0 : 1)} lakh`;
  return `₹${n.toLocaleString("en-IN")}`;
}

module.exports = { computeImpact };
