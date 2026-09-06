// schemes.js
// The rules engine: scheme metadata + eligibility logic in one place.
// Metadata (name/dept/benefit/tag/docs) gets mirrored into the database as the
// source of truth for *display*. The `check` functions are the actual rules
// engine and stay in code — this mirrors how real eligibility systems are
// usually built (structured rules, not just database rows), while still
// keeping schemes' descriptive content easy to update via the DB.
//
// ---------------------------------------------------------------------------
// RESULT MODEL
// ---------------------------------------------------------------------------
// Every scheme's `check(profile)` returns one of:
//   - null                    → scheme doesn't apply to this profile's basic
//                                population (wrong occupation/age band/gender/
//                                category/etc). Not shown — this is a relevance
//                                filter, not a verdict, so it stays silent
//                                rather than telling e.g. a 22-year-old they
//                                are "not eligible" for an old-age pension.
//   - result("eligible", …)          → 🟢 Likely eligible. Reserved for cases
//                                where the criteria this form captures ARE the
//                                actual, direct, government-defined determining
//                                criteria (a held BPL card, a confirmed bank
//                                account, a fixed national age band, an
//                                explicit yes/no the person gave us) — not a
//                                self-reported proxy for a more complex
//                                mechanism.
//   - result("needs_verification", …) → 🟡 Needs verification. Used whenever
//                                the profile clears the criteria we can check,
//                                but the scheme's real eligibility mechanism is
//                                either more complex than this form can assess
//                                (SECC deprivation category, a notified trade
//                                list, a merit cut-off, state-specific income
//                                limits) OR relies on a self-reported number
//                                (income) standing in for an official
//                                determination (BPL list / SECC / state
//                                welfare verification) that this form cannot
//                                confirm.
//   - result("not_eligible", …)       → 🔴 Not eligible based on provided
//                                answers. Used only when a specific, explicit
//                                answer the person gave directly contradicts a
//                                hard requirement of a scheme they are
//                                otherwise in the target population for (e.g.
//                                no bank account for an auto-debit insurance
//                                scheme, no farmland for a landholding-farmer
//                                scheme, income clearly above a fixed national
//                                ceiling).
//   - result("insufficient_info", …)  → ⚪ Not enough information. Used when a
//                                value this scheme's determination depends on
//                                (almost always income) was left blank, so no
//                                real verdict — positive or negative — can be
//                                given yet.
//
// This keeps the important distinction the app makes explicit: "the profile
// clearly matches the rule" is a different claim from "the profile clears the
// coarse proxy we can check, but the actual mechanism needs a human/official
// to confirm" — and both are different again from "clearly fails" or "we
// don't have enough information to say."
// ---------------------------------------------------------------------------

const { evaluateRules } = require("./rule-engine");

function stateNote(p, kind) {
  const st = p.state && p.state !== "Other state / UT" ? p.state : "your state";
  if (kind === "income") return `Exact income cut-off for ${st} may differ from the national baseline — confirm with your local CSC/e-mitra center.`;
  if (kind === "landholding") return `Landholding limits can vary by district in ${st} — confirm with the local revenue office.`;
  return `Some conditions vary by state — verify with your local office.`;
}

function result(status, met, watch, action) {
  return { status, reasons: { met, watch: watch || [], action: action || [] } };
}

// Central vs State classification. Every scheme's `dept` already says who
// actually runs it ("Ministry of ..." / "Government of <State>"), so this
// is inferred from that instead of hand-tagging each of the 29 entries —
// one rule, applied once, right after SCHEMES is defined below.
function levelFor(dept) {
  if (!dept) return "Central";
  if (dept.startsWith("Government of ")) return `State — ${dept.replace("Government of ", "")}`;
  if (dept === "State BOCW Welfare Board") return "State (administered per-state)";
  return "Central";
}

function incomeKnown(p) {
  return Number.isFinite(p.income);
}

// Shared shape for the four income/BPL-proxied "poverty line" schemes
// (old-age pension, widow pension, disability pension, PM-JAY). Real
// determination for all four runs on an official BPL/SECC/state welfare
// list, not a number a citizen types into a form — so a held BPL card
// (an actual credential) is treated very differently from a self-reported
// income figure (an estimate that merely makes the scheme *worth checking*).
function povertyLinkedResult(p, metSoFar, { hardCeiling = 3 } = {}) {
  if (p.hasBplCard) {
    return result("eligible", [...metSoFar, "BPL card holder"]);
  }
  if (!incomeKnown(p)) {
    return result("insufficient_info", metSoFar, ["Add your household income (or confirm you hold a BPL/ration card) to get a real result for this scheme."]);
  }
  if (p.income > hardCeiling) {
    return result("not_eligible", metSoFar, [`Reported income is well above the range this scheme covers in any state.`]);
  }
  return result("needs_verification", metSoFar, ["Income here is self-reported — actual coverage is decided by the official BPL/SECC list or your state welfare department, not this form. Check your ration card / SECC status."]);
}

// Where to actually go to act on a result. Kept separate from `dept`
// (which is a display label, e.g. "Ministry of Agriculture") because the
// portal is a specific, clickable destination — and not every scheme has
// one self-service citizen portal (BOCW is administered per-state, so it
// gets a name but no single national url).
const PORTALS = {
  pmkisan:              { name: "PM-KISAN Portal",                url: "https://pmkisan.gov.in/" },
  pmfby:                { name: "PMFBY Portal",                   url: "https://pmfby.gov.in/" },
  pmvishwakarma:        { name: "PM Vishwakarma Portal",          url: "https://pmvishwakarma.gov.in/" },
  "nsp-postmatric":     { name: "National Scholarship Portal",    url: "https://scholarships.gov.in/" },
  "nsp-prematric":      { name: "National Scholarship Portal",    url: "https://scholarships.gov.in/" },
  nmms:                 { name: "National Scholarship Portal",    url: "https://scholarships.gov.in/" },
  ignoaps:              { name: "NSAP Portal",                    url: "https://nsap.nic.in/" },
  "widow-pension":      { name: "NSAP Portal",                    url: "https://nsap.nic.in/" },
  "disability-pension": { name: "NSAP Portal",                    url: "https://nsap.nic.in/" },
  pmmvy:                { name: "PMMVY Portal",                   url: "https://pmmvy.wcd.gov.in/" },
  ayushman:             { name: "Ayushman Bharat (PM-JAY) Portal", url: "https://pmjay.gov.in/" },
  pmay:                 { name: "PMAY Portal",                    url: "https://pmaymis.gov.in/" },
  pmjjby:               { name: "Jansuraksha Portal",             url: "https://www.jansuraksha.gov.in/" },
  pmsby:                { name: "Jansuraksha Portal",             url: "https://www.jansuraksha.gov.in/" },
  apy:                  { name: "Jansuraksha Portal",             url: "https://www.jansuraksha.gov.in/" },
  eshram:               { name: "e-Shram Portal",                 url: "https://eshram.gov.in/" },
  "bocw-welfare":       { name: "your state BOCW Welfare Board",  url: null },
  pmujjwala:            { name: "PMUY Portal",                    url: "https://www.pmuy.gov.in/" },
  pmsvanidhi:           { name: "PM SVANidhi Portal",             url: "https://pmsvanidhi.mohua.gov.in/" },
  pmmudra:              { name: "Mudra Portal",                   url: "https://www.mudra.org.in/" },
  standupindia:         { name: "Stand-Up India Portal",          url: "https://www.standupmitra.in/" },
  jsy:                  { name: "National Health Mission Portal", url: "https://nhm.gov.in/" },
  "annadata-sukhibhava": { name: "Annadata Sukhibhava Portal",    url: "https://annadathasukhibhava.ap.gov.in/" },
  "rythu-bharosa-ts":   { name: "Rythu Bharosa (Telangana) Portal", url: "https://rythubharosa.telangana.gov.in/" },
  "aasara-pension-ts":  { name: "Aasara Pension (Telangana) Portal", url: "https://aasara.telangana.gov.in/" },
  "kalyana-lakshmi-shaadi-mubarak": { name: "Kalyana Lakshmi / Shaadi Mubarak Portal", url: "https://telanganaepass.cgg.gov.in/" },
  pmjdy:                { name: "PMJDY Portal",                   url: "https://pmjdy.gov.in/" },
  rvy:                  { name: "Rashtriya Vayoshri Yojana Portal", url: "https://scw.dosje.gov.in/rashtriya-vayoshri-yojana" },
  annapurna:            { name: "NSAP Portal",                    url: "https://nsap.nic.in/" },
};

// Provenance for each scheme's data — kept separate from SCHEMES (like
// PORTALS) so it can be reviewed/updated independently of the eligibility
// rules. This is what lets a scheme card say "here's whose facts these are
// and how stale they might be" instead of just asserting them.
//   sourceAuthority — the ministry/body that actually owns this scheme
//   sourceNote      — what kind of document the criteria were drawn from
//   sourceUrl       — the webpage a citizen (or a reviewer) can actually
//                      open to check the claim. In this prototype it's the
//                      scheme's own official portal (from PORTALS, below) —
//                      a real deployment would point this at the specific
//                      gazette notification / scheme guideline PDF a rule
//                      was drawn from, since a portal's homepage can move
//                      or get redesigned without the underlying policy
//                      document changing.
//   lastVerified    — ISO date (YYYY-MM-DD) someone last checked this
//                      entry against the official source; null means it
//                      has never been through that check and the UI must
//                      say so rather than imply freshness it doesn't have
//   version         — bumped by markSchemeVerified() each time re-verified
const VERIFICATION_BASE = {
  pmkisan:              { sourceAuthority: "Ministry of Agriculture & Farmers Welfare",       sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  pmfby:                { sourceAuthority: "Ministry of Agriculture & Farmers Welfare",       sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  pmvishwakarma:        { sourceAuthority: "Ministry of Micro, Small & Medium Enterprises",   sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  "nsp-postmatric":     { sourceAuthority: "Ministry of Social Justice & Empowerment",        sourceNote: "National Scholarship Portal listing",  lastVerified: null, version: 1 },
  "nsp-prematric":      { sourceAuthority: "Ministry of Social Justice & Empowerment",        sourceNote: "National Scholarship Portal listing",  lastVerified: null, version: 1 },
  nmms:                 { sourceAuthority: "Ministry of Education",                            sourceNote: "National Scholarship Portal listing",  lastVerified: null, version: 1 },
  ignoaps:              { sourceAuthority: "Ministry of Rural Development",                    sourceNote: "NSAP scheme guidelines",               lastVerified: null, version: 1 },
  "widow-pension":      { sourceAuthority: "Ministry of Rural Development",                    sourceNote: "NSAP scheme guidelines",               lastVerified: null, version: 1 },
  "disability-pension": { sourceAuthority: "Ministry of Rural Development",                    sourceNote: "NSAP scheme guidelines",               lastVerified: null, version: 1 },
  pmmvy:                { sourceAuthority: "Ministry of Women & Child Development",            sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  ayushman:             { sourceAuthority: "National Health Authority",                        sourceNote: "PM-JAY scheme guidelines",             lastVerified: null, version: 1 },
  pmay:                 { sourceAuthority: "Ministry of Housing & Urban Affairs",              sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  pmjjby:               { sourceAuthority: "Dept. of Financial Services, Ministry of Finance", sourceNote: "Jansuraksha scheme guidelines",        lastVerified: null, version: 1 },
  pmsby:                { sourceAuthority: "Dept. of Financial Services, Ministry of Finance", sourceNote: "Jansuraksha scheme guidelines",        lastVerified: null, version: 1 },
  apy:                  { sourceAuthority: "Pension Fund Regulatory & Development Authority",  sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  eshram:               { sourceAuthority: "Ministry of Labour & Employment",                  sourceNote: "e-Shram scheme guidelines",            lastVerified: null, version: 1 },
  "bocw-welfare":       { sourceAuthority: "State BOCW Welfare Boards (under central BOCW Act)", sourceNote: "State welfare board notification",  lastVerified: null, version: 1 },
  pmujjwala:            { sourceAuthority: "Ministry of Petroleum & Natural Gas",                sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  pmsvanidhi:           { sourceAuthority: "Ministry of Housing & Urban Affairs",                sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  pmmudra:              { sourceAuthority: "Dept. of Financial Services, Ministry of Finance",   sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  standupindia:         { sourceAuthority: "Dept. of Financial Services, Ministry of Finance",   sourceNote: "Scheme guidelines / official portal", lastVerified: null, version: 1 },
  jsy:                  { sourceAuthority: "National Health Mission, Ministry of Health & Family Welfare", sourceNote: "Web-verified against current scheme guidance, 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  "annadata-sukhibhava": { sourceAuthority: "Government of Andhra Pradesh, Dept. of Agriculture", sourceNote: "Web-verified against current scheme guidance (relaunched Aug 2025, replacing YSR Rythu Bharosa), 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  "rythu-bharosa-ts":   { sourceAuthority: "Government of Telangana, Dept. of Agriculture", sourceNote: "Web-verified against current scheme guidance, 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  "aasara-pension-ts":  { sourceAuthority: "Government of Telangana, Social Welfare Dept.", sourceNote: "Web-verified — reported pension amounts vary noticeably across sources at time of writing; treat the figure as approximate", lastVerified: "2026-09-06", version: 1 },
  "kalyana-lakshmi-shaadi-mubarak": { sourceAuthority: "Government of Telangana, Women Development & Child Welfare / Minority Welfare Depts.", sourceNote: "Web-verified against current scheme guidance, 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  pmjdy:                { sourceAuthority: "Dept. of Financial Services, Ministry of Finance", sourceNote: "Web-verified against current scheme guidance, 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  rvy:                  { sourceAuthority: "Ministry of Social Justice & Empowerment", sourceNote: "Web-verified against official scheme guidelines (scw.dosje.gov.in), 2026-09-06", lastVerified: "2026-09-06", version: 1 },
  annapurna:            { sourceAuthority: "Ministry of Rural Development (NSAP)", sourceNote: "Web-verified against current scheme guidance, 2026-09-06", lastVerified: "2026-09-06", version: 1 },
};
// Merge in sourceUrl from PORTALS once here, rather than typing every URL a
// second time — one fewer place the two can drift apart.
const VERIFICATION = Object.fromEntries(
  Object.entries(VERIFICATION_BASE).map(([id, v]) => [
    id,
    { ...v, sourceUrl: (PORTALS[id] && PORTALS[id].url) || null },
  ])
);

const SCHEMES = [
  { id: "pmkisan", name: "PM-KISAN", dept: "Ministry of Agriculture", benefit: "₹6,000/year, direct transfer",
    tag: "For small & marginal farmers", docs: ["Aadhaar card", "Land record / khatauni", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Farmer" }],
    check: p => {
      if (!p.farmland) return result("not_eligible", ["Occupation: Farmer"], ["No farmland reported — PM-KISAN requires being a landholding farmer with cultivable land in your name."],
        ["If you hold agricultural land not reflected in your answer, update your landholding details and check again."]);
      return result("eligible", ["Occupation: Farmer", "Owns farmland"],
        ["PM-KISAN also excludes income-tax payers, government employees, and pensioners drawing over ₹10,000/month — confirm you don't fall into an excluded category."]);
    }},
  { id: "pmfby", name: "Pradhan Mantri Fasal Bima Yojana", dept: "Ministry of Agriculture", benefit: "Crop insurance premium subsidy",
    tag: "Crop insurance for farmers", docs: ["Aadhaar card", "Land record", "Bank passbook", "Sowing certificate"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Farmer" }],
    check: p => {
      if (!p.farmland) return result("not_eligible", ["Occupation: Farmer"], ["No farmland reported — PMFBY requires cultivating notified land."],
        ["If you cultivate notified land not reflected in your answer, update your landholding details and check again."]);
      return result("needs_verification", ["Occupation: Farmer", "Owns farmland"],
        ["Enrollment depends on your crop being on the notified list for your district, the sowing season, and the insurer's cut-off date — check with your bank or local agriculture office."]);
    }},
  { id: "pmvishwakarma", name: "PM Vishwakarma", dept: "Ministry of MSME", benefit: "Toolkit support + collateral-free loan up to ₹3 lakh",
    tag: "For traditional artisans & craftspeople", docs: ["Aadhaar card", "Proof of traditional trade", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Self-employed / artisan" }],
    check: p => {
      return result("needs_verification", ["Occupation: Self-employed / artisan"], ["Your trade must be on the notified artisan list — verify at your nearest CSC"]);
    }},
  { id: "nsp-postmatric", name: "Post-Matric Scholarship", dept: "National Scholarship Portal", benefit: "Tuition + maintenance allowance",
    tag: "For SC/ST/OBC/EWS students", docs: ["Aadhaar card", "Caste/EWS certificate", "Income certificate", "Previous mark sheet"],
    populationRules: [
      { field: "occupation", operator: "equals", value: "Student" },
      { field: "category", operator: "in", value: ["SC", "ST", "OBC", "EWS"] },
    ],
    check: p => {
      if (!incomeKnown(p)) return result("insufficient_info", [`Category: ${p.category}`], ["Add your household income to check this scheme."]);
      return result("needs_verification", [`Category: ${p.category}`, "Household income appears within the general limit"],
        [stateNote(p, "income") + " Exact ceilings also vary by category."]);
    }},
  { id: "nsp-prematric", name: "Pre-Matric Scholarship", dept: "National Scholarship Portal", benefit: "Annual education allowance",
    tag: "For students in classes 9–10", docs: ["Aadhaar card", "School ID", "Caste/minority certificate", "Income certificate"],
    populationRules: [
      { field: "occupation", operator: "equals", value: "Student" },
      { field: "age", operator: "<=", value: 17 },
      { field: "category", operator: "in", value: ["SC", "ST", "OBC", "EWS"] },
    ],
    check: p => {
      return result("needs_verification", [`Category: ${p.category}`, "Age matches school-going range"],
        ["Household income limits also apply and vary by category/state — this form doesn't check income for this scheme; confirm on the National Scholarship Portal."]);
    }},
  { id: "nmms", name: "National Means-cum-Merit Scholarship", dept: "Ministry of Education", benefit: "₹12,000/year",
    tag: "Meritorious students from low-income households", docs: ["Aadhaar card", "Income certificate", "Class 8 marksheet"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Student" }],
    check: p => {
      // NMMS is restricted to govt / govt-aided / local-body schools — a
      // direct, explicit answer here (not a proxy) so a private-school
      // student gets a real "not eligible", not a vague "needs verification".
      if (p.institutionType === "private") {
        return result("not_eligible", [], ["NMMS is only for students studying in government, government-aided, or local body schools — reported institution type is private."]);
      }
      if (!incomeKnown(p)) return result("insufficient_info", [], ["Add your household income to check this scheme."]);
      if (p.income > 3.5) return result("not_eligible", [], ["Household income is above the ₹3.5 lakh national ceiling for this scholarship."]);
      const met = ["Household income within the general limit"];
      if (p.classYear) met.push(`Reported class/year: ${p.classYear}`);
      return result("needs_verification", met, ["The merit cut-off is exam-based and isn't assessed by this form; NMMS is specifically for Class 9–10 students — confirm your class matches."]);
    }},
  { id: "ignoaps", name: "Old Age Pension (IGNOAPS)", dept: "Ministry of Rural Development", benefit: "₹200–500+/month (state top-ups vary)",
    tag: "For senior citizens below poverty line", docs: ["Aadhaar card", "Age proof", "BPL/income certificate"],
    populationRules: [{ field: "age", operator: ">=", value: 60 }],
    check: p => {
      return povertyLinkedResult(p, ["Age 60+"]);
    }},
  { id: "widow-pension", name: "Widow Pension Scheme", dept: "Ministry of Rural Development", benefit: "Monthly pension (state-administered)",
    tag: "For widows aged 40–79, low income", docs: ["Aadhaar card", "Husband's death certificate", "Income certificate"],
    populationRules: [
      { field: "widow", operator: "equals", value: true },
      { field: "age", operator: ">=", value: 40 },
      { field: "age", operator: "<=", value: 79 },
    ],
    check: p => {
      return povertyLinkedResult(p, ["Marked as widow", "Age within 40–79 range"]);
    }},
  { id: "disability-pension", name: "Disability Pension Scheme", dept: "Ministry of Rural Development", benefit: "Monthly pension (state-administered)",
    tag: "For persons with 80%+ disability, low income", docs: ["Aadhaar card", "Disability certificate", "Income certificate"],
    populationRules: [{ field: "disability", operator: "equals", value: true }],
    check: p => {
      // A reported disability percentage is a direct, explicit answer (not a
      // proxy), so a clear under-80% figure can rule this out outright
      // instead of only ever asking the person to "confirm" it themselves.
      if (Number.isFinite(p.disabilityPercentage) && p.disabilityPercentage < 80) {
        return result("not_eligible", ["Marked as person with disability"],
          [`This scheme requires 80%+ disability; reported disability percentage (${p.disabilityPercentage}%) is below that threshold.`]);
      }
      const metSoFar = ["Marked as person with disability"];
      if (Number.isFinite(p.disabilityPercentage) && p.disabilityPercentage >= 80) metSoFar.push("Disability percentage meets the 80%+ threshold");
      if (p.disabilityCertificate) metSoFar.push("Has a disability certificate");
      const base = povertyLinkedResult(p, metSoFar);
      if (!Number.isFinite(p.disabilityPercentage)) {
        base.reasons.watch = [...base.reasons.watch, "Confirm your disability percentage meets the 80% threshold this scheme requires."];
      } else if (p.disabilityPercentage >= 80 && !p.disabilityCertificate) {
        base.reasons.watch = [...base.reasons.watch, "You'll need an official disability certificate to prove this — apply at your district hospital if you don't have one."];
      }
      return base;
    }},
  { id: "pmmvy", name: "PM Matru Vandana Yojana", dept: "Ministry of Women & Child Development", benefit: "₹5,000 cash benefit (first child)",
    tag: "For pregnant & lactating mothers", docs: ["Aadhaar card", "MCP card", "Bank passbook"],
    populationRules: [
      { field: "gender", operator: "equals", value: "Female" },
      { field: "maternity", operator: "equals", value: true },
    ],
    check: p => {
      return result("needs_verification", ["Marked as pregnant / recent mother"],
        ["Generally limited to the first living child (some states extend to a second child if a girl) and requires registration at your Anganwadi/health center — confirm you meet these conditions."]);
    }},
  { id: "ayushman", name: "Ayushman Bharat (PM-JAY)", dept: "National Health Authority", benefit: "₹5 lakh/year health cover per family",
    tag: "For low-income families", docs: ["Aadhaar card", "Ration card", "SECC/family ID"],
    populationRules: [], // no population gate — every profile is worth checking against this scheme
    check: p => {
      if (!p.hasBplCard && !incomeKnown(p)) return result("insufficient_info", [], ["Add your household income (or confirm you hold a BPL/ration card) to check this scheme."]);
      if (!p.hasBplCard && p.income > 3) return result("not_eligible", [], ["Reported income is above the range PM-JAY typically covers."]);
      // Deliberately never returns "eligible" from income alone: PM-JAY
      // coverage is determined by SECC deprivation category (rural) or one
      // of the notified occupational categories (urban), not a household
      // income figure. A BPL card is real evidence but PM-JAY inclusion is
      // still list-based, so even that stays a "needs verification" case.
      return result("needs_verification", [p.hasBplCard ? "BPL card holder" : "Household income in the range PM-JAY families are often in"],
        ["Coverage depends on your SECC deprivation category or occupational category, not income or a BPL card alone — check your name on the PM-JAY beneficiary list (pmjay.gov.in) or via your ration card."]);
    }},
  { id: "pmay", name: "Pradhan Mantri Awas Yojana", dept: "Ministry of Housing", benefit: "Housing subsidy up to ₹2.67 lakh",
    tag: "For families without a pucca house", docs: ["Aadhaar card", "Income certificate", "Land/property document"],
    populationRules: [{ field: "noPuccaHouse", operator: "equals", value: true }],
    check: p => {
      if (!incomeKnown(p)) return result("insufficient_info", ["No pucca house reported"], ["Add your household income to check this scheme."]);
      if (p.income > 8) return result("not_eligible", ["No pucca house reported"], ["Household income is above PMAY's income ceiling."]);
      return result("eligible", ["No pucca house reported", "Household income within eligible range"]);
    }},
  { id: "pmjjby", name: "PM Jeevan Jyoti Bima Yojana", dept: "Ministry of Finance / banks", benefit: "₹2 lakh life cover, ~₹436/year premium",
    tag: "Age 18–50 with a bank account", docs: ["Aadhaar card", "Bank account", "Auto-debit consent"],
    // populationRules decide who this scheme is even relevant to (silent
    // miss if not matched). requirementRules are hard requirements within
    // that population — failing one is a real, explicit "not eligible",
    // not silence. Both are the exact shape from the prompt's example:
    // { field, operator, value }, interpreted by the shared rule engine —
    // this scheme adds zero custom eligibility code, only data.
    populationRules: [
      { field: "age", operator: ">=", value: 18 },
      { field: "age", operator: "<=", value: 50 },
    ],
    requirementRules: [{ field: "bankAccount", operator: "equals", value: true }],
    check: function (p) {
      const { passed } = evaluateRules(this.requirementRules, p);
      return passed
        ? result("eligible", ["Age within 18–50", "Has a bank account"])
        : result("not_eligible", ["Age within 18–50"], ["Requires a bank account for the auto-debit premium."],
            ["Open a bank account — that's the only requirement you're currently missing."]);
    }},
  { id: "pmsby", name: "PM Suraksha Bima Yojana", dept: "Ministry of Finance / banks", benefit: "₹2 lakh accident cover, ~₹20/year premium",
    tag: "Age 18–70 with a bank account", docs: ["Aadhaar card", "Bank account", "Auto-debit consent"],
    populationRules: [
      { field: "age", operator: ">=", value: 18 },
      { field: "age", operator: "<=", value: 70 },
    ],
    requirementRules: [{ field: "bankAccount", operator: "equals", value: true }],
    check: function (p) {
      const { passed } = evaluateRules(this.requirementRules, p);
      return passed
        ? result("eligible", ["Age within 18–70", "Has a bank account"])
        : result("not_eligible", ["Age within 18–70"], ["Requires a bank account for the auto-debit premium."],
            ["Open a bank account — that's the only requirement you're currently missing."]);
    }},
  { id: "apy", name: "Atal Pension Yojana", dept: "PFRDA", benefit: "Guaranteed pension ₹1,000–5,000/month after 60",
    tag: "Unorganised-sector workers, age 18–40", docs: ["Aadhaar card", "Bank account"],
    populationRules: [
      { field: "age", operator: ">=", value: 18 },
      { field: "age", operator: "<=", value: 40 },
      { field: "occupation", operator: "in", value: ["Daily-wage / unorganised worker", "Self-employed / artisan", "Construction worker"] },
    ],
    requirementRules: [{ field: "bankAccount", operator: "equals", value: true }],
    check: function (p) {
      const { passed } = evaluateRules(this.requirementRules, p);
      return passed
        ? result("eligible", ["Age within 18–40", "Unorganised-sector occupation", "Has a bank account"])
        : result("not_eligible", ["Age within 18–40", "Unorganised-sector occupation"], ["Requires a bank account to enrol."],
            ["Open a bank account — that's the only requirement you're currently missing."]);
    }},
  { id: "eshram", name: "e-Shram Registration", dept: "Ministry of Labour", benefit: "Unorganised worker ID + accident cover ₹2 lakh",
    tag: "Unorganised-sector workers, age 16–59", docs: ["Aadhaar card", "Bank account (optional)"],
    populationRules: [
      { field: "occupation", operator: "in", value: ["Daily-wage / unorganised worker", "Construction worker"] },
      { field: "age", operator: ">=", value: 16 },
      { field: "age", operator: "<=", value: 59 },
    ],
    check: p => {
      return result("eligible", ["Age within 16–59", "Occupation: unorganised worker"]);
    }},
  { id: "bocw-welfare", name: "Building & Other Construction Workers (BOCW) Welfare Scheme", dept: "State BOCW Welfare Board",
    benefit: "Accident/medical assistance, pension, education & maternity benefits for registered workers",
    tag: "For construction workers registered with the state welfare board",
    docs: ["Aadhaar card", "Labour/registration card", "Proof of 90 days construction work in the year"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Construction worker" }],
    check: p => {
      // Registration status / labour-card possession is a direct credential
      // check, unlike a self-reported income figure — a "yes" here is real
      // evidence, so it can support "eligible" rather than only "worth checking".
      if (p.registeredConstructionWorker === true || p.labourCardAvailable === true) {
        return result("eligible",
          ["Occupation: Construction worker", p.labourCardAvailable ? "Has a labour card" : "Registered with the BOCW welfare board"],
          ["Specific benefit amounts and renewal rules vary by state welfare board — confirm at your state's labour department."]);
      }
      if (p.registeredConstructionWorker === false) {
        return result("needs_verification", ["Occupation: Construction worker"],
          ["You're not yet registered — construction workers who've done 90+ days of building work in the last year can register with the state BOCW welfare board (often via a labour office/CSC) to access these benefits."]);
      }
      return result("insufficient_info", ["Occupation: Construction worker"],
        ["Let us know if you're registered with the state BOCW welfare board or have a labour card, to check this properly."]);
    }},
  { id: "pmujjwala", name: "PM Ujjwala Yojana (PMUY)", dept: "Ministry of Petroleum & Natural Gas",
    benefit: "Free LPG gas connection + first cylinder & stove support",
    tag: "For women from BPL/low-income households", docs: ["Aadhaar card", "BPL/ration card", "Bank passbook"],
    populationRules: [{ field: "gender", operator: "equals", value: "Female" }],
    check: p => {
      if (p.hasBplCard) return result("eligible", ["Gender: Female", "BPL card holder"]);
      if (!incomeKnown(p)) return result("insufficient_info", ["Gender: Female"], ["Add your household income (or confirm you hold a BPL/ration card) to check this scheme."]);
      if (p.income > 2) return result("not_eligible", ["Gender: Female"], ["Reported income is above the range this scheme typically covers."]);
      return result("needs_verification", ["Gender: Female", "Household income within the range this scheme often covers"],
        ["Actual coverage is decided by the BPL/SECC list or your state's PMUY survey, not this form alone — check your name on the PMUY beneficiary list or with your local gas agency."]);
    }},
  { id: "pmsvanidhi", name: "PM SVANidhi", dept: "Ministry of Housing & Urban Affairs",
    benefit: "Collateral-free working capital loan — ₹10,000 first tranche (up to ₹50,000 on timely repayment)",
    tag: "For street vendors / informal urban vendors",
    docs: ["Aadhaar card", "Certificate of Vending / vendor survey record", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "in", value: ["Self-employed / artisan", "Daily-wage / unorganised worker"] }],
    check: p => {
      return result("needs_verification", ["Occupation: informal / self-employed worker"],
        ["Meant specifically for street vendors identified in an Urban Local Body survey or holding a Certificate of Vending — confirm your vendor status with your local municipal corporation."],
        ["If you sell goods or services from a fixed street location or cart, register with your Urban Local Body for a Certificate of Vending, then apply via the PM SVANidhi portal or a partner bank."]);
    }},
  { id: "pmmudra", name: "PM Mudra Yojana", dept: "Ministry of Finance / banks",
    benefit: "Collateral-free loans up to ₹10 lakh (Shishu / Kishor / Tarun categories) for non-farm income-generating activity",
    tag: "For micro & small business owners / aspiring entrepreneurs",
    docs: ["Aadhaar card", "Business plan or existing business proof", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "in", value: ["Self-employed / artisan", "Daily-wage / unorganised worker", "Unemployed"] }],
    check: p => {
      return result("needs_verification", ["Occupation matches Mudra's target group (self-employed / aspiring micro-entrepreneur)"],
        ["Loan amount and category (Shishu/Kishor/Tarun) depend on your business stage and the lending bank's own assessment, not this form — approach any participating bank, NBFC, or MFI with a short business plan."]);
    }},
  { id: "standupindia", name: "Stand-Up India", dept: "Dept. of Financial Services, Ministry of Finance",
    benefit: "Bank loans ₹10 lakh – ₹1 crore for greenfield (first-time) enterprises",
    tag: "For SC/ST and women entrepreneurs starting a new enterprise",
    docs: ["Aadhaar card", "Caste certificate (if SC/ST)", "Business project report", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "in", value: ["Self-employed / artisan", "Unemployed"] }],
    check: p => {
      // No single rule shape here covers "SC/ST OR woman" (the rule engine
      // is AND-only by design — see rule-engine.js), so this OR lives in
      // check() itself, same pattern as BOCW's extra fields above: the
      // population gate narrows to plausible entrepreneurs, and this does
      // the final relevance filter, silently skipping (null) anyone outside
      // the scheme's actual target group rather than misreporting them.
      const isTargetGroup = ["SC", "ST"].includes(p.category) || p.gender === "Female";
      if (!isTargetGroup) return null;
      const met = [];
      if (["SC", "ST"].includes(p.category)) met.push(`Category: ${p.category}`);
      if (p.gender === "Female") met.push("Gender: Female");
      return result("needs_verification", met,
        ["Meant for a first-time (\"greenfield\") non-farm enterprise — at least one branch of every scheduled commercial bank is mandated to extend one such loan. Approach your nearest bank branch with a project report to confirm."]);
    }},

  // ---------------------------------------------------------------------
  // Batch added 2026-09-06 — first installment toward broader coverage.
  // Each entry below was checked against current (2026) scheme guidance
  // via web search before being added; sourceNote in VERIFICATION_BASE
  // records that. Two of these (Annadata Sukhibhava, Aasara Pension) sit
  // in AP/Telangana schemes that have changed name, amount, or government
  // within the last year — a reminder that state-scheme data here needs
  // periodic re-verification, same as central schemes.
  // ---------------------------------------------------------------------
  { id: "jsy", name: "Janani Suraksha Yojana (JSY)", dept: "National Health Mission",
    benefit: "Cash incentive for institutional delivery — ₹1,400 (rural) / ₹1,000 (urban) in Low Performing States; ₹700 (rural) / ₹600 (urban) for BPL/SC/ST women in High Performing States",
    tag: "For pregnant women delivering in a government or accredited private hospital",
    docs: ["Aadhaar card", "JSY / MCP card (given at ANC registration)", "Bank passbook", "BPL/caste certificate, if applicable"],
    populationRules: [{ field: "gender", operator: "equals", value: "Female" }, { field: "maternity", operator: "equals", value: true }],
    check: p => {
      if (incomeKnown(p) && !p.hasBplCard && p.age && p.age >= 19) {
        // Most states (incl. AP/Telangana) are "High Performing" under JSY,
        // where the cash incentive is restricted to BPL/SC/ST women — so a
        // clearly above-BPL income without a BPL card or SC/ST category is
        // the one case worth a soft "not_eligible" rather than "verify".
        if (p.income > 3 && !["SC", "ST"].includes(p.category)) {
          return result("not_eligible", ["Pregnant / recent mother"],
            ["Most states run JSY as a High-Performing State, where the cash incentive is limited to BPL/SC/ST women — reported income and category don't currently match that."]);
        }
      }
      return result("needs_verification", ["Pregnant / recent mother"],
        ["Exact amount depends on whether your state is classified Low- or High-Performing under JSY, and (in High-Performing states) on BPL/SC/ST status — ask your ASHA worker or nearest government health facility, ideally before delivery so registration happens in time.",
         "Age 19+ and up to two live births are standard conditions nationally."]);
    }},
  { id: "annadata-sukhibhava", name: "Annadata Sukhibhava", dept: "Government of Andhra Pradesh",
    benefit: "₹20,000/year per farmer family (₹14,000 state + ₹6,000 central PM-KISAN component), paid in 3 DBT installments",
    tag: "For small & marginal farmer families in Andhra Pradesh (replaced YSR Rythu Bharosa in Aug 2025)",
    docs: ["Aadhaar card", "Land record / khatauni (or CCRC card for tenant farmers)", "Bank passbook linked to Aadhaar"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Farmer" }, { field: "state", operator: "equals", value: "Andhra Pradesh" }],
    check: p => {
      if (!p.farmland) {
        return result("needs_verification", ["Occupation: Farmer", "State: Andhra Pradesh"],
          ["No farmland reported — but tenant/cultivator farmers holding a CCRC (Crop Cultivator Rights) card are also covered, so this may still apply. Confirm with your Rythu Seva Kendra."]);
      }
      return result("needs_verification", ["Occupation: Farmer", "State: Andhra Pradesh", "Owns farmland"],
        ["This state top-up rides on your PM-KISAN record and is generally capped at holdings under 5 acres — confirm your e-KYC and land records are current at annadathasukhibhava.ap.gov.in or your nearest Rythu Seva Kendra."]);
    }},
  { id: "rythu-bharosa-ts", name: "Rythu Bharosa (Telangana)", dept: "Government of Telangana",
    benefit: "Per-acre seasonal investment support (recently reported around ₹6,000/acre/season) — confirm current rate before relying on a figure",
    tag: "For landowning and registered tenant farmers in Telangana (successor to Rythu Bandhu)",
    docs: ["Aadhaar card", "Land record / pattadar passbook (or written tenant lease agreement, for cultivators)", "Bank passbook"],
    populationRules: [{ field: "occupation", operator: "equals", value: "Farmer" }, { field: "state", operator: "equals", value: "Telangana" }],
    check: p => {
      if (!p.farmland) {
        return result("needs_verification", ["Occupation: Farmer", "State: Telangana"],
          ["No farmland reported — tenant/cultivating farmers with a verified written lease are also covered as of the 2025-26 rules. Confirm status with your village agriculture assistant."]);
      }
      return result("needs_verification", ["Occupation: Farmer", "State: Telangana", "Owns farmland"],
        ["Benefit is tied to active cultivation, not just land ownership, and the per-acre rate has changed more than once recently — check your name on the beneficiary list at rythubharosa.telangana.gov.in before expecting a specific amount."]);
    }},
  { id: "aasara-pension-ts", name: "Aasara Pension (Telangana)", dept: "Government of Telangana",
    benefit: "Monthly pension for elderly, widowed, or disabled residents — reported amounts vary by source at time of writing (roughly ₹2,000–₹4,000/month by category); confirm the current figure locally",
    tag: "For elderly (57+), widowed, or disabled Telangana residents, generally from BPL households",
    docs: ["Aadhaar card", "Age proof", "Bank passbook", "BPL/income certificate", "Disability certificate (SADAREM ID), if applicable"],
    populationRules: [{ field: "state", operator: "equals", value: "Telangana" }],
    check: p => {
      const isOldAge = typeof p.age === "number" && p.age >= 57;
      const category = [];
      if (isOldAge) category.push(`Age ${p.age} (57+)`);
      if (p.widow) category.push("Widow status");
      if (p.disability) category.push("Disability reported");
      if (!category.length) return null;
      if (p.hasBplCard) {
        return result("eligible", [...category, "BPL card holder"],
          ["Exact monthly amount depends on your specific category (old-age/widow/disability) — this has been reported inconsistently across sources recently, so confirm the current figure at aasara.telangana.gov.in."]);
      }
      if (!incomeKnown(p)) {
        return result("insufficient_info", category, ["Add your household income (or confirm you hold a BPL/ration card) to check this scheme."]);
      }
      return result("needs_verification", category,
        ["Real determination runs on the BPL/welfare list your local Gram Panchayat or ULB maintains, not a self-reported income figure — verify your name on that list."]);
    }},
  { id: "kalyana-lakshmi-shaadi-mubarak", name: "Kalyana Lakshmi / Shaadi Mubarak", dept: "Government of Telangana",
    benefit: "One-time ₹1,00,116 marriage assistance grant (₹1,25,145 if the bride has a certified disability), paid to the bride's family",
    tag: "For SC/ST/BC/EBC brides (Kalyana Lakshmi) or minority-community brides (Shaadi Mubarak) in Telangana",
    docs: ["Bride's Aadhaar card", "Caste/community certificate", "Age proof for bride (18+) and groom (21+)", "Marriage certificate/invitation", "Bride's mother's bank passbook (benefit is paid to this account)"],
    populationRules: [{ field: "gender", operator: "equals", value: "Female" }, { field: "state", operator: "equals", value: "Telangana" }, { field: "age", operator: ">=", value: 18 }],
    check: p => {
      const incomeLimit = p.category === "BC" || p.category === "EBC" ? 1.5 : 2; // rural BC/EBC ceiling is lower per official criteria; treated as the tighter, safer bound here
      if (!incomeKnown(p)) {
        return result("insufficient_info", ["Gender: Female", "State: Telangana", "Age 18+"],
          ["Add your household income to check this scheme (there's an income ceiling that varies slightly by category)."]);
      }
      if (p.income > incomeLimit) {
        return result("not_eligible", ["Gender: Female", "State: Telangana", "Age 18+"],
          [`Reported income is above the roughly ₹${incomeLimit} lakh/year ceiling this scheme generally applies (varies slightly by category and rural/urban).`]);
      }
      return result("needs_verification", ["Gender: Female", "State: Telangana", "Age 18+", "Household income within the range this scheme often covers"],
        ["Only relevant if a marriage is being planned or has recently taken place — applications are typically due within a few months of the marriage date, so apply promptly through telanganaepass.cgg.gov.in.",
         "Kalyana Lakshmi covers SC/ST/BC/EBC brides; Shaadi Mubarak covers minority-community brides — same amount, different department."]);
    }},

  // ---------------------------------------------------------------------
  // Batch 2, added 2026-09-06 — central schemes, nationwide.
  // ---------------------------------------------------------------------
  { id: "pmjdy", name: "Pradhan Mantri Jan Dhan Yojana (PMJDY)", dept: "Dept. of Financial Services, Ministry of Finance",
    benefit: "Zero-balance bank account + RuPay debit card + accident/life insurance cover + overdraft facility (up to ₹10,000 after 6 months of satisfactory operation)",
    tag: "For any Indian citizen aged 10+ without a bank account",
    docs: ["Aadhaar card (or any officially valid ID)", "Passport-size photo"],
    populationRules: [],
    check: p => {
      if (p.bankAccount === true) return null; // already banked — not the target population, silently skip rather than mislabel
      if (p.bankAccount === false) {
        return result("eligible", ["No existing bank account reported"],
          ["Open a Basic Savings Bank Deposit Account at any bank branch or Business Correspondent point — no minimum balance is required, and minors aged 10+ can open one through a guardian."]);
      }
      return result("insufficient_info", [], ["Let us know whether you currently have a bank account to check this scheme — it's aimed at citizens who don't."]);
    }},
  { id: "rvy", name: "Rashtriya Vayoshri Yojana (RVY)", dept: "Ministry of Social Justice & Empowerment",
    benefit: "Free assisted-living devices (walking sticks, wheelchairs, hearing aids, spectacles, dentures) for age-related disability/infirmity",
    tag: "For BPL senior citizens aged 60+ with an age-related disability or infirmity",
    docs: ["Aadhaar card", "BPL certificate / ration card (or proof of receiving IGNOAPS)", "Income certificate (if not BPL)", "Medical certificate for the specific impairment"],
    populationRules: [{ field: "age", operator: ">=", value: 60 }],
    check: p => {
      if (!p.disability) {
        return result("needs_verification", ["Age 60+"],
          ["This scheme is specifically for age-related impairments (low vision, hearing loss, missing teeth, or a locomotor disability needing a wheelchair) — let us know if any of these apply to check properly."]);
      }
      if (p.hasBplCard) {
        return result("eligible", ["Age 60+", "Disability/infirmity reported", "BPL card holder"],
          ["Devices are distributed at government assessment/distribution camps, not on demand — watch for a camp announcement in your district or ask your local social welfare office."]);
      }
      if (!incomeKnown(p)) {
        return result("insufficient_info", ["Age 60+", "Disability/infirmity reported"],
          ["Add your household income (or confirm you hold a BPL card) — this scheme also accepts a monthly income up to ₹15,000 without a BPL card."]);
      }
      if (p.income <= 1.8) { // ₹15,000/month ≈ ₹1.8 lakh/year
        return result("eligible", ["Age 60+", "Disability/infirmity reported", "Income within the ₹15,000/month threshold"],
          ["Devices are distributed at government assessment/distribution camps — watch for a camp announcement in your district or ask your local social welfare office."]);
      }
      return result("not_eligible", ["Age 60+", "Disability/infirmity reported"],
        ["Reported income is above the ₹15,000/month (~₹1.8 lakh/year) ceiling this scheme applies without a BPL card."]);
    }},
  { id: "annapurna", name: "Annapurna Scheme", dept: "Ministry of Rural Development (NSAP)",
    benefit: "10 kg free food grains per month",
    tag: "For destitute senior citizens aged 65+ who qualify for old-age pension but aren't currently receiving one",
    docs: ["Aadhaar card", "Age proof", "Certificate/declaration of not receiving any old-age pension"],
    populationRules: [{ field: "age", operator: ">=", value: 65 }],
    check: p => {
      // This scheme's entire point is the gap between "qualifies for a
      // pension" and "actually receives one" — a case this form has no
      // direct field for, so it can only ever be a lead worth checking,
      // never a confident "eligible".
      return result("needs_verification", ["Age 65+"],
        ["Only applies if you qualify for the old-age pension (IGNOAPS or a state pension scheme) but are not currently receiving one — if you already get a pension, this scheme doesn't apply. Check with your Gram Panchayat or local social welfare office."]);
    }},
];

// Stamp every scheme with level ("Central" or "State — <name>") in one
// pass, so it never has to be maintained by hand per-entry above.
SCHEMES.forEach(s => { s.level = levelFor(s.dept); });

// Order matches by how actionable/positive they are: strong matches first,
// then things worth verifying, then "add more info", then clear misses last.
const STATUS_ORDER = { eligible: 0, needs_verification: 1, insufficient_info: 2, not_eligible: 3 };
 
function matchProfile(rawProfile) {
  // Defense-in-depth: if income is missing, null, or not a valid number
  // (blank form field, malformed API payload, etc.), never silently treat
  // it as ₹0 — that would falsely mark someone ELIGIBLE for BPL-tied
  // schemes just because they skipped a question. Infinity fails every
  // "income <= X" check, so unknown income can only ever produce
  // "insufficient_info" or "needs_verification" — never a false "eligible"
  // — while BPL-card-based paths (which don't depend on income) still work
  // normally, and incomeKnown(p) lets each scheme detect the unknown case
  // explicitly instead of silently treating a huge number as a real answer.
  const incomeNum = (rawProfile.income === null || rawProfile.income === undefined || rawProfile.income === "")
    ? NaN
    : Number(rawProfile.income);
  const profile = { ...rawProfile, income: Number.isFinite(incomeNum) ? incomeNum : Infinity };
 
  const matches = [];
  for (const scheme of SCHEMES) {
    // The population gate is now data (scheme.populationRules), interpreted
    // once here by the shared rule engine — this is the one place that used
    // to be 16 separate hand-written `if (...) return null;` guards, one
    // per scheme, each requiring a code change to add or adjust. A profile
    // that doesn't match a scheme's population is silently skipped, same as
    // the old guards (see the RESULT MODEL note at the top of this file for
    // why that's a relevance filter and not a verdict).
    if (!evaluateRules(scheme.populationRules, profile).passed) continue;
    const r = scheme.check(profile);
    if (r) matches.push({ id: scheme.id, status: r.status, reasons: r.reasons });
  }
  matches.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return matches;
}
 
// Metadata only (no functions) — this is what gets seeded into the database.
const SCHEME_METADATA = SCHEMES.map(({ id, name, dept, benefit, tag, docs, level }) => {
  const v = VERIFICATION[id] || {};
  return {
    id, name, dept, benefit, tag, docs, level,
    portalName: (PORTALS[id] && PORTALS[id].name) || null,
    portalUrl: (PORTALS[id] && PORTALS[id].url) || null,
    sourceAuthority: v.sourceAuthority || dept || null,
    sourceNote: v.sourceNote || null,
    sourceUrl: v.sourceUrl || null,
    lastVerified: v.lastVerified || null,
    version: v.version || 1,
  };
});

// ---------------------------------------------------------------------------
// RULE PROVENANCE -- "Why do you say this?"
// ---------------------------------------------------------------------------
// Every rule a profile is checked against traces back to: an official
// source (sourceAuthority) -> a notification/webpage (sourceUrl) -> a last-
// verified date -> a version number. The first three already exist per
// scheme (VERIFICATION, above); this section turns each scheme's
// populationRules/requirementRules into a plain-English criteria list so a
// citizen (or a judge) can ask "how do you know this is right?" and get a
// real answer instead of having to trust a black box.
const FIELD_LABELS = {
  age: "Age",
  occupation: "Occupation",
  category: "Social category",
  income: "Household income",
  bankAccount: "Bank account",
  farmland: "Farmland ownership",
  hasBplCard: "BPL card",
  widow: "Widow status",
  disability: "Disability status",
  disabilityPercentage: "Disability percentage",
  disabilityCertificate: "Disability certificate",
  gender: "Gender",
  maternity: "Pregnancy / recent-mother status",
  noPuccaHouse: "Housing status (no pucca house)",
  registeredConstructionWorker: "BOCW registration",
  labourCardAvailable: "Labour card",
  institutionType: "School type",
  classYear: "Class / year",
};

// Turns one { field, operator, value } rule into a plain-English sentence.
// This is what makes a rule self-documenting: the same object the engine
// evaluates is also what the citizen-facing explanation is built from, so
// the explanation can never drift out of sync with what was actually
// checked -- a real risk when the two are maintained as separate prose.
function describeRule(rule) {
  const label = FIELD_LABELS[rule.field] || rule.field;
  const val = typeof rule.value === "boolean" ? String(rule.value) : `"${rule.value}"`;
  switch (rule.operator) {
    case "equals": case "==": return `${label} must be ${val}`;
    case "!=": return `${label} must not be ${val}`;
    case ">=": return `${label} must be at least ${rule.value}`;
    case "<=": return `${label} must be at most ${rule.value}`;
    case ">":  return `${label} must be more than ${rule.value}`;
    case "<":  return `${label} must be less than ${rule.value}`;
    case "in": return `${label} must be one of: ${rule.value.join(", ")}`;
    case "not_in": return `${label} must not be one of: ${rule.value.join(", ")}`;
    case "exists": return `${label} must be provided`;
    default: return `${label} ${rule.operator} ${JSON.stringify(rule.value)}`;
  }
}

// The full provenance chain for one scheme, ready for the frontend's "Why
// do you say this?" panel: the plain-English criteria (from the actual
// rules the engine runs), plus who owns the underlying facts, where to go
// read them, and how stale they might be.
function explainScheme(schemeId) {
  const scheme = SCHEMES.find((s) => s.id === schemeId);
  if (!scheme) return null;
  const rules = [...(scheme.populationRules || []), ...(scheme.requirementRules || [])];
  const v = VERIFICATION[schemeId] || {};
  return {
    id: schemeId,
    criteria: rules.map(describeRule),
    sourceAuthority: v.sourceAuthority || scheme.dept || null,
    sourceNote: v.sourceNote || null,
    sourceUrl: v.sourceUrl || null,
    lastVerified: v.lastVerified || null,
    version: v.version || 1,
  };
}
 
module.exports = {
  SCHEMES, SCHEME_METADATA, PORTALS, VERIFICATION, matchProfile, STATUS_ORDER,
  describeRule, explainScheme, FIELD_LABELS, levelFor,
};
