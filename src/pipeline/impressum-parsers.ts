// Pure parsers for Impressum fields. Kept separate from the network-facing
// fetchAndParseImpressum() so each regex/heuristic is unit-testable against
// raw fixtures.

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
const COMPANY_NAME_REGEX = new RegExp(
  `([A-ZÄÖÜ][\\wÄÖÜäöüß&.,'\\- ]{1,80}?\\s(?:${LEGAL_FORMS.join("|")}))`,
);

const LABELED_NAME_REGEX =
  /(?:Firmenname|Firmenwortlaut|Unternehmen|Inhaber|Medieninhaber)\s*:\s*([^\n\r<]{2,100})/i;

export function extractCompanyName(text: string): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();

  const labeled = normalized.match(LABELED_NAME_REGEX);
  if (labeled?.[1]) {
    const value = labeled[1].trim().replace(/[.,;]+$/, "");
    if (value.length >= 2) return value;
  }

  const byForm = normalized.match(COMPANY_NAME_REGEX);
  if (byForm?.[1]) {
    return byForm[1].trim();
  }
  return null;
}
