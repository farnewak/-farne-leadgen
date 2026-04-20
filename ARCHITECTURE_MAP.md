# ARCHITECTURE_MAP.md

Stage-1 pipeline map for the Vienna SME lead-generation web audit.
Scope: every module that participates in tier classification (A / B1 / B2 / B3 / C),
score computation, `score_breakdown` assembly, website-presence detection,
CMS detection, and row serialization.

Repo root: `/Users/arnerunger/web-agent/farne-leadgen`
Language: TypeScript (strict, ESM), Node ≥22.12
Exported columns (authoritative — `EXPORT_COLUMNS` in `src/pipeline/export.ts`):
`place_id, tier, intent_tier, score, name, url, phone, email, email_is_generic,
address, plz, uid, impressum_complete, coverage, psi_mobile_performance,
ssl_valid, cms, has_social, audited_at, score_breakdown`
(20 columns — the 18 the prompt mentions plus `intent_tier` and `coverage`.)

---

## Pipeline entry point

- **`/Users/arnerunger/web-agent/farne-leadgen/src/cli/index.ts`** — `dispatch()` / default-exported CLI switch. Routes `audit | discover | export | label | export-labels` to the respective subcommand module. Invoked via `npm run leadgen` → `tsx src/cli/index.ts <cmd>`.
- **`/Users/arnerunger/web-agent/farne-leadgen/src/cli/audit.ts`** — `main()`. Parses `--limit`, `--force`, `--tier`, `--bezirk`; resolves the bezirk via `resolveBezirk()`; calls `runAudit()`.
- **`/Users/arnerunger/web-agent/farne-leadgen/src/pipeline/audit.ts`** — `runAudit(options)`. Top-level orchestrator. Discovers candidates, fans out to `processOne()` under the host-limiter, swallows per-lead failures. Tests inject a `discover` hook that bypasses network I/O — this is the authoritative entry hook for the regression test.

---

## Tier classification (A / B1 / B2 / B3 / C)

- **`src/pipeline/tier-classifier.ts`** — `classifyTier(input: TierInput): Tier`. Pure decision table: reachable+no-error → A; reachable+(CERT_EXPIRED|HTTP_5XX|DNS_FAIL) → C; else B1/B2/B3 by social/directory counts. `TIER_C_ERRORS` is the fixed triple of errors that mean "site is broken, not flaky".
- **`src/pipeline/audit.ts`** — `auditOne()` calls `classifyTier()`, then may override `tier="C" / intentTier="PARKED"` based on `detectParking()`. `classifyIntentTier()` derives the default intent-tier from tier + discovery outcome. Mapping after Phase 2A (FIX 4):
  - tier=A + discoveredUrl + no fetchError → **LIVE**
  - tier=C (classifier or parking-override) → **DEAD** (parking-override sets PARKED explicitly before this call)
  - tier=B3 (no discovered URL at all) → **DEAD_WEBSITE**
  - everything else (B1/B2 with social/directory signal) → **NONE**
- **`src/models/audit.ts`** — `TIERS`, `INTENT_TIERS`, `FETCH_ERRORS`, `DISCOVERY_METHODS` const arrays; `Tier`, `IntentTier`, `FetchError`, `DiscoveryMethod` types. `INTENT_TIERS = ["PARKED","DEAD","DEAD_WEBSITE","LIVE","NONE"]` — DEAD_WEBSITE is new in FIX 4, NONE retained for legacy rows.
- **`src/tools/probe/parking-detect.ts`** — `detectParking({ body, finalUrl, headers })`. Rewritten in FIX 1 from a 10-fingerprint library to a strict 2-of-3 co-signal rule. Signals: (a) `small-body` (body <1024 bytes), (b) `parking-text` (title or body regex: sedo/godaddy/namecheap/ionos/bodis/dan.com/uniregistry/afternic/parkingcrew, "for sale"/"to buy"/"coming soon"/"this domain"/"parked"/"default web page"), (c) `server-header` (Server: sedo|parkingcrew|bodis|afternic). Verdicts: ≥2 signals → `parked`, exactly 1 → `inconclusive` (fail-open, no override), 0 → `not-parked`. On `parked`, `auditOne()` reclassifies the Tier-A row to tier=C / intent_tier=PARKED.
- **`src/pipeline/dns-probe.ts`** — hardened in FIX 2. Returns a discriminated-union `DnsProbeResult = {found:true, candidateUrl, validated} | {found:false, reason: DnsProbeSkipReason}`. Skip reasons: `DNS_PROBE_DISABLED` (env-gate, `DNS_PROBE_ENABLED !== "true"` — unset by default), `NO_NAME` (null/empty/whitespace name), `BRANCH_NAME` (name contains filiale/standort/zweigstelle after umlaut-fold + lowercasing), `NO_CANDIDATES`, `NO_RESOLVABLE_DOMAIN`. Caller in `audit.ts` guards on `dns.found && dns.validated`.

## Website-presence detection (discovery → `discoveredUrl`)

- **`src/pipeline/audit.ts`** — `runDiscovery(candidate)` + `probeHome(url, method, base)`. Precedence: OSM `candidate.website` > DNS probe > CSE search > none. Single GET of the discovered URL; body reused downstream.
- **`src/pipeline/discover.ts`** — `discoverLeads({plz, maxLeads})`, `searchSeedWithFallback()`. Runs 16 seed queries via the datasource registry; dedupes; runs `filterChains()`.
- **`src/pipeline/dns-probe.ts`** — `discoverViaDns(candidate)`. Slug-based `{slug}.at` / `{slug}.com` probe; returns `{candidateUrl, validated}`.
- **`src/pipeline/cse-discovery.ts`** — `discoverViaCse(candidate)`. Google Custom Search Engine fallback. Off by default in tests via `CSE_DISCOVERY_ENABLED=false`.
- **`src/pipeline/enrich.ts`** — `enrichB3Candidate()`, `enrichImpressumContacts()`, `mergeEnrichment()`. B3 Google-Places fallback + aggressive Impressum scrape for phone/email/address.
- **`src/tools/datasources/osm-overpass.ts`** — `OsmOverpassSource.search()`, `buildOverpassQuery()`. Primary discovery source.
- **`src/tools/datasources/osm-overpass-mapping.ts`** — `elementToCandidate(el)`. Converts raw Overpass element → `PlaceCandidate` (the exact shape used by the regression fixture).
- **`src/tools/datasources/google-places.ts`** — `GooglePlacesSource.search()`, `findPlaceByQuery()`. Fallback discovery.
- **`src/tools/datasources/registry.ts`** — `getActiveSources()`. Registry of enabled data sources in priority order.
- **`src/tools/filters/chain-filter.ts`** — `filterChains()`, `classifyChainCandidate()`. Drops B2C mass-market chains (Billa, Spar, McDonald's, OMV, …) via blacklist + token+brand triple-match; premium whitelist takes precedence.
- **`src/pipeline/classify.ts`** — `classifyIndustry(types, primaryType)`, `primaryCategoryKey()`. Maps OSM/Places types → 7-industry bucket.
- **`src/pipeline/classify-osm.ts`** — `OSM_TAG_TO_GPLACES_KEY`, `findOsmTagKey(tags)`. OSM `key=value` → Places primary-type mapping.

## CMS detection

- **`src/pipeline/tech-stack.ts`** — `detectTechStack(bodyHtml, headers) → {signals: TechStackSignals}`. Scans the first 256 KB of HTML + response headers + set-cookies against `FINGERPRINTS`. Returns a `TechStackSignals` with six buckets; `cms` is the bucket the exporter surfaces.
- **`src/pipeline/tech-fingerprints.ts`** — `FINGERPRINTS` (declarative list of vendor fingerprints), `MIN_MATCHES`, `Fingerprint`/`FingerprintSignal` types. Drives both CMS detection (WordPress, Wix, Jimdo, Joomla, …) and analytics/tracking/payment/cdn buckets.
- **Exporter serialization** — `rowToExportShape()` in `src/pipeline/export.ts` flattens `techStack.cms: string[]` to the CSV `cms` column via `row.techStack.cms.join(",")`.

## Static signal extraction (Tier-A only)

- **`src/pipeline/ssl-check.ts`** — `checkTransport(host)`. Resolves `sslValid`, `sslExpiresAt`, `httpToHttpsRedirect`.
- **`src/pipeline/viewport-check.ts`** — `checkViewport(body) → {hasViewportMeta, viewportMetaContent}`.
- **`src/pipeline/impressum.ts`** — `fetchAndParseImpressum(url) → ImpressumData`. Two-stage path crawler; returns `{present, url, uid, companyName, address, phone, email, complete}`.
- **`src/pipeline/impressum-parsers.ts`** — Individual field parsers (UID ATU-regex, company-name, address, phone, email) shared by `impressum.ts` and `impressum-scraper.ts`.
- **`src/tools/enrich/impressum-scraper.ts`** — `scrapeImpressum(candidate, opts)`. Aggressive scraper with /impressum /imprint /kontakt /legal /about fallback chain; libphonenumber-js E.164 normalization; robots-respect fail-closed; per-host 7-day cache.
- **`src/tools/enrich/email-extract.ts`** — `extractEmails()`, `prioritizeEmails()`. HTML-entity + "[at]" / "(dot)" deobfuscation; noise filter for technical mails.
- **`src/pipeline/social-links.ts`** — `extractSocialLinks(body) → SocialLinks`. Scans anchors for facebook/instagram/linkedin/xing/twitter/youtube/tiktok hostnames.
- **`src/pipeline/schema-org.ts`** — `detectSchemaOrg(body) → {hasSchemaOrg}`. JSON-LD + microdata presence check. Emits `HAS_STRUCTURED_DATA -1` in the score breakdown.
- **`src/pipeline/psi.ts`** — `runPsiMobile(url) → {performance, seo, accessibility, bestPractices, fetchedAt, error}`. PageSpeed Insights mobile strategy; rate-limited; error-typed.
- **`src/pipeline/robots.ts`** — `getRobotsRules(origin) → {allowed(path)}`. Per-origin robots.txt cache. `AUDIT_RESPECT_ROBOTS_TXT=false` in tests.

## Score computation + `score_breakdown` assembly

- **`src/pipeline/score.ts`** — the single source of truth for scoring.
  - `SCORING_WEIGHTS` (const) — signed weights (-1 … +12); `NO_WEBSITE=10`, `DOMAIN_REGISTERED_NO_SITE=12`, `DEAD_WEBSITE=9`, `ONLY_SOCIAL=7`, `ONLY_DIRECTORY=6`, …, `HAS_STRUCTURED_DATA=-1`, `PSI_EXCELLENT=-1`.
  - `scoreBreakdown(input: ScoreInput) → BreakdownEntry[]` — pure; ordered; for B1/B2/B3/C only the tier-bucket signal is emitted; for A every signal is evaluated.
  - `computeScore(input) → number` — sum over breakdown, clamped to `[0, 30]`.
  - `ScoreInput`, `BreakdownEntry`, `ScoreWeightKey` types.
- **`src/pipeline/audit-row-builders.ts`** — `buildEmptyTierRow()`, `assembleAuditRow()`, `buildRobotsDisallowedRow()`, `emptyTechStack()`. Both row factories call `computeScore()` and attach the numeric `score`; the breakdown itself is **not** persisted — the exporter recomputes it via `rebuildScoreInput()`.
- **`src/pipeline/audit.ts`** — `buildTierARow()` calls `computeScore()` once per Tier-A candidate.
- **Export-time `score_breakdown` assembly** — `src/pipeline/export.ts`:
  - `rowToExportShape(row, opts)` — reads the persisted audit row, calls `assertExportInvariants(row)` first, then rebuilds `ScoreInput` via `rebuildScoreInput()`, calls `scoreBreakdown()`, compares the sum against the stored `row.score`. `ExportRow.score` is typed `number | null`; `filterRows` drops null-score rows and `sortRows` sinks them with `-Infinity`.
  - `assertExportInvariants(row)` (FIX 3) — four hard throws on inconsistent persisted state:
    1. score non-null → tier non-null
    2. intent_tier non-null → score non-null (unless intent_tier ∈ `AUDIT_ERROR_INTENT_TIERS = {AUDIT_ERROR, TIMEOUT}`)
    3. tier='C' → intent_tier ∈ `TIER_C_ALLOWED_INTENT_TIERS = {null, AUDIT_ERROR, TIMEOUT, PARKED}` (DEAD on a C-row throws — DEAD lives on B3 post-FIX-4, PARKED is the only C-bucket intent with a numeric score)
    4. tier='C' with a null/error intent_tier → score must be null. FIX 3 removed the earlier `row.score ?? recomputed` fallback so this invariant actually fires instead of being silently papered over.
  - `HAS_STRUCTURED_DATA` inference block: since this signal is *not* persisted on `audit_results`, a gap of exactly `+1` between recomputed and stored score injects a synthetic `{key:"HAS_STRUCTURED_DATA", delta:-1}` entry. Any other non-zero gap emits a WARN.
  - See open-work-items #22 in `CLAUDE.md`.

## Results serialization

- **`src/pipeline/export.ts`** — `ExportRow` interface, `EXPORT_COLUMNS` (ordered), `rowToExportShape(row)`, `filterRows()`, `sortRows()` (score DESC, audited_at DESC), `toCsv(rows)` (EU-Excel BOM + `;` separator + CRLF), `toJson(rows)` (ISO dates, structured breakdown), `buildCoverage(phone, email, address)`, `hostnameFallback(url)`, `extractPlzFromAddress(address)`.
- **`src/cli/export.ts`** — `main()`. CLI for CSV/JSON dump; accepts `--bezirk`, `--plz`, `--tier`, `--min-score`, `--max-score`, `--limit`, `--format`, `--output`.
- **`src/db/export-queries.ts`** — `loadAuditRows()`. Drizzle query that feeds rows into `rowToExportShape()`.

## Persistence

- **`src/db/audit-cache.ts`** — `checkAuditCache(placeId)`, `upsertAudit(row)`, `markAuditError()`. Dialect-switching over SQLite (default) / Postgres. `UpsertAuditInput` is the wide input shape the row-builders produce.
- **`src/db/schema.sqlite.ts`** — `auditResults` table definition; `AuditResult` = `auditResults.$inferSelect`. `score_breakdown` is not a column; computed at export time.
- **`src/db/schema.pg.ts`** — Postgres mirror of the SQLite schema.
- **`src/db/schema.ts`** — Re-export façade; app code MUST import from here, not from the dialect-specific files.
- **`src/db/migrations/sqlite/*.sql`** — `0000_init`, `0001_audit_results`, `0002_intent_tier`, `0003_lead_outcomes`. SQLite has no CHECK constraint on `intent_tier` (the SQLite driver never emitted one), so FIX 4's DEAD_WEBSITE value needs no SQLite migration.
- **`src/db/migrations/pg/*.sql`** — PG mirror. `0004_intent_tier_dead_website` drops and recreates `audit_results_intent_tier_check` to include DEAD_WEBSITE (FIX 4).

## Domain models

- **`src/models/types.ts`** — `PlaceCandidate` (the pipeline-input record), `Industry`, `LeadStatus`, `ChainFlag`, `ContactSource`. `PlaceCandidate` shape: `{placeId, name, address, plz, district, types, primaryType, website, phone, lat, lng}` — this is what the regression fixture feeds into `runAudit({discover})`.
- **`src/models/audit.ts`** — `TIERS`, `INTENT_TIERS`, `FETCH_ERRORS`, `DISCOVERY_METHODS`, `TechStackSignalsSchema`, `SocialLinksSchema`, `ImpressumDataSchema` (zod).

---

## Test framework

The project uses **Vitest 2.1.8** (already configured via `package.json` → `"test": "vitest run"`, `"test:watch": "vitest"`). No scaffolding required.

Snapshot tooling: Vitest's built-in inline snapshots (`expect(...).toMatchInlineSnapshot(...)`) are used for the regression lock, per the prompt's "vitest with inline snapshots" option. No additional dependency (syrupy or otherwise) is added.

Commit convention (from `git log`): **Conventional Commits** with scope, e.g.
`feat(enrich): …`, `fix(cli): …`, `test(discover): …`, `chore(registry): …`,
`docs(CLAUDE): …`. The regression commit therefore uses:

```
test(regression): lock stage1 baseline before refactor
```

---

## Regression anchor

- **`tests/fixtures/stage1_inputs.json`** — three `PlaceCandidate` records structurally identical to the output of `elementToCandidate()` in `src/tools/datasources/osm-overpass-mapping.ts`:
  - `R1_broken_site` — real business with valid URL, SSL issue, incomplete impressum.
  - `R2_chain_branch` — Spar franchise with `types=["shop=supermarket","brand:Spar"]`.
  - `R3_nameless_osm` — `name=null`, `url=null`, address-only record.
- **`tests/test_stage1_regression.test.ts`** — Vitest test that drives `runAudit()` via the `discover` hook, mocks SSL/HTTP/PSI via `undici`'s `MockAgent`, then reads the persisted `audit_results` rows + runs them through `rowToExportShape()` and snapshots the complete export row per fixture (all authoritative `EXPORT_COLUMNS`). The snapshot captures **current behavior as-is, bugs included** — it is a lock, not a spec.
