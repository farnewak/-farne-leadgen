// Pure parsers for Impressum fields. Kept separate from the network-facing
// fetchAndParseImpressum() so each regex/heuristic is unit-testable against
// raw fixtures.

import { sanitizeCompanyName } from "./sanitize-company-name.js";

// ATU = Austrian VAT-ID prefix, followed by exactly 8 digits. Matches
// "ATU12345678", "ATU 12345678", "UID: ATU 1234 5678" — any whitespace
// between the digits is collapsed before validation.
const UID_REGEX = /AT\s*U\s*(\d[\d\s]{7,})/gi;

export function extractUid(text: string): string | null {
  if (!text) return null;
  const matches = text.matchAll(UID_REGEX);
  for (const m of matches) {
    const raw = m[1];
    if (!raw) continue;
    const digits = raw.replace(/\s+/g, "");
    if (digits.length >= 8) {
      return `ATU${digits.slice(0, 8)}`;
    }
  }
  return null;
}

// Austrian phone numbers start with "+43", "0043", or "0" followed by an area
// code. We grab up to 20 chars of trailing digits/spaces/dashes/slashes/parens
// so international formats like "+43 1 234 5678-9" survive.
const PHONE_REGEX =
  /(?:\+\s*43|0043|\b0)[\s\-/().\d]{6,24}\d/g;

export function extractPhone(text: string): string | null {
  if (!text) return null;
  const matches = text.match(PHONE_REGEX);
  if (!matches) return null;
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    // Austrian numbers are 7–13 digits. Rejects false positives like
    // order IDs "0012345" embedded in body copy.
    if (digits.length >= 7 && digits.length <= 13) {
      return raw.replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

// Austrian postal codes: 4 digits. Address regex looks for
// "<street> <number>, <plz> <city>" and tolerates HTML whitespace collapse.
// Deliberately permissive — we only need *an* address string, not canonical.
const ADDRESS_REGEX =
  /([A-ZÄÖÜ][\wÄÖÜäöüß.\- ]{2,60}?\s+\d{1,4}[a-zA-Z]?(?:\s*[-/]\s*\d{1,4})?)[,\s]+(\d{4})\s+([A-ZÄÖÜ][\wÄÖÜäöüß .\-]{2,60})/;

export function extractAustriaAddress(text: string): string | null {
  if (!text) return null;
  // Collapse whitespace so multi-line addresses in <p> tags match as one.
  const normalized = text.replace(/\s+/g, " ").trim();
  const m = normalized.match(ADDRESS_REGEX);
  if (!m) return null;
  const [, street, plz, city] = m;
  if (!street || !plz || !city) return null;
  return `${street.trim()}, ${plz} ${city.trim()}`;
}

// Company name detection relies on legal-form suffixes. The Austrian SME
// universe is dominated by GmbH, OG, KG, e.U. and AG; we prioritise those
// and fall back to "Firmenname:" / "Firmenwortlaut:" labels.
const LEGAL_FORMS = [
  "GmbH & Co KG",
  "GmbH",
  "AG",
  "OG",
  "KG",
  "e\\.U\\.",
  "eU",
  "Ges\\.m\\.b\\.H\\.?",
  "Gesellschaft m\\.b\\.H\\.?",
] as const;

// No trailing \b — some legal forms end in a period ("e.U.") so the usual
// word-boundary check would fail. Leading anchor + lazy quantifier + the
// whitespace-before-legal-form requirement together keep matches specific.
// Phase 7b: cap the preamble at 60 chars (was 80) so navigation text like
// "Menü Speisekarte … Firmenname GmbH" cannot stretch the greedy preamble
// to swallow the nav block. 60 covers any realistic Austrian company name
// including "Österreichische Apotheker-Verlagsgesellschaft" (47 chars).
const COMPANY_NAME_REGEX = new RegExp(
  `([A-ZÄÖÜ][\\wÄÖÜäöüß&.,'\\- ]{1,60}?\\s(?:${LEGAL_FORMS.join("|")}))`,
);

const LABELED_NAME_REGEX =
  /(?:Firmenname|Firmenwortlaut|Unternehmen|Inhaber|Medieninhaber)\s*:\s*([^\n\r<]{2,100})/i;

const MAX_NAME_LEN = 80;
const MIN_NAME_LEN = 3;

// Phase 7b Layer-A hardening: operate on raw `$('body').text()` (or whatever
// string the caller hands us) WITHOUT pre-collapsing whitespace. The
// cheerio body-text preserves block-boundary newlines; the LABELED regex's
// `[^\n\r<]` stop then actually does its job instead of being neutralised
// by `.replace(/\s+/g, " ")`. A final first-newline cut + 80-char cap +
// min-length gate catches the remaining overflow cases that happen inside
// a single flat paragraph (see Phase 7a discovery, Apotheker-Verlag).
export function extractCompanyName(text: string): string | null {
  if (!text) return null;

  const labeled = text.match(LABELED_NAME_REGEX);
  if (labeled?.[1]) {
    const value = finalize(labeled[1]);
    if (value) return value;
  }

  // Fallback to legal-form regex still requires some normalisation so that
  // soft-wrapped names like "Fladerei\n  GmbH" can match. Scope the
  // collapse to horizontal whitespace only, so structural paragraph
  // breaks are preserved for the first-newline cut inside finalize().
  const softCollapsed = text.replace(/[ \t]+/g, " ");
  const byForm = softCollapsed.match(COMPANY_NAME_REGEX);
  if (byForm?.[1]) {
    const value = finalize(byForm[1]);
    if (value) return value;
  }
  return null;
}

// Apply the Phase 7b per-match finalisation. Kept private so both regex
// branches go through the same pipeline (first-newline cut, stop-keyword
// sanitation, 80-char cap, trailing-punct strip, min-length gate).
// Delegates to sanitizeCompanyName() so the extractor and the row-builder
// share a single definition of "clean name" — layers remain independent
// (row-builder still calls sanitizeCompanyName on legacy cached values)
// but the semantics never drift between them.
function finalize(raw: string): string | null {
  const nlIdx = raw.search(/\r?\n/);
  const headOnly = nlIdx > -1 ? raw.slice(0, nlIdx) : raw;
  const trimmed = headOnly.trim();
  if (trimmed.length < MIN_NAME_LEN) return null;
  const sanitized = sanitizeCompanyName(trimmed);
  if (sanitized === null) return null;
  return sanitized.length > MAX_NAME_LEN
    ? sanitized.slice(0, MAX_NAME_LEN).trim()
    : sanitized;
}
