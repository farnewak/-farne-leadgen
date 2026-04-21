// Layer-C defense against Impressum-body leakage into
// `audit_results.impressum_company_name`.
//
// Applied in src/pipeline/audit-row-builders.ts:assembleAuditRow, AFTER
// the extractor in src/pipeline/impressum-parsers.ts:extractCompanyName.
// The two layers are independent by design: the extractor can still
// misfire (e.g. a labelled-regex capture inside a single flat `<p>` with
// no newline boundaries — see the Apotheker-Verlag pattern in the Phase
// 7a discovery), and this sanitizer catches what slips through.
//
// Spec (Phase 7b):
//   1. null/undefined/empty  → null
//   2. cut at first \r?\n    (defensive — extractor should already)
//   3. cut before first stop-keyword (case-insensitive indexOf)
//   4. trim, strip trailing [:;,|\- ] characters, trim again
//   5. hard cap 80 chars
//   6. result shorter than 3 chars → null
//
// The trailing-strip character class deliberately excludes `.` so legal
// forms like "e.U." and "m.b.H." keep their terminal period.

export const NAME_STOP_KEYWORDS: string[] = [
  "Telefon",
  "Fax",
  "E-Mail",
  "UID",
  "ATU",
  "Firmenbuch",
  "Gerichtsstand",
  "Handelsgericht",
  "Unternehmensgegenstand",
  "Geschäftsführer",
  "Medieninhaber",
  "Adresse",
  "Website",
  "Impressum",
  "Datenschutz",
  "Menü",
  "Speisekarte",
  "Öffnungszeiten",
];

const MAX_LEN = 80;
const MIN_LEN = 3;

// Pre-lowered copy so every call does a single .toLowerCase() on the input
// instead of 18 × one per keyword.
const STOP_KEYWORDS_LC = NAME_STOP_KEYWORDS.map((k) => k.toLowerCase());

export function sanitizeCompanyName(raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  let value = raw;

  // Step 2 — first newline wins. Handles the rare case where the extractor
  // let a \n through (e.g. legacy cached values).
  const nlIdx = value.search(/\r?\n/);
  if (nlIdx > -1) value = value.slice(0, nlIdx);

  // Step 3 — stop-keyword cut. Earliest keyword wins. idx === 0 is
  // intentionally ignored: a name that BEGINS with a keyword ("Impressum
  // GmbH", if one ever existed) has nothing before to salvage, so we let
  // the length/min-length gates handle it below.
  const lower = value.toLowerCase();
  let cut = -1;
  for (const kw of STOP_KEYWORDS_LC) {
    const i = lower.indexOf(kw);
    if (i > 0 && (cut === -1 || i < cut)) cut = i;
  }
  if (cut > 0) value = value.slice(0, cut);

  // Step 4 — trim + strip trailing separators + trim again.
  value = value.trim().replace(/[:;,|\-\s]+$/, "").trim();

  // Step 5 — hard 80-char cap. Re-trim so a cap that lands mid-space
  // doesn't leave trailing whitespace.
  if (value.length > MAX_LEN) {
    value = value.slice(0, MAX_LEN).trim();
  }

  // Step 6 — min length gate.
  if (value.length < MIN_LEN) return null;
  return value;
}
