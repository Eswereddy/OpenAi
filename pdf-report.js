// pdf-report.js
// NEW FEATURE — additive only, does not modify any existing file's logic.
//
// Turns a citizen's already-computed matches (from POST /api/match, or the
// on-device fallback engine — either way, produced entirely by schemes.js)
// into a downloadable PDF "eligibility summary" a citizen can print, carry
// to a CSC/e-mitra office, or attach when applying. This file never decides
// eligibility and never talks to an AI provider — it only lays out data the
// rule engine already returned, so there is nothing here that can drift from
// what the citizen saw on screen.
//
// Uses pdfkit (pure JS, no native build step — same "as few dependencies as
// the task needs" spirit as the rest of this repo). Rendered purely with the
// standard 14 PDF fonts, so output is always in Latin script regardless of
// the site's display language — Devanagari/Telugu glyphs aren't in those
// fonts. Scheme names/benefits are passed through as-is (they're stored in
// English in the catalog); this keeps the PDF reliable everywhere rather
// than silently producing tofu boxes for unsupported scripts.

const PDFDocument = require("pdfkit");

const STATUS_LABEL = {
  eligible: "Likely eligible",
  needs_verification: "Needs verification",
  not_eligible: "Not eligible (per answers given)",
  insufficient_info: "Not enough information",
};

function todayStamp() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// Builds the PDF into a Buffer and resolves with it — callers (server.js)
// pipe the buffer straight to the HTTP response. Keeping this file's public
// surface to one function keeps the integration point in server.js a single
// line, same pattern as every other feature module in this repo.
function buildEligibilityReportPdf({ profile, matches, catalogById }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const positive = (matches || []).filter(
        (m) => m.status === "eligible" || m.status === "needs_verification"
      );
      const other = (matches || []).filter(
        (m) => m.status === "not_eligible" || m.status === "insufficient_info"
      );

      // Header
      doc.fontSize(20).font("Helvetica-Bold").text("Am I Eligible? — Eligibility Summary", { align: "left" });
      doc.moveDown(0.2);
      doc.fontSize(10).font("Helvetica").fillColor("#555")
        .text(`Generated on ${todayStamp()} — for personal reference only. Not an official government determination.`);
      doc.fillColor("#000");
      doc.moveDown(1);

      // Profile snapshot (coarse attributes only — same fields the form
      // collects; no name/ID/phone is ever part of this app's data model)
      doc.fontSize(13).font("Helvetica-Bold").text("Your details");
      doc.moveDown(0.3);
      doc.fontSize(10).font("Helvetica");
      const p = profile || {};
      const profileRows = [
        ["Occupation", p.occupation || "—"],
        ["State", p.state || "—"],
        ["Age", p.age != null ? String(p.age) : "—"],
        ["Category", p.category || "—"],
        ["Monthly income", Number.isFinite(p.income) ? `Rs. ${p.income}` : "Not provided"],
      ];
      profileRows.forEach(([label, value]) => {
        doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(value);
      });
      doc.moveDown(1);

      // Positive matches
      doc.fontSize(13).font("Helvetica-Bold").text(`Schemes you may qualify for (${positive.length})`);
      doc.moveDown(0.3);
      if (!positive.length) {
        doc.fontSize(10).font("Helvetica").fillColor("#555")
          .text("No positive matches from the answers given.");
        doc.fillColor("#000");
      }
      positive.forEach((m, i) => {
        const scheme = (catalogById && catalogById[m.id]) || {};
        doc.fontSize(11).font("Helvetica-Bold").text(`${i + 1}. ${scheme.name || m.id}  —  ${STATUS_LABEL[m.status]}`);
        if (scheme.benefit) {
          doc.fontSize(9).font("Helvetica").fillColor("#333").text(`   Benefit: ${scheme.benefit}`);
        }
        if (scheme.dept) {
          doc.fontSize(9).font("Helvetica").fillColor("#333").text(`   Department: ${scheme.dept}`);
        }
        const met = (m.reasons && m.reasons.met) || [];
        if (met.length) {
          doc.fontSize(9).font("Helvetica").fillColor("#333").text(`   Matched on: ${met.slice(0, 3).join("; ")}`);
        }
        const watch = (m.reasons && m.reasons.watch) || [];
        if (watch.length) {
          doc.fontSize(9).font("Helvetica-Oblique").fillColor("#7a5c00").text(`   Verify: ${watch.slice(0, 2).join("; ")}`);
        }
        if (Array.isArray(scheme.docs) && scheme.docs.length) {
          doc.fontSize(9).font("Helvetica").fillColor("#333").text(`   Documents: ${scheme.docs.join(", ")}`);
        }
        doc.fillColor("#000");
        doc.moveDown(0.5);
      });

      // Other statuses, kept short — the honest full picture, same
      // philosophy as the on-screen results (schemes.js's own comment block)
      if (other.length) {
        doc.moveDown(0.5);
        doc.fontSize(12).font("Helvetica-Bold").text(`Other schemes checked (${other.length})`);
        doc.moveDown(0.2);
        other.forEach((m) => {
          const scheme = (catalogById && catalogById[m.id]) || {};
          doc.fontSize(9).font("Helvetica").fillColor("#555")
            .text(`• ${scheme.name || m.id} — ${STATUS_LABEL[m.status]}`);
        });
        doc.fillColor("#000");
      }

      doc.moveDown(1.5);
      doc.fontSize(8).font("Helvetica-Oblique").fillColor("#888")
        .text(
          "This document is generated by the \"Am I Eligible?\" prototype from self-reported answers. " +
          "It is not proof of eligibility and does not replace official verification. Confirm every scheme " +
          "at its official government portal or your local Common Service Centre (CSC) before applying.",
          { width: 495 }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildEligibilityReportPdf };
