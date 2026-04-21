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

## Chain handling

Two-stage chain-branch removal. Stage 1 (per-row, FIX 5) catches known chains by URL pattern; Stage 2 (batch, FIX 6) catches unknown chains by apex-domain repetition. Both stages log to CSV for audit trail; neither stage touches `audit_results` directly beyond the chain-columns on the canonical collapsed row.

**Stage 1 — `src/pipeline/chain-filter.ts`** (per-row, post-audit, pre-dedupe)
- `loadChainBranchPatterns(path)` parses `config/chain_branches.yml` (17 seeded Austrian B2C chains).
- `matchesChainBranch(url, patterns)` — host+path match, lowercased, `www.` stripped, IDN → punycode via `domainToASCII`. Glob `*` expands to regex `.+`.
- Matched rows are **removed** from stage-1 output; they never reach the DB.
- `appendFilteredChainBranchLog(entry, csvPath)` → `logs/filtered_chain_branches.csv` (columns: `place_id,chain_name,url,matched_pattern,reason,filtered_at`).
- Wiring: `src/pipeline/audit.ts` `processOne()` runs the check AFTER parking-detect (inside `auditOne`) and BEFORE the batch dedupe stage. Default config path `config/chain_branches.yml`; tests redirect via `logDir` option.

**Stage 2 — `src/pipeline/chain-apex-dedupe.ts`** (batch, post-audit, pre-upsert)
- `extractApex(url)` — eTLD+1 via `tldts.getDomain`; returns `null` for raw-IP and unparseable URLs (those pass through).
- `dedupeChainApices(rows, {auditApex, logDir, now})` groups Tier-A survivors by apex. Groups with ≥2 rows trigger ONE synthetic apex audit (memoised per apex); singletons + pass-throughs are unchanged.
- Decision at `BAD_APEX_SCORE_THRESHOLD = 5`:
  - **Score < 5 (clean apex)** — drop all branches; each logged to `logs/filtered_chain_branches.csv` with `matched_pattern='<apex-dedupe>'` and `reason='good_apex_branch — parent site scored <N>'`.
  - **Score ≥ 5 (bad apex) or null** — collapse the group into ONE canonical row using the apex audit body; overwrite `chain_detected=true, chain_name=<apex>, branch_count=N`. Each branch is archived to `logs/collapsed_branches.csv` (columns: `apex,chain_name,branch_place_id,branch_url,branch_score,collapsed_at`).
- Failed apex audit (`null` return) → branches pass through untouched (log-and-continue).
- Wiring: `src/pipeline/audit.ts` `runAudit()` collects per-row rows, calls `dedupeChainApices()`, then applies `--onlyTier` filter post-dedupe and batch-upserts survivors. Default apex auditor builds a synthetic `PlaceCandidate` with `placeId="apex:<apex>"` and runs the full `auditOne` path against `https://<apex>/`; tests inject via `auditApex` option.

**Schema columns** (migration `0004_chain_apex_dedupe.sql`, SQLite only — PG deferred to Phase 5):
- `chain_detected INTEGER NOT NULL DEFAULT 0` (boolean)
- `chain_name TEXT` (nullable; the apex eTLD+1)
- `branch_count INTEGER NOT NULL DEFAULT 1`

**Export invariants** (`src/pipeline/export.ts` `assertExportInvariants`):
- `branchCount` must be an integer ≥ 1.
- `chain_detected=true` ⇒ `chain_name` non-null AND `branch_count ≥ 2`.
- `chain_detected=false` ⇒ `chain_name=null` AND `branch_count=1`.

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

## Scoring rules

The scoring module (`src/pipeline/score.ts`) is the single source of truth
for how a lead's final numeric score is assembled. Keep this section in
sync whenever a weight, threshold, or sub-classification rule changes.

### Anchor: `NO_WEBSITE_PENALTY = 20`

`NO_WEBSITE_PENALTY` is exported as a named constant so that the
"no web presence at all" score always outranks every realistic Tier-A
record. Phase 2A field samples showed real Tier-A scores peaking at
≈14; the theoretical Tier-A maximum with every positive weight firing
simultaneously is 19. The anchor at 20 therefore leaves **6 points of
headroom** before the next tuning pass.

`SCORING_WEIGHTS.NO_WEBSITE` mirrors `NO_WEBSITE_PENALTY` and
`DOMAIN_REGISTERED_NO_SITE = NO_WEBSITE_PENALTY + 2 = 22` preserves the
business invariant `PARKED > NO_WEBSITE` (the owner has demonstrated
purchase intent by paying for the domain).

**Refactor rule.** If a new penalty raises the Tier-A ceiling to ≥19
(see catalogue below), raise `NO_WEBSITE_PENALTY` accordingly so the
6-point headroom is preserved, then update this section and the
anchor unit test that pins the literal value.

### Penalty catalogue

Tier-A penalties (additive; each signal independently present or absent):

| Key                     | Weight | Trigger                                     |
|-------------------------|-------:|---------------------------------------------|
| `NO_SSL`                |   +3   | SSL cert invalid / not served               |
| `NO_HTTPS_REDIRECT`     |   +2   | HTTP→HTTPS redirect missing                 |
| `NO_MOBILE_VIEWPORT`    |   +3   | `<meta name=viewport>` absent               |
| `PSI_POOR`              |   +3   | PSI mobile performance < 50                 |
| `PSI_MEDIUM`            |   +1   | 50 ≤ PSI < 75                               |
| `PSI_EXCELLENT`         |   -1   | PSI > 85 (signals no outreach need)         |
| `NO_IMPRESSUM`          |   +3   | Impressum absent (exclusive w/ next)        |
| `IMPRESSUM_INCOMPLETE`  |   +2   | Impressum present but fields missing        |
| `NO_UID`                |   +1   | Impressum present, UID (ATU…) missing       |
| `WIX_OR_JIMDO`          |   +2   | Budget-tier CMS detected                    |
| `NO_ANALYTICS`          |   +1   | No analytics tag detected                   |
| `NO_MODERN_TRACKING`    |   +1   | No pixel/conversion tracking detected       |
| `NO_SOCIAL_LINKS`       |   +1   | No social-media links on home page          |
| `HAS_STRUCTURED_DATA`   |   -1   | JSON-LD / microdata present (good signal)   |

Tier-bucket penalties (for non-A tiers the bucket IS the signal — no
signal-evaluation logic applies):

| Key                          | Weight | Applies to                       |
|------------------------------|-------:|----------------------------------|
| `NO_WEBSITE`                 |   +20  | Tier B3                          |
| `DOMAIN_REGISTERED_NO_SITE`  |   +22  | Tier C with `intent_tier=PARKED` |
| `DEAD_WEBSITE`               |    +9  | Tier C (all other cases)         |
| `ONLY_SOCIAL`                |    +7  | Tier B1                          |
| `ONLY_DIRECTORY`             |    +6  | Tier B2                          |

The final score is the sum over the emitted breakdown entries, clamped
to `[0, 30]`. Realistic Tier-A maximum today: **≈14**. Theoretical
Tier-A maximum: **19** (all positive weights; impressum-missing branch
forbids `NO_UID`, so max-impressum contribution is 3 either way).

### Sub-tier classification (`sub_tier`)

Derived at export time via `computeSubTier(tier, score)` in
`src/pipeline/score.ts`. Orthogonal to `tier`; persisted only on the
export row, not on `audit_results` (schema migration deferred).

| Sub-tier | Label           | Condition                          |
|----------|-----------------|------------------------------------|
| `A1`     | Katastrophe     | `tier='A'` ∧ `score ≥ 9`           |
| `A2`     | Ausbaufähig     | `tier='A'` ∧ `5 ≤ score ≤ 8`       |
| `A3`     | Eh ok           | `tier='A'` ∧ `score ≤ 4`           |
| `null`   | —               | Non-A tier OR null score           |

### Email classification (`email_is_generic`)

Three-valued, derived at export time via `classifyEmailGeneric(email)`
in `src/pipeline/email-classify.ts`. Replaces the old always-false
`genericEmails.includes(email)` check.

| Value    | Meaning                                                  |
|----------|----------------------------------------------------------|
| `null`   | No email discovered                                      |
| `1`      | Local-part matches generic role (info@, office@, büro@, …) |
| `0`      | Personal or otherwise non-role mailbox                   |

Matching is case-insensitive and German/Austrian Unicode-folded
(`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`) so `büro@` and `buero@` are
equivalent. Numeric suffixes ("info2@", "team3@") still classify as
generic. Role set covers international defaults (info, office, hello,
support, …) plus AT-specific roles (buero, kanzlei, praxis,
ordination, rezeption, empfang, anfrage, office1).

### Module layout

- **`src/pipeline/score.ts`** — `SCORING_WEIGHTS`, `NO_WEBSITE_PENALTY`, `scoreBreakdown()`, `computeScore()`, `computeSubTier()`. Pure; no I/O.
- **`src/pipeline/email-classify.ts`** — `classifyEmailGeneric()`. Pure; role set is an internal `Set<string>`.
- **`src/pipeline/audit-row-builders.ts`** — `buildEmptyTierRow()`, `assembleAuditRow()`, `buildRobotsDisallowedRow()`. Call `computeScore()` and attach the numeric score; breakdown is **not** persisted — the exporter recomputes it.
- **`src/pipeline/audit.ts`** — `buildTierARow()` calls `computeScore()` once per Tier-A candidate.
- **Export-time `score_breakdown` assembly** — `src/pipeline/export.ts`:
  - `rowToExportShape(row, opts)` — reads the persisted audit row, calls `assertExportInvariants(row)` first, then rebuilds `ScoreInput` via `rebuildScoreInput()`, calls `scoreBreakdown()`, compares the sum against the stored `row.score`. `ExportRow.score` is typed `number | null`; `filterRows` drops null-score rows and `sortRows` sinks them with `-Infinity`.
  - `assertExportInvariants(row)` (FIX 3 + FIX 6 + FIX 8 + FIX 9) — hard throws on inconsistent persisted state:
    1. score non-null → tier non-null
    2. intent_tier non-null → score non-null (unless intent_tier ∈ `AUDIT_ERROR_INTENT_TIERS = {AUDIT_ERROR, TIMEOUT}`)
    3. tier='C' → intent_tier ∈ `TIER_C_ALLOWED_INTENT_TIERS = {null, AUDIT_ERROR, TIMEOUT, PARKED}`
    4. tier='C' with null/error intent_tier → score must be null
    5. `chain_detected=true` ⇒ `chain_name` non-null ∧ `branch_count ≥ 2`; `chain_detected=false` ⇒ `chain_name=null` ∧ `branch_count=1`
    6. `sub_tier ∈ {A1,A2,A3}` ⇒ `tier='A'`; `tier='A'` with non-null score ⇒ `sub_tier ≠ null`
    7. `email_is_generic ∈ {0,1}` ⇒ email non-null; `email_is_generic=null` ⇒ email null (or malformed without `@`)
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
