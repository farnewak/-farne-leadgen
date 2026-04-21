# Name-Leakage Discovery (Phase 7a)

Tracking TODO #30 in `CLAUDE.md`: several Tier-A rows from the Phase 6
Bezirk-1010 smoke (runs/phase6.db, 2026-04-21) carry Impressum-Fließtext
in `impressum_company_name` instead of a clean company name. Two known
bad samples:

- `osm:node:365865111` (caferonacher.com) →
  `Ernst Kankovsky ​ Telefon: +43 (0) 1 - 512 72 79 ​ E-Mail: info@caferonacher.com ​ Website: www.cafe`
- `osm:node:333302666` (deineapotheke.at) →
  `Österreichische Apotheker-Verlagsgesellschaft m.b.H.Unternehmensgegenstand:Herausgabe und Verschleiß`

This document is **discovery only** — no production code changes.

---

## 1. Data-flow map

The Stage-1 CSV `name` column is derived at export time by
`src/pipeline/export.ts:331`:

```ts
const name = row.impressumCompanyName ?? hostnameFallback(row.discoveredUrl);
```

So "leakage in the CSV `name` column" is always leakage in
`audit_results.impressum_company_name` — the export layer is a passive
coalesce with a hostname fallback and does no mutation of its own.

`audit_results.impressum_company_name` has exactly **two write sites**
(`grep impressumCompanyName:` across `src/`):

| # | File:line                                      | Tier | Source of value                       |
|---|------------------------------------------------|------|---------------------------------------|
| 1 | `src/pipeline/audit-row-builders.ts:99`        | B1/B2/B3/C | Hardcoded `null` in `buildEmptyTierRow` |
| 2 | `src/pipeline/audit-row-builders.ts:161`       | A          | `signals.impressum.companyName` in `assembleAuditRow` |

Row-builder #2 is the only path that carries a non-null value. The
content of `signals.impressum` is built in two layers, both of which can
contribute a `companyName`:

```
runAudit (src/pipeline/audit.ts:116)
 └─ processOne
     └─ auditOne
         ├─ scrapeContacts  (src/pipeline/audit.ts:436)
         │   → enrichImpressumContacts (src/pipeline/enrich.ts)
         │     → scrapeImpressum       (src/tools/enrich/impressum-scraper.ts:329)
         │       → parseImpressumPage   (impressum-scraper.ts:267)
         │         → extractCompanyName(body)   ← src/pipeline/impressum-parsers.ts:87  ★
         │
         └─ buildTierARow (src/pipeline/audit.ts:548)
             └─ gatherSignals
                 └─ fetchAndParseImpressum (src/pipeline/impressum.ts:134)
                   → parseImpressumHtml (impressum.ts:88)
                     → extractCompanyName(bodyText) ← impressum-parsers.ts:87  ★
             └─ mergeImpressum (audit.ts:463)
                 → legacy.companyName ?? scraped.companyName     (legacy wins)
             └─ assembleAuditRow (audit-row-builders.ts:132)
                 → impressumCompanyName = signals.impressum.companyName
```

Both callers (`impressum.ts` legacy Tier-A path AND
`impressum-scraper.ts` P0 contact-coverage path) converge on the same
pure extractor, `extractCompanyName()` in
`src/pipeline/impressum-parsers.ts:87`. That single function is the
sole semantic owner of the company-name value that lands in
`audit_results.impressum_company_name`.

`extractCompanyName()` applies two heuristics in sequence on
whitespace-collapsed body text:

1. **`LABELED_NAME_REGEX`** (`impressum-parsers.ts:84`) —
   `(?:Firmenname|Firmenwortlaut|Unternehmen|Inhaber|Medieninhaber)\s*:\s*([^\n\r<]{2,100})`
2. **`COMPANY_NAME_REGEX`** (`impressum-parsers.ts:80`) —
   `[A-ZÄÖÜ][\wÄÖÜäöüß&.,'\- ]{1,80}?\s(?:GmbH|AG|OG|KG|e\.U\.|…)`

**Transformations, caps, terminators, heuristics present today:**

| Concern                          | Labeled regex | Legal-form regex | Scraper post-processor | Row assembler |
|----------------------------------|---------------|------------------|------------------------|---------------|
| Length cap                       | 100 chars     | 80 chars         | none                   | none          |
| Newline terminator               | `[^\n\r<]` — but text is pre-normalised via `.replace(/\s+/g, " ")` on line 89 BEFORE regex runs, so **the `\n\r` exclusion is dead code** | n/a | none | none |
| Keyword stop (telefon/email/…)   | none          | none             | none                   | none          |
| Trim / trailing punct strip      | `.trim().replace(/[.,;]+$/, "")` on labelled branch | `.trim()` only | none | none |
| Whitespace collapse              | yes (pre-regex) | yes (pre-regex) | n/a (scraper body passes raw HTML to parser) | n/a |

Other candidates evaluated:

- **OSM name.** `src/tools/datasources/osm-overpass-mapping.ts:42` maps
  `name = tags.name ?? tags.brand ?? null`. Single OSM tag, no
  concatenation. Lands on `PlaceCandidate.name`, NEVER on
  `impressum_company_name`. The CSV column `name` reads
  `impressumCompanyName ?? hostnameFallback(...)` (export.ts:331), so
  OSM-sourced names only appear via the `candidates.name` data-model
  path — they cannot leak into `impressum_company_name`.
- **Google Places.** `src/tools/datasources/google-places.ts`
  `findPlaceByQuery` returns `{formattedAddress, businessStatus,
  displayName}`. Merged by `mergeEnrichment()`
  (`src/pipeline/enrich.ts:155`) into candidate fields only.
  `candidate.name` never flows into `impressum_company_name`.
- **Phase 6b candidate-address fallback.**
  `audit-row-builders.ts:167` writes
  `impressumAddress: signals.impressum.address ?? candidate.address`.
  Writes to `impressum_address`, NOT `impressum_company_name`.

---

## 2. Quantitative evidence (runs/phase6.db, 2026-04-21)

Canonical DB: `runs/phase6.db` (SQLite). Queried via `sqlite3` CLI.

### Tier-A population and length distribution

| metric                                              | value |
|-----------------------------------------------------|------:|
| total Tier-A rows                                   | **46** |
| rows with `length(impressum_company_name) > 80`     | **11** |
| rows with `impressum_company_name` LIKE Impressum-boilerplate (Telefon/E-Mail/Unternehmensgegenstand/Firmenbuchnummer/Gerichtsstand/Fax) | **2** |

The `name` column in `audit_results` does not exist — it's derived at
export time from `impressum_company_name` via
`rowToExportShape` (`src/pipeline/export.ts:331`), so the answer to
"rows where `name > 80` or `name` matches the boilerplate regex" is by
construction identical to the `impressum_company_name` rows above (the
hostname fallback only fires when `impressum_company_name` is null).

### Top-10 longest `impressum_company_name` in Tier-A

| # | place_id                 | len | value (truncated to 110 chars)                                                                        | impressum_url |
|---|--------------------------|----:|-------------------------------------------------------------------------------------------------------|---------------|
| 1 | `osm:node:312253426`     | 100 | `Apotheke zu unserer lieben Frau bei den Schotten, Mag.pharm. Höbinger KG Adresse: Freyung 7, 1010 Wi` | schottenapotheke.at/impressum.html |
| 2 | `osm:node:334641013`     | 100 | `Perkins und Rosenberg Gesellschaft m.b.H (Pickwicks) Firmengericht: Handelsgericht Wien GLN: 9110015` | pickwicks.at/impressum.html |
| 3 | `osm:node:334636027`     | 100 | `Toko-Ri Gastronomie GmbH Gonzagasse 3/II 1010 Wien Behörde gem. ECG (E-Commerce Gesetz): Magistratis` | noa.wien/impressum/ |
| 4 | `osm:node:334634698`     | 100 | `Menü Speisekarte Schmankerl Wochenmenü Galerie Kontakt Impressum Impressum Hamzo Gesellschaft m.b.H.` | toni-s.at/impressum/ |
| 5 | `osm:node:365865111`     | 100 | `Ernst Kankovsky ​ Telefon: +43 (0) 1 - 512 72 79 ​ E-Mail: info@caferonacher.com ​ Website: www.cafe` | caferonacher.com/impressum |
| 6 | `osm:node:333302666`     | 100 | `Österreichische Apotheker-Verlagsgesellschaft m.b.H.Unternehmensgegenstand:Herausgabe und Verschleiß` | deineapotheke.at/impressum-kontakt |
| 7 | `osm:node:411757173`     |  99 | `Peter Czaak Postgasse 15, A-1010 Wien Tel.: +43 (1) 513 72 15 email: beim@czaak.com UID: ATU588 383` | czaak.com/impressum |
| 8 | `osm:node:329464821`     |  86 | `KALE BILLARD-CARD JOBS Kontakt Impressum Datenschutz Impressum Johann Hirschhofer GmbH`              | billardcafe.at/de/impressum.html |
| 9 | `osm:node:319734659`     |  83 | `En Menü Menü Impressum VERKEHRSBUERO HOSPITALITY Palais Events Veranstaltungen GmbH`                 | cafecentral.wien/impressum/ |
| 10 | `osm:node:418164970`    |  83 | `Restaurant Speisekarte Reservieren Impressum Impressum Impressum Nigrum Montis GmbH`                 | nigrum-montis.at/impressum |

Six of the top ten land at exactly length 100 — the
`LABELED_NAME_REGEX` `{2,100}` cap. Three more (rows 8-10) land in the
80-86 range, consistent with the `COMPANY_NAME_REGEX` `{1,80}` cap
expanded to reach a trailing legal-form token.

The "top-10 longest `name`" table is identical by construction (name is
`impressumCompanyName ?? hostnameFallback(...)` at export time).

---

## 3. Root-cause hypotheses

### (a) Impressum scraper DOM selector too wide — **LIKELY** (primary root cause)

Evidence: `src/pipeline/impressum-parsers.ts:87-102`
(`extractCompanyName`) runs on `$('body').text()` with no DOM scoping.
The pre-regex normalisation `text.replace(/\s+/g, " ")` (line 89) kills
every newline, so the `[^\n\r<]` exclusion in `LABELED_NAME_REGEX` is
inert at runtime. The only remaining stop condition is the `{2,100}`
length cap, which is why six of ten bad rows land at exactly 100
chars.

The `LABELED_NAME_REGEX` label list includes `Unternehmen` with a
tolerant `\s*:\s*` separator. In the Apotheker case, that prefix-
matches `Unternehmensgegenstand:` (word "Unternehmen" followed by
`\s*` zero-width, then `:`), which is why the captured group started
at "Herausgabe und Verschleiß" for that row — except that in the
actual stored string the capture instead swept up "Österreichische
Apotheker-Verlagsgesellschaft m.b.H." as the preceding legal-form hit
and ran 100 chars forward.

### (b) Places fallback accidentally pulls `formattedAddress` / `businessStatus` into name — **RULED OUT**

Evidence: `src/pipeline/enrich.ts:155` (`mergeEnrichment`) touches
`candidate.website` / `candidate.phone` / `candidate.address` only;
`candidate.name` is preserved from OSM. `candidate.name` never writes
into `impressum_company_name` (see data-flow map).
`src/tools/datasources/google-places.ts:131` assigns
`name: p.displayName.text` for a different return type used elsewhere,
never crossing into `impressum_company_name`.

### (c) OSM tag concatenation (name + operator + brand) — **RULED OUT**

Evidence: `osm-overpass-mapping.ts:42` reads a single tag with a
coalesce (`tags.name ?? tags.brand ?? null`). No concatenation. And
again, OSM-sourced `candidate.name` does not feed
`impressum_company_name`.

### (d) Phase 6b candidate-address fallback overflows into a name field — **RULED OUT**

Evidence: `audit-row-builders.ts:167` writes only to
`impressumAddress`, never to `impressumCompanyName`. The Phase 6b
change is limited to the address column.

### (e) Missing post-scraper sanitizer — **LIKELY** (secondary / force-multiplier)

Evidence: neither `scrapeImpressum` (`impressum-scraper.ts:329`) nor
`mergeParsed` (`impressum-scraper.ts:306`) nor
`assembleAuditRow` (`audit-row-builders.ts:132`) nor
`mergeImpressum` (`audit.ts:463`) apply any sanitation step. Anything
`extractCompanyName` returns lands verbatim in the DB. So the moment
the extractor misfires (hypothesis a), the bad value is fully carried
through: there is no safety net downstream.

### Not evaluated but worth flagging

- `COMPANY_NAME_REGEX` (`impressum-parsers.ts:80`) starts on the first
  capital letter of the entire body and walks lazily forward to the
  nearest legal-form token, with the only bound being the `{1,80}?`
  quantifier. Rows 8-10 in the top-10 table show it readily eats
  navigation text ("Menü Speisekarte", "Restaurant Speisekarte
  Reservieren", "KALE BILLARD-CARD JOBS Kontakt Impressum") up to the
  footer legal-form. This is a second bug in the same extractor,
  independent of hypothesis (a).

---

## 4. Fix-option catalogue

### Option A — Strict length cap + first-newline truncation at scraper output

Scope: `src/pipeline/impressum-parsers.ts` (extractor) — add a final
step `return value.split(/[\n\r]/)[0].slice(0, 80).trim()`.

Risk: LOW regression surface (one function, pure). BUT the body text
is pre-normalised to single-space before the regex runs, so the
newline split is effectively no-op on runtime input — only helps if we
ALSO stop normalising. That couples this change to a selector change
inside `parseImpressumHtml` / `parseImpressumPage`.

Effort: S.

Non-coverage: doesn't fix rows where the labelled regex captures
100 chars of inline garbage from a single `<p>` tag
(Apotheker-Verlag case) — still produces a truncated-but-still-dirty
80-char slice. Also doesn't fix the `COMPANY_NAME_REGEX` navigation-
leakage bug (rows 8-10).

### Option B — Selector tightening + legal-form regex fallback

Scope: `src/pipeline/impressum-parsers.ts:87-102` (reimplement the
extractor); both callers (`impressum.ts:99`,
`impressum-scraper.ts:292`) keep the same signature and pass raw HTML
instead of `$('body').text()`.

Approach: parse HTML with cheerio, walk for `<h1>` / `<strong>` /
first `<p>` inside an `.impressum` or `#impressum` container. Apply a
legal-form-anchored regex to that scoped text only. Fallback to the
current body-text extractor only when the scoped extraction returns
nothing AND the fallback result is `<= 60 chars`.

Risk: MEDIUM. Selector choice is site-specific; restructuring the
extractor signature will require updating both callers plus the
`parseImpressumHtml`/`parseImpressumPage` wrappers. Unit-test coverage
in `tests/unit/impressum-parsers.test.ts` and `scraper.test.ts` would
need expansion to hold line. Also sensitive to future CMS themes that
don't use `<h1>` for the company name.

Effort: M.

Non-coverage: sites that render the Impressum as a single unstyled
`<p>` block (Apotheker-Verlag pattern: `<strong>Name</strong><span>
Unternehmensgegenstand:</span>…` inside one `<p>`). The strong-tag
heuristic would actually rescue that specific case — but only because
Apotheker-Verlag happens to wrap the company name in `<strong>`, which
is not guaranteed.

### Option C — Downstream sanitizer applied regardless of source

Scope: new helper `sanitizeCompanyName()` in
`src/pipeline/impressum-parsers.ts`, called at the two write sites
(the extractor return, OR the row-builder).

Logic:
1. Split on first `\n` / `\r` / U+200B — take head.
2. Split on first boilerplate keyword from a closed list:
   `Telefon`, `Tel\.?`, `Fax`, `E-Mail`, `Email`, `Mobil`, `UID`,
   `ATU`, `FN\s*\d`, `Firmenbuch`, `Gerichtsstand`, `Handelsgericht`,
   `Unternehmensgegenstand`, `Geschäftsführer`, `Medieninhaber`,
   `Adresse`, `Website`, `Impressum`, `Datenschutz`, `Menü`,
   `Speisekarte`. Take head.
3. Hard cap at 80 chars.
4. Trim + strip trailing punctuation `[.,;:-]+$`.
5. Reject if result < 3 chars → return null.

Risk: LOW-MEDIUM. Pure string transform, strong regression coverage
via a fixture table. Risk is a false-positive drop of a legitimate
company name that happens to contain one of the keywords (e.g. a
firm literally called "Mobil-Service GmbH"). Mitigation: require the
keyword to be preceded by a colon OR whitespace + end-of-field marker.

Effort: S-M (implementation S; test-table M).

Non-coverage: doesn't fix the root regex bug in `LABELED_NAME_REGEX`,
just papers over it. Future changes to the regex still risk producing
garbage that the sanitiser then must be updated to catch.

### RECOMMENDATION

**Combine Option A + Option C.**

- **A** (length cap + newline-first truncation at extractor) fixes the
  immediate 100-char overflow that accounts for 6/10 of the observed
  bad rows. It's a two-line change and is independently test-covered
  via the existing `tests/unit/impressum-parsers.test.ts` harness.
- **C** (downstream sanitizer with keyword-stop list) catches the
  remaining 4/10 rows (including Kankovsky, where the 100-char
  capture starts with a clean name but overflows into "Telefon:…")
  and the navigation-leakage rows 8-10 where `COMPANY_NAME_REGEX`
  mis-starts on menu text.

Grounded in the top-10 table: five of ten bad rows contain the literal
string "Impressum" (nav leakage), three contain "Telefon:" or
"E-Mail:" (labelled-regex overflow), one contains
"Unternehmensgegenstand" (Apotheker-Verlag), and one
"Firmengericht:" (Pickwicks). A keyword-based downstream sanitiser
covers every observed pattern with minimal selector engineering and
no per-site heuristics. Option B (selector tightening) is deferred as
a future V2 — valuable in principle but too-invasive for P0.

Explicit non-goal: this recommendation keeps the existing
`extractCompanyName` extractor structure. Option B would be the right
answer if we were doing a clean rewrite, but for P0 the A+C sandwich
yields the highest bug-reduction per LOC touched.

---

## 5. Regression fixtures prepared (Phase 7b will wire them in)

Saved under `tests/fixtures/name-leakage/`:

| file                   | purpose |
|------------------------|---------|
| `kankovsky.html`       | Reproduces the caferonacher.com labelled-regex overflow (osm:node:365865111, stored value 100 chars). Zero-width-space separators preserved — they are the Wix/Squarespace flow-block artefact that survives `.replace(/\s+/g, " ")`. |
| `apotheker-verlag.html`| Reproduces the deineapotheke.at legal-form + `Unternehmen\s*:` prefix-match failure (osm:node:333302666, stored value 100 chars). Missing whitespace between adjacent inline elements preserved. |
| `clean-baseline.html`  | Happy-path regression-negative: Fladerei GmbH (osm:node:334634963, stored value "Fladerei GmbH", 13 chars). Any future fix must still return this exact string. |

**Provenance.** Live Impressum fetches were declined by the user
during this session, so the three fixtures are **reconstructed from
the stored database values** per the task spec's documented fallback
("otherwise reconstruct from whatever is stored"). Reconstruction
targets the exact string produced after
`cheerio.load(html).$('body').text().replace(/\s+/g, " ")`; a source
comment inside each fixture records the provenance and the target
string.

These fixtures are **not wired into tests yet** (Phase 7a is
discovery-only). Phase 7b will add a test file that feeds each fixture
through `parseImpressumHtml` (and/or `parseImpressumPage`) and asserts
the post-fix expected output:

- `kankovsky.html` → `"Ernst Kankovsky"` (labelled-regex head only)
- `apotheker-verlag.html` → `"Österreichische Apotheker-Verlagsgesellschaft m.b.H."` (strong-tag content OR keyword-stopped)
- `clean-baseline.html` → `"Fladerei GmbH"` (unchanged)

---

## Out of scope for this phase

- No production code changes.
- No commit. Only `docs/investigations/name-leakage-discovery.md` and
  `tests/fixtures/name-leakage/*.html` are staged for review.
- No Phase 7b implementation work. The fix option will be chosen and
  executed in the next explicit turn.
