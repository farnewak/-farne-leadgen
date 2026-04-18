import type { TechStackSignals } from "../models/audit.js";
import {
  FINGERPRINTS,
  MIN_MATCHES,
  type Fingerprint,
  type FingerprintSignal,
} from "./tech-fingerprints.js";

// Detection only scans the first 256KB of HTML. Tech signals almost always
// live in <head> or early <body>; scanning the whole 2MB-capped body is
// wasteful and increases regex-backtracking risk on adversarial content.
const HTML_SCAN_BYTES = 256 * 1024;

interface CookieToken {
  name: string;
}

function parseSetCookieHeader(
  raw: string | string[] | undefined,
): CookieToken[] {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  const out: CookieToken[] = [];
  for (const v of values) {
    const firstEq = v.indexOf("=");
    if (firstEq <= 0) continue;
    const name = v.slice(0, firstEq).trim();
    if (name) out.push({ name });
  }
  return out;
}

function signalMatches(
  signal: FingerprintSignal,
  html: string,
  headers: Record<string, string>,
  cookies: CookieToken[],
): boolean {
  if (signal.kind === "html-regex") {
    return signal.pattern.test(html);
  }
  if (signal.kind === "header") {
    const value = headers[signal.name];
    if (!value) return false;
    return signal.pattern.test(value);
  }
  // cookie
  return cookies.some((c) => signal.namePattern.test(c.name));
}

function countMatches(
  fingerprint: Fingerprint,
  html: string,
  headers: Record<string, string>,
  cookies: CookieToken[],
): number {
  let hits = 0;
  for (const s of fingerprint.signals) {
    if (signalMatches(s, html, headers, cookies)) hits += 1;
  }
  return hits;
}

function emptySignals(): TechStackSignals {
  return {
    cms: [],
    pageBuilder: [],
    analytics: [],
    tracking: [],
    payment: [],
    cdn: [],
  };
}

function lowercaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

// Matches every fingerprint against the response. A fingerprint registers if
// its signal matches meet MIN_MATCHES. Duplicate entries within a bucket are
// deduped (stable order preserved via FINGERPRINTS declaration order).
export function detectTechStack(
  bodyHtml: string,
  headers: Record<string, string>,
): { signals: TechStackSignals } {
  const truncated = bodyHtml.length > HTML_SCAN_BYTES
    ? bodyHtml.slice(0, HTML_SCAN_BYTES)
    : bodyHtml;
  const lower = lowercaseHeaders(headers);
  const cookies = parseSetCookieHeader(lower["set-cookie"]);

  const signals = emptySignals();

  for (const fp of FINGERPRINTS) {
    const hits = countMatches(fp, truncated, lower, cookies);
    if (hits >= MIN_MATCHES) {
      signals[fp.bucket].push(fp.id);
    }
  }

  return { signals };
}
