// rule-engine.js
//
// A small, generic interpreter for declarative eligibility rules. This is
// the piece that lets scheme #17 (or #500) get added as data — an array of
// { field, operator, value } objects — instead of a new `if` statement
// wired into application logic.
//
// A rule reads one field off a citizen's profile and tests it with one
// operator. `evaluateRules` runs a list of rules against a profile and
// passes only if every rule passes (implicit AND — the shape every current
// scheme's population filter already takes: "occupation is Farmer" AND
// "age is between 18 and 50", etc.).
//
// This engine deliberately answers ONE question: "does this profile match
// this shape of rule?" It has no opinion on what a match or a miss *means*
// for a given scheme (eligible vs. needs-verification vs. not-eligible) —
// that verdict, and the human-readable explanation behind it, is domain
// logic and stays in schemes.js. Keeping the split this way means the
// interpreter never has to change just because a new scheme's messaging is
// more nuanced than "pass" or "fail".

const OPERATORS = {
  "equals":  (a, b) => a === b,
  "==":      (a, b) => a === b,
  "!=":      (a, b) => a !== b,
  ">=":      (a, b) => Number.isFinite(a) && a >= b,
  "<=":      (a, b) => Number.isFinite(a) && a <= b,
  ">":       (a, b) => Number.isFinite(a) && a > b,
  "<":       (a, b) => Number.isFinite(a) && a < b,
  // `in` / `not_in` cover the "one of these categories" rules (SC/ST/OBC/EWS,
  // a list of unorganised-sector occupations, etc.) without needing a
  // separate operator per list.
  "in":      (a, b) => Array.isArray(b) && b.includes(a),
  "not_in":  (a, b) => Array.isArray(b) && !b.includes(a),
  // For boolean/presence fields where any truthy answer counts (a self-
  // reported yes, a non-empty string) rather than a specific value.
  "exists":  (a) => a !== undefined && a !== null && a !== "",
};

// Evaluate a single rule against a profile. Throws on an unknown operator
// rather than silently passing or failing — a typo in a rule's `operator`
// should surface immediately (ideally in review/validation, before the
// rule ever reaches a citizen), not quietly let someone through.
function evaluateRule(profile, rule) {
  const fn = OPERATORS[rule.operator];
  if (!fn) {
    throw new Error(`Unknown rule operator "${rule.operator}" (field: ${rule.field})`);
  }
  return !!fn(profile[rule.field], rule.value);
}

// Runs every rule against a profile. `rules` may be undefined/empty, which
// always passes — "no rules" means "applies to everyone" (e.g. a scheme
// like PM-JAY with no population gate at all).
//
// Returns { passed, failedRule }:
//   - passed: true only if every rule matched.
//   - failedRule: the first rule (in array order) the profile didn't
//     satisfy, or null when passed is true. Callers use this to build a
//     specific message ("age 55 is above the 50 ceiling") without
//     re-deriving which condition actually failed.
function evaluateRules(rules, profile) {
  for (const rule of rules || []) {
    if (!evaluateRule(profile, rule)) {
      return { passed: false, failedRule: rule };
    }
  }
  return { passed: true, failedRule: null };
}

module.exports = { evaluateRules, evaluateRule, OPERATORS };
