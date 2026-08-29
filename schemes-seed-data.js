/**
 * schemes-seed-data.js
 *
 * Real Indian central government welfare schemes with eligibility criteria
 * sourced from official government statements, ministry releases, and
 * verified news reporting (not invented). Each entry includes a `source`
 * field naming where the criteria came from, so you can cite it honestly
 * in your demo/submission.
 *
 * HOW TO WIRE THIS IN:
 * This is a plain array of scheme objects. Find wherever your current
 * db/index.js seeds the `schemes` table (likely a hardcoded array passed
 * to an INSERT loop) and replace that array with SCHEMES_SEED below, or
 * merge the two. The shape below is a reasonable common structure —
 * if your existing table columns use different names, tell me the
 * column list and I'll remap this exactly instead of guessing.
 *
 * IMPORTANT CAVEATS (say this in your video/summary — it's a strength,
 * not a weakness, to be upfront about it):
 * - Income/asset thresholds for several schemes vary by STATE (Ayushman
 *   Bharat is a clear example — the base scheme uses SECC 2011 deprivation
 *   criteria, but several states layer their own income cutoffs on top).
 *   Where that's true, it's noted in `eligibility.notes`.
 *   For values, this uses the central/base rule; a production version
 *   would need per-state override tables.
 * - Some numeric limits (LPG subsidy amounts, land-holding exclusions)
 *   are revised periodically by cabinet decisions. Verify against
 *   myscheme.gov.in before relying on these for a real deployment.
 */

const SCHEMES_SEED = [
  {
    id: "pm-kisan",
    name: "PM-KISAN (Pradhan Mantri Kisan Samman Nidhi)",
    level: "central",
    category: "agriculture",
    benefit: "₹6,000/year (₹2,000 × 3 installments) direct to bank account",
    description:
      "Income support for landholding farmer families, paid directly via Aadhaar-linked bank accounts.",
    eligibility: {
      occupation: ["farmer"],
      landHolding: { min: 0.01 }, // must own agricultural land; no longer capped at 2 hectares (cap removed 2019)
      excludes: [
        "income-tax payers",
        "current/former holders of constitutional posts",
        "government employees (most categories)",
        "pensioners drawing more than ₹10,000/month",
        "professionals (doctors, engineers, CAs, architects) registered with their body",
      ],
      notes:
        "Landless tenant farmers and farmers on unrecorded community/panchayat land are explicitly NOT covered — a known gap flagged by a Parliamentary Standing Committee.",
    },
    docs: ["Aadhaar card", "Land ownership records", "Bank account (Aadhaar-seeded)"],
    source: "pmkisan.gov.in; Lok Sabha written replies via Ministry of Agriculture (2023)",
  },

  {
    id: "pmjay",
    name: "Ayushman Bharat – PM-JAY (Pradhan Mantri Jan Arogya Yojana)",
    level: "central",
    category: "health",
    benefit: "₹5,00,000/family/year cashless hospitalization cover",
    description:
      "World's largest government-funded health assurance scheme, covering secondary and tertiary hospitalization at empanelled public and private hospitals.",
    eligibility: {
      selection: "SECC 2011 deprivation/occupational criteria (not a flat income cutoff)",
      restrictions: "none on age, gender, or family size; pre-existing conditions covered from day one",
      notes:
        "Eligibility is determined by whether a household appears in the SECC 2011 deprivation list, not by a self-declared income figure. Several states (e.g. Haryana) have added their own top-up income thresholds for state-funded extensions.",
    },
    docs: ["Aadhaar card", "Ration card or SECC family ID", "PM-JAY e-card (generated on verification)"],
    source: "pmjay.gov.in; Wikipedia/Ayushman Bharat Yojana citing NHA data; PMC study PMC10360977",
  },

  {
    id: "pmuy",
    name: "PM Ujjwala Yojana (PMUY)",
    level: "central",
    category: "household/energy",
    benefit: "Free deposit-free LPG connection + first refill and stove for BPL households",
    description:
      "Deposit-free LPG gas connections issued in the name of adult women from poor households, to replace unclean cooking fuel.",
    eligibility: {
      gender: "female",
      age: { min: 18 },
      excludes: [
        "any family member earning more than ₹10,000/month",
        "income-tax or professional-tax payers",
        "government employees",
        "Kisan Credit Card holders with limit over ₹50,000",
        "households owning more than 2.5 acres of irrigated land with one irrigation source, or over 5 acres with two annual crops",
        "households owning a 3-wheeler or 4-wheeler",
      ],
    },
    docs: ["Aadhaar card", "BPL/ration card or SECC listing", "Bank account details", "Passport-size photo"],
    source: "PIB Cabinet releases (2023, 2025); Tribune reporting on district-level verification rules",
  },

  {
    id: "mgnrega",
    name: "MGNREGA (Mahatma Gandhi National Rural Employment Guarantee Act)",
    level: "central",
    category: "employment",
    benefit: "100 days/year of guaranteed unskilled wage employment per rural household",
    description:
      "Legal guarantee of wage employment on public works for any rural household whose adult members volunteer for unskilled manual work.",
    eligibility: {
      residence: "rural",
      age: { min: 18 },
      willingness: "must volunteer for unskilled manual labour",
    },
    docs: ["Job card (issued by Gram Panchayat)", "Aadhaar card", "Bank/post office account"],
    source: "Ministry of Rural Development, nrega.nic.in (Act provisions)",
  },

  {
    id: "pmay-g",
    name: "PMAY-G (Pradhan Mantri Awas Yojana – Gramin)",
    level: "central",
    category: "housing",
    benefit: "₹1,20,000 (plain areas) / ₹1,30,000 (hilly/difficult areas) for pucca house construction",
    description:
      "Financial assistance to rural households living in kutcha or dilapidated houses to build a pucca house.",
    eligibility: {
      residence: "rural",
      housingStatus: "houseless or living in a kutcha/dilapidated house",
      selection: "identified via SECC 2011 housing deprivation criteria and Awaas+ survey, verified by Gram Sabha",
      excludes: ["households owning a motorized 3/4-wheeler", "government employees", "income-tax payers"],
    },
    docs: ["Aadhaar card", "MGNREGA job card (if available)", "Bank account", "SECC/Awaas+ verification"],
    source: "Ministry of Rural Development, pmayg.nic.in",
  },

  {
    id: "atal-pension-yojana",
    name: "Atal Pension Yojana (APY)",
    level: "central",
    category: "pension",
    benefit: "Guaranteed monthly pension of ₹1,000–₹5,000 after age 60, based on contribution",
    description:
      "Government-backed pension scheme aimed at workers in the unorganised sector with no formal retirement savings.",
    eligibility: {
      age: { min: 18, max: 40 },
      requires: "savings bank/post office account",
      notes: "Primarily targeted at unorganised-sector workers not covered by EPF/other formal pension schemes.",
    },
    docs: ["Aadhaar card", "Bank/post office savings account", "Mobile number"],
    source: "PFRDA, npscra.nsdl.co.in (APY scheme details)",
  },

  {
    id: "sukanya-samriddhi",
    name: "Sukanya Samriddhi Yojana",
    level: "central",
    category: "savings/girl child",
    benefit: "High-interest government savings account maturing for a girl child's education/marriage",
    description:
      "Small savings scheme for the financial security of a girl child, opened by a parent/guardian.",
    eligibility: {
      gender: "female",
      age: { max: 10 },
      notes: "Account opened by parent/legal guardian in the girl child's name; max 2 accounts per family (exceptions for twins/triplets).",
    },
    docs: ["Girl child's birth certificate", "Parent/guardian ID and address proof"],
    source: "Ministry of Finance / India Post Small Savings Schemes",
  },

  {
    id: "pmjdy",
    name: "Pradhan Mantri Jan Dhan Yojana (PMJDY)",
    level: "central",
    category: "financial inclusion",
    benefit: "Zero-balance bank account, RuPay debit card, ₹2,00,000 accident insurance, overdraft facility",
    description: "National mission for basic banking access for every unbanked household.",
    eligibility: {
      age: { min: 10 },
      residence: "any Indian citizen without an existing bank account",
    },
    docs: ["Aadhaar card (or other valid ID under RBI's simplified KYC)"],
    source: "Department of Financial Services, pmjdy.gov.in",
  },

  {
    id: "pmsby",
    name: "Pradhan Mantri Suraksha Bima Yojana (PMSBY)",
    level: "central",
    category: "insurance",
    benefit: "₹2,00,000 accidental death/full disability cover for ₹20/year premium",
    description: "Low-cost accident insurance auto-debited annually from a linked bank account.",
    eligibility: {
      age: { min: 18, max: 70 },
      requires: "savings bank account with auto-debit consent",
    },
    docs: ["Bank account", "Aadhaar card"],
    source: "Department of Financial Services, jansuraksha.gov.in",
  },

  {
    id: "pmjjby",
    name: "Pradhan Mantri Jeevan Jyoti Bima Yojana (PMJJBY)",
    level: "central",
    category: "insurance",
    benefit: "₹2,00,000 life insurance cover for ₹436/year premium (renewable term life cover)",
    description: "Low-cost life insurance for death due to any cause, renewed annually.",
    eligibility: {
      age: { min: 18, max: 50 },
      requires: "savings bank account with auto-debit consent",
    },
    docs: ["Bank account", "Aadhaar card"],
    source: "Department of Financial Services, jansuraksha.gov.in",
  },

  {
    id: "nsap-old-age",
    name: "National Social Assistance Programme – Old Age Pension (IGNOAPS)",
    level: "central",
    category: "pension/social welfare",
    benefit: "₹200–₹500+/month central pension (states commonly top this up)",
    description: "Monthly pension for elderly persons from BPL households, no formal retirement income.",
    eligibility: {
      age: { min: 60 },
      economicStatus: "BPL household (state BPL list)",
      notes: "Central contribution is a base amount; most states add a top-up, so actual disbursed amount is usually much higher and varies by state.",
    },
    docs: ["Aadhaar card", "BPL card", "Age proof"],
    source: "Ministry of Rural Development, NSAP guidelines",
  },

  {
    id: "pmmvy",
    name: "Pradhan Mantri Matru Vandana Yojana (PMMVY)",
    level: "central",
    category: "maternity",
    benefit: "₹5,000 cash incentive for the first living child (partial wage compensation)",
    description: "Maternity benefit for pregnant and lactating women, paid in installments tied to health checkups.",
    eligibility: {
      gender: "female",
      condition: "pregnant or lactating, for first living child",
      excludes: ["women already receiving similar benefit as central/state government employee"],
    },
    docs: ["Aadhaar card", "MCP (Mother and Child Protection) card", "Bank account"],
    source: "Ministry of Women and Child Development, pmmvy.wcd.gov.in",
  },

  {
    id: "post-matric-scholarship-sc",
    name: "Post-Matric Scholarship for SC Students",
    level: "central",
    category: "education",
    benefit: "Tuition fee reimbursement + maintenance allowance for post-matriculation studies",
    description: "Financial assistance for Scheduled Caste students pursuing education after class 10.",
    eligibility: {
      category: ["sc"],
      isStudent: true,
      incomeMax: 250000, // central income ceiling for SC post-matric scholarship (₹2.5 lakh/annum family income)
      notes: "Income ceiling and top-up amounts vary somewhat by state implementation.",
    },
    docs: ["Caste certificate", "Income certificate", "Institution bonafide certificate", "Bank account"],
    source: "Ministry of Social Justice and Empowerment, scholarships.gov.in",
  },

  {
    id: "stand-up-india",
    name: "Stand-Up India",
    level: "central",
    category: "entrepreneurship",
    benefit: "Bank loans between ₹10 lakh and ₹1 crore for setting up a greenfield enterprise",
    description: "Facilitates bank loans to SC/ST and women entrepreneurs for new (greenfield) businesses in manufacturing, services, or trading.",
    eligibility: {
      category: ["sc", "st"],
      genderAlt: "female", // OR condition: SC/ST OR woman entrepreneur
      age: { min: 18 },
      businessType: "greenfield (first-time) enterprise, borrower must hold at least 51% shareholding/controlling stake",
    },
    docs: ["Business/project plan", "Identity and address proof", "Caste certificate (if applicable)"],
    source: "Department of Financial Services, standupmitra.in",
  },

  {
    id: "pmfby",
    name: "Pradhan Mantri Fasal Bima Yojana (PMFBY)",
    level: "central",
    category: "agriculture/insurance",
    benefit: "Crop insurance: farmer pays only 1.5–2% (Kharif/Rabi) or 5% (commercial/horticulture) of premium, rest subsidised",
    description: "Crop insurance against yield loss from natural calamities, pests, and diseases.",
    eligibility: {
      occupation: ["farmer"],
      condition: "must have insurable interest in the notified crop for the notified area (loanee and non-loanee farmers both eligible)",
    },
    docs: ["Land records", "Aadhaar card", "Bank account", "Sowing declaration"],
    source: "Ministry of Agriculture & Farmers Welfare, pmfby.gov.in",
  },
];

module.exports = { SCHEMES_SEED };
