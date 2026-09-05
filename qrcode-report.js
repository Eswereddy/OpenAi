// qrcode-report.js
// NEW FEATURE — additive only, does not modify any existing file's logic.
//
// Renders a QR code PNG for arbitrary short text (in practice, a link back
// into this app with a citizen's own answers attached — see the "Share via
// QR" button in public/index.html). This file has no opinion about what the
// text means: it never reads a profile, never calls the rule engine, and
// never talks to an AI provider. It only turns a string into a scannable
// image, the same "one small, single-purpose module" shape as
// pdf-report.js.
//
// Uses the `qrcode` npm package (pure JS, no native build step — same "as
// few dependencies as the task needs" spirit as the rest of this repo).

const QRCode = require("qrcode");

const MAX_TEXT_LENGTH = 2000; // generous for a share URL with a full profile's worth of fields; well under what a QR code can hold at a scannable size

async function buildQrCodePng(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("text is required");
  }
  const trimmed = text.slice(0, MAX_TEXT_LENGTH);
  // Medium error-correction is a reasonable default for a code that might be
  // shown on a phone screen and scanned by another phone a foot away rather
  // than printed — enough resilience without bloating the module count for
  // a fairly long URL.
  return QRCode.toBuffer(trimmed, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
  });
}

module.exports = { buildQrCodePng, MAX_TEXT_LENGTH };
