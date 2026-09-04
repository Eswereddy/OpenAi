// validate.js
//
// The rules engine (schemes.js) already defends against MISSING data —
// unknown income becomes Infinity so it can never fake an "eligible"
// result. This file defends against a different problem: BAD data. A
// citizen (or a malformed client, or someone poking the API directly) can
// send age: -5, income: -100, or a 50,000-character "occupation" string,
// and none of that is "missing" — it would sail through matchProfile()
// and either produce a nonsensical result or bloat the submissions table.
//
// This runs once, at the API boundary, before the profile ever reaches
// matchProfile(). It never invents a value the citizen didn't provide —
// an out-of-range or malformed field is dropped back to "not provided"
// (the same state matchProfile already treats as unknown), never clamped
// to a nearby "valid" number that would misrepresent their actual answer.
//
// Field list kept in sync with buildProfile() in public/index.html, which
// is the only real client — if a new conditional field is added there,
// add it here too or it will be silently stripped at the API boundary.

const MAX_STRING_LEN = 200; // generous for any real field (state names, occupation, etc.)
const MAX_AGE = 120;
const MAX_INCOME_LAKHS = 1000; // ₹10 crore/yr — well above any real household income band
const MAX_LANDHOLDING_ACRES = 100000;

function cleanString(v) {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim().slice(0, MAX_STRING_LEN);
  return trimmed.length ? trimmed : undefined;
}

function cleanBoundedNumber(v, { min = 0, max = Infinity } = {}) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  if (n < min || n > max) return undefined; // out of range → treat as not provided, don't clamp
  return n;
}

function cleanBoolean(v) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

const STRING_FIELDS = [
  "gender", "state", "occupation", "category",
  "educationLevel", "classYear", "institutionType", "residenceType", "courseType",
  "disabilityType",
  "landOwnership", "irrigationType", "cropActivity",
  "registrationDuration",
  "employmentStatus", "employmentType",
];
const BOOLEAN_FIELDS = [
  "farmland", "bankAccount", "noPuccaHouse", "disability", "widow",
  "maternity", "hasBplCard", "disabilityCertificate",
  "registeredConstructionWorker", "labourCardAvailable", "epfoEsiCoverage",
];

function sanitizeProfile(rawBody) {
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const profile = {};

  const age = cleanBoundedNumber(body.age, { min: 0, max: MAX_AGE });
  if (age !== undefined) profile.age = age;

  const income = cleanBoundedNumber(body.income, { min: 0, max: MAX_INCOME_LAKHS });
  if (income !== undefined) profile.income = income;

  const disabilityPercentage = cleanBoundedNumber(body.disabilityPercentage, { min: 0, max: 100 });
  if (disabilityPercentage !== undefined) profile.disabilityPercentage = disabilityPercentage;

  // 0 acres is a real, meaningful answer (a landless labourer) — only
  // negative or absurdly large values get dropped, never coerced to
  // "not provided".
  const landholdingAcres = cleanBoundedNumber(body.landholdingAcres, { min: 0, max: MAX_LANDHOLDING_ACRES });
  if (landholdingAcres !== undefined) profile.landholdingAcres = landholdingAcres;

  const previousMarks = cleanBoundedNumber(body.previousMarks, { min: 0, max: 100 });
  if (previousMarks !== undefined) profile.previousMarks = previousMarks;

  for (const field of STRING_FIELDS) {
    const v = cleanString(body[field]);
    if (v !== undefined) profile[field] = v;
  }
  for (const field of BOOLEAN_FIELDS) {
    const v = cleanBoolean(body[field]);
    if (v !== undefined) profile[field] = v;
  }

  return profile;
}

module.exports = { sanitizeProfile };
