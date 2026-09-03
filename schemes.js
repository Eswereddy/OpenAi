// schemes.js
// The rules engine: scheme metadata + eligibility logic in one place.
// Metadata (name/dept/benefit/tag/docs) gets mirrored into the database as the
// source of truth for *display*. The `check` functions are the actual rules
// engine and stay in code — this mirrors how real eligibility systems are
// usually built (structured rules, not just database rows), while still
// keeping schemes' descriptive content easy to update via the DB.

function stateNote(p, kind) {
  const st = p.state && p.state !== "Other state / UT" ? p.state : "your state";
  if (kind === "income") return `Exact income cut-off for ${st} may differ from the national baseline — confirm with your local CSC/e-mitra center.`;
  if (kind === "landholding") return `Landholding limits can vary by district in ${st} — confirm with the local revenue office.`;
  return `Some conditions vary by state — verify with your local office.`;
}

function result(status, met, watch) {
  return { status, reasons: { met, watch: watch || [] } };
}

const SCHEMES = [
  { id: "pmkisan", name: "PM-KISAN", dept: "Ministry of Agriculture", benefit: "₹6,000/year, direct transfer",
    tag: "For small & marginal farmers", docs: ["Aadhaar card", "Land record / khatauni", "Bank passbook"],
    check: p => {
      if (p.occupation !== "Farmer") return null;
      return p.farmland ? result("eligible", ["Occupation: Farmer", "Owns farmland"])
                         : result("partial", ["Occupation: Farmer"], [stateNote(p, "landholding")]);
    }},
  { id: "pmfby", name: "Pradhan Mantri Fasal Bima Yojana", dept: "Ministry of Agriculture", benefit: "Crop insurance premium subsidy",
    tag: "Crop insurance for farmers", docs: ["Aadhaar card", "Land record", "Bank passbook", "Sowing certificate"],
    check: p => {
      if (p.occupation !== "Farmer") return null;
      return p.farmland ? result("eligible", ["Occupation: Farmer", "Owns farmland"])
                         : result("partial", ["Occupation: Farmer"], [stateNote(p, "landholding")]);
    }},
  { id: "pmvishwakarma", name: "PM Vishwakarma", dept: "Ministry of MSME", benefit: "Toolkit support + collateral-free loan up to ₹3 lakh",
    tag: "For traditional artisans & craftspeople", docs: ["Aadhaar card", "Proof of traditional trade", "Bank passbook"],
    check: p => {
      if (p.occupation !== "Self-employed / artisan") return null;
      return result("partial", ["Occupation: Self-employed / artisan"], ["Trade must be on the notified artisan list — verify at your nearest CSC"]);
    }},
  { id: "nsp-postmatric", name: "Post-Matric Scholarship", dept: "National Scholarship Portal", benefit: "Tuition + maintenance allowance",
    tag: "For SC/ST/OBC/EWS students", docs: ["Aadhaar card", "Caste/EWS certificate", "Income certificate", "Previous mark sheet"],
    check: p => {
      if (p.occupation !== "Student") return null;
      const catOk = ["SC", "ST", "OBC", "EWS"].includes(p.category);
      if (!catOk) return null;
      return p.income <= 4.5 ? result("eligible", [`Category: ${p.category}`, "Household income within limit"])
                              : result("partial", [`Category: ${p.category}`], [stateNote(p, "income")]);
    }},
  { id: "nsp-prematric", name: "Pre-Matric Scholarship", dept: "National Scholarship Portal", benefit: "Annual education allowance",
    tag: "For students in classes 9–10", docs: ["Aadhaar card", "School ID", "Caste/minority certificate", "Income certificate"],
    check: p => {
      if (p.occupation !== "Student" || p.age > 17) return null;
      const catOk = ["SC", "ST", "OBC", "EWS"].includes(p.category);
      return catOk ? result("eligible", [`Category: ${p.category}`, "Age matches school-going range"]) : null;
    }},
  { id: "nmms", name: "National Means-cum-Merit Scholarship", dept: "Ministry of Education", benefit: "₹12,000/year",
    tag: "Meritorious students from low-income households", docs: ["Aadhaar card", "Income certificate", "Class 8 marksheet"],
    check: p => {
      if (p.occupation !== "Student" || p.income > 3.5) return null;
      return result("partial", ["Household income within general limit"], ["Merit cut-off is exam-based and isn't assessed by this form"]);
    }},
  { id: "ignoaps", name: "Old Age Pension (IGNOAPS)", dept: "Ministry of Rural Development", benefit: "₹200–500+/month (state top-ups vary)",
    tag: "For senior citizens below poverty line", docs: ["Aadhaar card", "Age proof", "BPL/income certificate"],
    check: p => {
      if (p.age < 60) return null;
      const poor = p.income <= 1 || p.hasBplCard;
      return poor ? result("eligible", ["Age 60+", p.hasBplCard ? "BPL card holder" : "Income within BPL-equivalent range"])
                  : result("partial", ["Age 60+"], [stateNote(p, "income")]);
    }},
  { id: "widow-pension", name: "Widow Pension Scheme", dept: "Ministry of Rural Development", benefit: "Monthly pension (state-administered)",
    tag: "For widows aged 40–79, low income", docs: ["Aadhaar card", "Husband's death certificate", "Income certificate"],
    check: p => {
      if (!p.widow || p.age < 40 || p.age > 79) return null;
      const poor = p.income <= 1 || p.hasBplCard;
      return poor ? result("eligible", ["Marked as widow", "Age within 40–79 range"])
                  : result("partial", ["Marked as widow", "Age within 40–79 range"], [stateNote(p, "income")]);
    }},
  { id: "disability-pension", name: "Disability Pension Scheme", dept: "Ministry of Rural Development", benefit: "Monthly pension (state-administered)",
    tag: "For persons with 80%+ disability, low income", docs: ["Aadhaar card", "Disability certificate", "Income certificate"],
    check: p => {
      if (!p.disability) return null;
      const poor = p.income <= 1 || p.hasBplCard;
      return poor ? result("eligible", ["Marked as person with disability", p.hasBplCard ? "BPL card holder" : "Income within range"])
                  : result("partial", ["Marked as person with disability"], ["Confirm disability percentage meets the 80% threshold", stateNote(p, "income")]);
    }},
  { id: "pmmvy", name: "PM Matru Vandana Yojana", dept: "Ministry of Women & Child Development", benefit: "₹5,000 cash benefit (first child)",
    tag: "For pregnant & lactating mothers", docs: ["Aadhaar card", "MCP card", "Bank passbook"],
    check: p => {
      if (p.gender !== "Female" || !p.maternity) return null;
      return result("eligible", ["Marked as pregnant / recent mother"]);
    }},
  { id: "ayushman", name: "Ayushman Bharat (PM-JAY)", dept: "National Health Authority", benefit: "₹5 lakh/year health cover per family",
    tag: "For low-income families", docs: ["Aadhaar card", "Ration card", "SECC/family ID"],
    check: p => {
      if (p.income > 3 && !p.hasBplCard) return null;
      return (p.income <= 1 || p.hasBplCard) ? result("eligible", [p.hasBplCard ? "BPL card holder" : "Household income within likely deprivation-criteria range"])
                            : result("partial", [], ["Coverage depends on SECC deprivation category, not income alone — check your ration card status"]);
    }},
  { id: "pmay", name: "Pradhan Mantri Awas Yojana", dept: "Ministry of Housing", benefit: "Housing subsidy up to ₹2.67 lakh",
    tag: "For families without a pucca house", docs: ["Aadhaar card", "Income certificate", "Land/property document"],
    check: p => {
      if (!p.noPuccaHouse) return null;
      return p.income <= 8 ? result("eligible", ["No pucca house reported", "Household income within eligible range"])
                            : result("partial", ["No pucca house reported"], [stateNote(p, "income")]);
    }},
  { id: "pmjjby", name: "PM Jeevan Jyoti Bima Yojana", dept: "Ministry of Finance / banks", benefit: "₹2 lakh life cover, ~₹436/year premium",
    tag: "Age 18–50 with a bank account", docs: ["Aadhaar card", "Bank account", "Auto-debit consent"],
    check: p => {
      if (p.age < 18 || p.age > 50) return null;
      return p.bankAccount ? result("eligible", ["Age within 18–50", "Has a bank account"])
                            : result("partial", ["Age within 18–50"], ["Requires a bank account for the auto-debit premium"]);
    }},
  { id: "pmsby", name: "PM Suraksha Bima Yojana", dept: "Ministry of Finance / banks", benefit: "₹2 lakh accident cover, ~₹20/year premium",
    tag: "Age 18–70 with a bank account", docs: ["Aadhaar card", "Bank account", "Auto-debit consent"],
    check: p => {
      if (p.age < 18 || p.age > 70) return null;
      return p.bankAccount ? result("eligible", ["Age within 18–70", "Has a bank account"])
                            : result("partial", ["Age within 18–70"], ["Requires a bank account for the auto-debit premium"]);
    }},
  { id: "apy", name: "Atal Pension Yojana", dept: "PFRDA", benefit: "Guaranteed pension ₹1,000–5,000/month after 60",
    tag: "Unorganised-sector workers, age 18–40", docs: ["Aadhaar card", "Bank account"],
    check: p => {
      if (p.age < 18 || p.age > 40) return null;
      if (p.occupation !== "Daily-wage / unorganised worker" && p.occupation !== "Self-employed / artisan") return null;
      return p.bankAccount ? result("eligible", ["Age within 18–40", "Unorganised-sector occupation", "Has a bank account"])
                            : result("partial", ["Age within 18–40", "Unorganised-sector occupation"], ["Requires a bank account to enrol"]);
    }},
  { id: "eshram", name: "e-Shram Registration", dept: "Ministry of Labour", benefit: "Unorganised worker ID + accident cover ₹2 lakh",
    tag: "Unorganised-sector workers, age 16–59", docs: ["Aadhaar card", "Bank account (optional)"],
    check: p => {
      if (p.occupation !== "Daily-wage / unorganised worker") return null;
      if (p.age < 16 || p.age > 59) return null;
      return result("eligible", ["Age within 16–59", "Occupation: unorganised worker"]);
    }},
];

function matchProfile(profile) {
  const matches = [];
  for (const scheme of SCHEMES) {
    const r = scheme.check(profile);
    if (r) matches.push({ id: scheme.id, status: r.status, reasons: r.reasons });
  }
  matches.sort((a, b) => (a.status === "eligible" ? 0 : 1) - (b.status === "eligible" ? 0 : 1));
  return matches;
}

// Metadata only (no functions) — this is what gets seeded into the database.
const SCHEME_METADATA = SCHEMES.map(({ id, name, dept, benefit, tag, docs }) => ({ id, name, dept, benefit, tag, docs }));

module.exports = { SCHEMES, SCHEME_METADATA, matchProfile };
