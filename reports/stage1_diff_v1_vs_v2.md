# Stage-1 schema diff: v1 → v2

Cross-version change log for the stage1 CSV/JSON export contract.
Each phase appends its own section here — older sections stay frozen
as an audit trail.

---

## Phase 6b correction — PLZ filter silently dropped Bezirk-scan rows

**Observed symptom.** Bezirk 1010 smoke (runs/phase6.db, 2026-04-21)
persisted 51 `audit_results` but `leadgen export --bezirk 1010` wrote
only **34 rows** to CSV. The 17-row gap was not explained by the
score window (defaults `--min-score 0 / --max-score 30` cover all
A1–A3 scores 0..10) nor by tier filters (no `--tier` set).

**Root cause.** `src/cli/export.ts` computed the filter PLZ exclusively
from `impressum_address` via `extractPlzFromAddress()`. The impressum
scraper returned no address for 14 of the 51 rows (all Tier-A with
a live website but no machine-readable impressum block). For those
rows `r.plz` was null and the filter dropped them — even though the
OSM-sourced `PlaceCandidate.address` clearly carried "… 1010 Wien"
and the candidate landed in the bezirk seed in the first place.

**Baseline counts (pre-fix, runs/phase6.db).**

| metric | value |
| --- | --- |
| `audit_results` rows | 51 |
| rows with `impressum_address` non-null | 37 |
| rows with `impressum_address LIKE '%1010%'` | 34 |
| Tier-A rows with `impressum_address` null | 14 |
| CSV rows (strict, pre-fix) | 34 |
| CSV rows (permissive, pre-audit-refetch) | 34 |

**Fix.** Two-part, single commit:

1. **Export layer** — new `src/cli/plz-filter.ts` exposes
   `effectivePlz(sources, mode)` with a coalesce chain
   `impressumPlz → osmAddrPostcode → regex /\b(1[0-2]\d0)\b/ on
   name + url`. The CLI gains `--plz-fallback <strict|permissive|off>`;
   default is `permissive` (the new Phase-6b behaviour). `strict`
   reproduces pre-fix behaviour for reproducibility. `off` disables
   the PLZ filter entirely.
2. **Audit layer** — `assembleAuditRow` now carries
   `candidate.address` into `impressum_address` when the scraper
   returns no address. Mirrors the behaviour `buildEmptyTierRow`
   already had for B3 rows. This is the data path that makes
   `permissive` actually recover rows.

**Schema.** No changes to `STAGE1_COLUMNS` — the 25-column contract
stays frozen. `plz` is still position 14. The fix is filter-side
only; no migration bump.

**Post-fix CSV row count (after re-audit with `--force` + export
with `--plz-fallback permissive`, 2026-04-21).**

| metric | value |
| --- | --- |
| CSV rows (`--plz-fallback permissive`) | **48** |
| CSV rows (`--plz-fallback strict`) | 48 |
| CSV rows (`--plz-fallback off`) | 51 |
| delta vs. pre-fix (permissive) | +14 |
| rows with `impressum_address` non-null (post-refetch) | 51/51 |
| rows correctly excluded by 1010-filter | 3 |

`strict` matches `permissive` here because the audit-layer fallback
now writes the OSM candidate address into `impressum_address`
when the scraper returns none — so the old impressum-only regex
works on the enriched field. The two modes will diverge on rows
where OSM has no `addr:postcode` at all (those currently pass
nothing into `impressum_address`; in `permissive` the regex
fallback on `name`+`url` gets a last chance, in `strict` the row
drops).

The 3 correctly-excluded rows have impressum addresses outside
Bezirk 1010:

- `osm:node:269209053` — "Laxenburger Straße 43 bis 45, 1100 Wien"
  (Favoriten branch; business seeded in 1010 but HQ in 1100)
- `osm:node:269209054` — "Schönthalergasse 1, 1210 Vienna"
  (OSM tag says 1210)
- `osm:node:417322217` — "Niederschremser Straße 4b, 3943 Schrems"
  (Lower-Austria HQ with a 1010 operation)

These are legitimate drops — the user wants the CSV filtered by
the lead's filed address, not the seed bezirk.

**Out of scope for this turn.**

- Name-leakage in `impressum_company_name` (Impressum-Fließtext
  bleeds into the company-name column for some Tier-A rows).
  Tracked as TODO #30 in `CLAUDE.md`.
