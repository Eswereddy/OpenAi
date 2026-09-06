// test/unit.test.js
//
// Unit tests for the pure, dependency-free modules: rule-engine.js (the
// declarative rule interpreter), validate.js (the API-boundary sanitizer),
// and levelFor() in schemes.js (Central/State classification). No server,
// no database, no network — these run in milliseconds and pin down the
// exact logic that smoke.js can only observe indirectly through an HTTP
// response.
//
// Uses Node's built-in test runner (available since Node 18) — no new
// dependency, consistent with the rest of this repo's "as little as the
// task actually needs" style. Run with: node --test

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateRule, evaluateRules } = require("../rule-engine");
const { sanitizeProfile } = require("../validate");
const { levelFor, SCHEMES } = require("../schemes");

test("rule-engine: equals / != operators", () => {
  assert.equal(evaluateRule({ occupation: "Farmer" }, { field: "occupation", operator: "equals", value: "Farmer" }), true);
  assert.equal(evaluateRule({ occupation: "Student" }, { field: "occupation", operator: "equals", value: "Farmer" }), false);
  assert.equal(evaluateRule({ occupation: "Student" }, { field: "occupation", operator: "!=", value: "Farmer" }), true);
});

test("rule-engine: numeric comparison operators treat non-numbers as failing, never as passing", () => {
  assert.equal(evaluateRule({ age: 65 }, { field: "age", operator: ">=", value: 60 }), true);
  assert.equal(evaluateRule({ age: 40 }, { field: "age", operator: ">=", value: 60 }), false);
  // age missing entirely (undefined) must never satisfy a >= / <= / > / < rule —
  // this is the exact bug class matchProfile()'s Infinity-for-unknown-income
  // trick exists to prevent one level down, in the engine itself.
  assert.equal(evaluateRule({}, { field: "age", operator: ">=", value: 0 }), false);
  assert.equal(evaluateRule({ age: "sixty" }, { field: "age", operator: ">=", value: 0 }), false);
});

test("rule-engine: in / not_in operators", () => {
  const rule = { field: "category", operator: "in", value: ["SC", "ST", "OBC", "EWS"] };
  assert.equal(evaluateRule({ category: "SC" }, rule), true);
  assert.equal(evaluateRule({ category: "General" }, rule), false);
  assert.equal(evaluateRule({ category: "General" }, { ...rule, operator: "not_in" }), true);
});

test("rule-engine: exists operator rejects undefined/null/empty-string only", () => {
  const rule = { field: "occupation", operator: "exists" };
  assert.equal(evaluateRule({ occupation: "Farmer" }, rule), true);
  assert.equal(evaluateRule({ occupation: "" }, rule), false);
  assert.equal(evaluateRule({}, rule), false);
  assert.equal(evaluateRule({ occupation: 0 }, rule), true); // 0 is a real value, not "missing"
});

test("rule-engine: unknown operator throws rather than silently passing or failing", () => {
  assert.throws(() => evaluateRule({ age: 10 }, { field: "age", operator: "roughly", value: 10 }), /Unknown rule operator/);
});

test("rule-engine: evaluateRules is AND-only and reports the first failing rule", () => {
  const rules = [
    { field: "occupation", operator: "equals", value: "Farmer" },
    { field: "age", operator: ">=", value: 18 },
  ];
  assert.equal(evaluateRules(rules, { occupation: "Farmer", age: 25 }).passed, true);
  const failed = evaluateRules(rules, { occupation: "Farmer", age: 10 });
  assert.equal(failed.passed, false);
  assert.equal(failed.failedRule.field, "age");
});

test("rule-engine: no rules (undefined/empty) always passes — 'applies to everyone'", () => {
  assert.equal(evaluateRules(undefined, {}).passed, true);
  assert.equal(evaluateRules([], { anything: true }).passed, true);
});

test("validate: drops out-of-range numbers instead of clamping them", () => {
  const p = sanitizeProfile({ age: -5, income: 99999 });
  assert.equal(p.age, undefined);
  assert.equal(p.income, undefined);
});

test("validate: keeps 0 as a meaningful value, not a missing one", () => {
  const p = sanitizeProfile({ landholdingAcres: 0 });
  assert.equal(p.landholdingAcres, 0);
});

test("validate: truncates absurdly long strings instead of rejecting the whole field", () => {
  const p = sanitizeProfile({ occupation: "x".repeat(5000) });
  assert.equal(p.occupation.length, 200);
});

test("validate: only allowlisted fields survive — no prototype pollution, no arbitrary passthrough", () => {
  const p = sanitizeProfile({ occupation: "Farmer", __proto__: { polluted: true }, someRandomField: "nope" });
  assert.equal(p.occupation, "Farmer");
  assert.equal(p.someRandomField, undefined);
  assert.equal({}.polluted, undefined);
});

test("validate: non-object / array bodies degrade to an empty profile instead of throwing", () => {
  assert.deepEqual(sanitizeProfile(null), {});
  assert.deepEqual(sanitizeProfile("not an object"), {});
  assert.deepEqual(sanitizeProfile([1, 2, 3]), {});
});

test("levelFor: classifies by department prefix", () => {
  assert.equal(levelFor("Ministry of Agriculture"), "Central");
  assert.equal(levelFor("Government of Andhra Pradesh"), "State — Andhra Pradesh");
  assert.equal(levelFor("Government of Telangana"), "State — Telangana");
  assert.equal(levelFor("State BOCW Welfare Board"), "State (administered per-state)");
  assert.equal(levelFor(undefined), "Central");
});

test("levelFor: every scheme in the live catalog resolves to a real level, never undefined", () => {
  assert.ok(SCHEMES.length > 0);
  for (const s of SCHEMES) {
    assert.equal(typeof s.level, "string");
    assert.ok(s.level.length > 0, `scheme "${s.id}" has an empty level`);
  }
});
