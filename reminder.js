// reminder.js
// NEW FEATURE: "🔔 Remind me" — a downloadable .ics calendar file so a
// citizen who matches a scheme today doesn't lose it in a browser tab they
// never reopen. This is aimed at a very specific drop-off point the rest of
// the app doesn't cover: everything up to now (summary, action plan,
// checklist, PDF, QR) helps someone understand and start their application
// *right now*, but welfare schemes routinely need a citizen to come back
// later — before the next sowing season for crop insurance, before a new
// academic year for a scholarship, or just "in a few weeks" to check on a
// pending verification. Without a reminder, that follow-up depends entirely
// on the citizen remembering — exactly the kind of thing this app exists to
// remove.
//
// Deliberately NOT a new AI touchpoint: this is pure calendar-file
// generation from data the app already has (scheme id + match status), in
// the same spirit as pdf-report.js and qrcode-report.js — a rendering layer,
// never a new source of truth about eligibility, dates, or deadlines. No
// server-side storage, no notifications infrastructure, no dependency:
// .ics is a plain text format any calendar app (Google Calendar, Outlook,
// the phone's native calendar) already knows how to import, which matters
// for the same low-end-device audience the rest of this app targets.
//
// Government welfare schemes mostly don't have one universal, fixed
// national deadline (that's the kind of specific, verifiable fact this app
// is careful never to assert on its own — see schemes.js's own rules about
// not inventing figures). Instead of guessing a real date, this module
// picks a sensible *follow-up horizon* per scheme category — "come back and
// check in N days/months" — and always frames the calendar event as a
// reminder to verify/apply, never as an authoritative deadline.

// Rough per-scheme follow-up horizon, in days from "today", plus the
// reminder's own title/note. Categories are picked from real-world
// application cycles for these schemes (documented in each scheme's own
// tag/benefit text in schemes.js) — not invented, just translated into a
// "when should I check back" number. Any scheme id not listed here falls
// through to a generic default below.
const SCHEME_REMINDER_PLAN = {
  // Crop insurance enrolment is tied to each sowing season, not a single
  // yearly date — remind well before the next season window rather than
  // claim a specific cut-off this app can't verify.
  pmfby: { days: 120, note: "Crop insurance enrolment windows open before each sowing season — check PMFBY's current cut-off before it closes." },
  // Scholarships reopen with the academic year.
  "nsp-postmatric": { days: 210, note: "Scholarship applications typically reopen for the new academic year — check the National Scholarship Portal for this year's window." },
  "nsp-prematric": { days: 210, note: "Scholarship applications typically reopen for the new academic year — check the National Scholarship Portal for this year's window." },
  nmms: { days: 210, note: "NMMS applications typically reopen for the new academic year — check the National Scholarship Portal for this year's window." },
  // Verification-heavy / ongoing schemes: a shorter nudge to actually follow
  // through, not a renewal.
  ayushman: { days: 30, note: "If your Ayushman Bharat card is still pending, this is a good time to check on it at your nearest CSC or hospital Ayushman desk." },
  pmay: { days: 45, note: "Housing scheme approvals can take a while — check your PMAY application status now." },
};
const DEFAULT_REMINDER_PLAN = { days: 60, note: "Revisit this scheme, confirm your documents are ready, and check whether you've completed every step." };

function planFor(schemeId) {
  return SCHEME_REMINDER_PLAN[schemeId] || DEFAULT_REMINDER_PLAN;
}

// Formats a JS Date as the UTC "floating-free" form .ics wants: YYYYMMDDTHHMMSSZ.
function toIcsDate(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Escapes text per RFC 5545 (commas, semicolons, newlines, backslashes).
function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

// Builds a single-event .ics calendar file for one matched scheme.
// `schemeName` / `statusLabel` come from the client's already-computed
// match (same data shown on the scheme card) purely for display text —
// this function makes no eligibility decision of its own.
function buildReminderIcs({ schemeId, schemeName, statusLabel }) {
  const plan = planFor(schemeId);
  const now = new Date();
  const due = new Date(now.getTime() + plan.days * 24 * 60 * 60 * 1000);
  // All-day-ish event: starts at 9am on the due date, no fixed end time
  // most calendar apps care about for a reminder — one hour is plenty.
  due.setUTCHours(9, 0, 0, 0);
  const dueEnd = new Date(due.getTime() + 60 * 60 * 1000);

  const title = `Follow up: ${schemeName || schemeId}`;
  const description = [
    statusLabel ? `Status when saved: ${statusLabel}.` : null,
    plan.note,
    "Generated by Am I Eligible? — this is a helpful nudge, not an official government deadline. Always confirm current dates on the scheme's own portal.",
  ].filter(Boolean).join("\\n\\n");

  // A stable-ish UID per scheme+day keeps re-downloading the same reminder
  // from updating the same calendar entry instead of duplicating it.
  const uid = `${schemeId}-${now.toISOString().slice(0, 10)}@am-i-eligible`;

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Am I Eligible//Scheme Reminder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsDate(now)}`,
    `DTSTART:${toIcsDate(due)}`,
    `DTEND:${toIcsDate(dueEnd)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(title)}`,
    "TRIGGER:-PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

module.exports = { buildReminderIcs, planFor };
