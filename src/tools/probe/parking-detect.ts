// HTML parking-page detector — strict 2-of-3 co-signal rule.
//
// Phase 2A tightened the classifier: the old single-signal rule
// (body < 1024 bytes → PARKED, plus a fingerprint library) produced
// false-positives on legitimate small sites. The new rule fires PARKED
// ONLY when at least TWO of three independent signals co-occur:
//
//   (a) small-body     — response body < 1024 bytes
//   (b) parking-text   — title starts with one of {for sale, to buy,
//                        coming soon, this domain, parked, default web
//                        page}, OR body matches a curated parking-
//                        provider vocabulary
//   (c) server-header  — HTTP Server header names a known domain-
//                        parking vendor (sedo, parkingcrew, bodis,
//                        afternic)
//
// Design rule (I3): on uncertainty the verdict is "inconclusive", NOT
// "parked". The classifier MUST NOT reclassify a legitimate small site
// to tier=C/intent_tier=PARKED; the scoring bonus is strong enough to
// poison rankings if it fires on the wrong row.

export const PARKING_VERDICTS = ["parked", "not-parked", "inconclusive"] as const;
export type ParkingVerdict = (typeof PARKING_VERDICTS)[number];

export const SIGNAL_IDS = ["small-body", "parking-text", "server-header"] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export interface ParkingDetectionInput {
  body: string;
  finalUrl: string | null;
  headers?: Record<string, string>;
}

export interface ParkingDetectionResult {
  verdict: ParkingVerdict;
  fingerprint: string | null;
}

const MIN_BODY_BYTES = 1024;

// Title must START with one of these tokens — a legitimate page whose
// body happens to contain "coming soon" inside a paragraph does not
// qualify.
const TITLE_PARKING_REGEX =
  /^\s*(for sale|to buy|coming soon|this domain|parked|default web page)/i;

// Body vocabulary chosen to name real parking/auction vendors by domain,
// plus two common sale-offer phrasings. Intentionally NOT a substring
// match on "parked" or "sale" alone — those words appear on legitimate
// sites (shops, second-hand listings, articles).
const BODY_PARKING_REGEX =
  /this domain is (?:for sale|parked)|buy this domain|godaddy|sedoparking|afternic|dan\.com|uniregistry|bodis/i;

// Server header emitted by known parking platforms. We are conservative:
// only names we have observed in real parking responses.
const SERVER_HEADER_REGEX = /sedo|parkingcrew|bodis|afternic/i;

function extractTitle(body: string): string {
  const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m?.[1] ?? "").trim();
}

function serverHeaderValue(headers?: Record<string, string>): string {
  if (!headers) return "";
  // Case-insensitive header lookup: undici lowercases, but be defensive.
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "server") return String(v ?? "");
  }
  return "";
}

function evaluateSignals(input: ParkingDetectionInput): SignalId[] {
  const body = input.body ?? "";
  const signals: SignalId[] = [];
  if (body.length < MIN_BODY_BYTES) signals.push("small-body");
  const title = extractTitle(body);
  if (TITLE_PARKING_REGEX.test(title) || BODY_PARKING_REGEX.test(body)) {
    signals.push("parking-text");
  }
  if (SERVER_HEADER_REGEX.test(serverHeaderValue(input.headers))) {
    signals.push("server-header");
  }
  return signals;
}

// Exported for tests and observability: lets callers introspect the
// inventory of signal ids the detector considers.
export function listFingerprintIds(): string[] {
  return [...SIGNAL_IDS];
}

export function detectParking(
  input: ParkingDetectionInput,
): ParkingDetectionResult {
  const signals = evaluateSignals(input);
  if (signals.length >= 2) {
    // Fingerprint surfaces WHICH signals concurred, so downstream logs can
    // distinguish "small+text" (common) from "small+header" (strong) etc.
    return { verdict: "parked", fingerprint: signals.join("+") };
  }
  // One signal alone is ambiguous; zero signals on a full-sized page is
  // healthy HTML. The caller MAY fall back to WHOIS on "inconclusive".
  if (signals.length === 1) {
    return { verdict: "inconclusive", fingerprint: null };
  }
  return { verdict: "not-parked", fingerprint: null };
}
