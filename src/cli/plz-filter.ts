// Phase 6b — PLZ-filter fallback. Background: the Bezirk-1010 smoke test
// persisted 51 audit rows but only 34 landed in the CSV because the filter
// looked up `plz` on the export row, which is derived exclusively from
// `impressum_address`. When the impressum scraper returned no address, the
// row silently dropped out — even though OSM had tagged the candidate 1010.
//
// The fix is a coalesce chain:
//     impressumPlz  →  osmAddrPostcode  →  Vienna-PLZ regex on name+url
// plus a CLI flag (`--plz-fallback`) to opt between reproducibility (strict,
// the pre-fix behaviour) and recall (permissive, the new default).

export const PLZ_FALLBACK_MODES = ["strict", "permissive", "off"] as const;
export type PlzFallbackMode = (typeof PLZ_FALLBACK_MODES)[number];

export interface PlzSources {
  // Extracted from impressum_address at export time (current behaviour).
  impressumPlz: string | null;
  // OSM candidate PLZ, carried through via impressum_address for B3 rows
  // and (after the audit-side fallback) for Tier-A rows with a failed
  // scraper. Nullable because discovery-only rows may lack addr tags.
  osmAddrPostcode: string | null;
  // Last-resort regex source: business name and discovered URL. Bias toward
  // false negatives — we only match word-boundary-isolated Vienna PLZs.
  name: string | null;
  url: string | null;
}

// Vienna PLZs are 1010, 1020, …, 1230 — strictly 1[0-2]X0. The word-boundary
// guards matter for hostnames like "shop1010.at" where "1010" is embedded in
// a larger word (we still match there because the preceding character is `p`
// via \w and 1 is \w, but the digit cluster is on a word boundary at its
// trailing `.`). Test coverage pins the exact behaviour.
const VIENNA_PLZ = /\b(1[0-2]\d0)\b/;

function extractViennaPlz(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(VIENNA_PLZ);
  return m?.[1] ?? null;
}

// Returns the effective PLZ used for the Bezirk filter, or null if the row
// should be dropped (strict/permissive) or skipped (off — caller short-
// circuits). `off` is surfaced as null too; the caller distinguishes.
export function effectivePlz(
  sources: PlzSources,
  mode: PlzFallbackMode,
): string | null {
  if (mode === "off") return null;
  if (sources.impressumPlz) return sources.impressumPlz;
  if (mode === "strict") return null;

  // permissive fallbacks
  if (sources.osmAddrPostcode) return sources.osmAddrPostcode;
  const fromName = extractViennaPlz(sources.name);
  if (fromName) return fromName;
  return extractViennaPlz(sources.url);
}

// CLI parser. Null / empty string → "permissive" (the new default). Invalid
// input throws; caller is expected to translate to a process.exit(1) with a
// user-visible message (mirrors the `--bezirk` / `--tier` contract).
export function parsePlzFallbackMode(raw: string | null): PlzFallbackMode {
  if (raw === null || raw === "") return "permissive";
  if ((PLZ_FALLBACK_MODES as readonly string[]).includes(raw)) {
    return raw as PlzFallbackMode;
  }
  throw new Error(
    `invalid --plz-fallback: ${raw} (allowed: ${PLZ_FALLBACK_MODES.join("|")})`,
  );
}
