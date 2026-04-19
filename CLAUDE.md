# farne-leadgen

Vienna SME lead-generation pipeline für farne-solutions.com. Findet Wiener
Kleinunternehmen mit schlechtem Webauftritt und bereitet sie als sortierte
Liste für Cold-Outreach auf.

## Ziel (v0.1)

- Discover: 100–500 Wiener KMU pro Run über **gratis Quellen** (Herold, WKO,
  Firmenbuch). Google Places nur falls `GOOGLE_MAPS_API_KEY` gesetzt ist.
- Audit: pro Lead SSL/Mobile/PageSpeed/Tech-Stack/Impressum prüfen.
- Score: Gewichtungsmodell → `score` 0–100 (höher = schlechterer Webauftritt
  = besserer Lead).
- Export: SQLite-DB (Historie) + CSV/Excel (Outreach-Liste).

## Stack

- Node.js ≥22.12, TypeScript (strict), ESM
- Drizzle ORM, SQLite lokal (`runs/leadgen.db`), Postgres-Pfad für v0.2
- Vitest für Tests, tsx als Runner
- Anthropic SDK für Opportunity-Snippet-Generierung (später)

## Wichtige Pfade

- `src/pipeline/` — discover, classify, audit, score, persist
- `src/tools/` — externe APIs / Scraper. `google-maps.ts` existiert, neue
  Quellen landen in `src/tools/datasources/`
- `src/db/` — Schema (SQLite + PG-Spiegel), Migrations, Client
- `src/lib/` — normalize, logger
- `src/models/types.ts` — Domain-Typen (Industry, Lead, AuditSignals)
- `config/chain-blocklist.yaml` — Ketten-Filter (Billa, Spar, McDonald's …)
- `tests/unit/` — Vitest-Unit-Tests

## Commands

- `npm install` — Dependencies
- `npm run db:migrate` — Schema anwenden (SQLite in `runs/leadgen.db`)
- `npm run db:generate` — neue Migration aus Schema-Änderungen generieren
- `npm run db:studio` — Drizzle Studio (DB-Browser) öffnen
- `npm test` / `npm run test:watch` — Vitest
- `npm run typecheck` — `tsc --noEmit`
- `npm run leadgen` — CLI-Entry (noch zu bauen: `src/cli.ts`)

## Konventionen

- Lead-IDs: Google-Quelle = raw `place_id`, andere = `<source>:<sha256>`
  (z. B. `herold:abc123…`). Nie direkt `google_place_id` nennen.
- Umlaute immer via `stripUmlauts`/`slugify`/`normName` aus
  `src/lib/normalize.ts` behandeln.
- DB-Writes: `raw_audit` hart auf 500 kB cappen (`MAX_RAW_AUDIT_BYTES`).
- SQLite-Schema und PG-Schema werden bis v0.2 manuell synchron gehalten —
  `schema.sqlite.ts` ist Wahrheit, `schema.pg.ts` spiegelt.
- Zod-Validierung für alle LLM-Outputs (siehe `OpportunityOutputSchema`).
- Sie-Form in allen deutschen Texten — erzwungen via Zod in Snippet-Schema.
- Keine Exclamation-Marks in Outreach-Copy.

## Chain-Filter

Statisch: `config/chain-blocklist.yaml`, substring-match auf `slugify(name)`.
Dynamisch: siehe `src/pipeline/chainfilter.ts` — Kette wenn >3 Standorte
über >=3 distinct Bezirke. Manuelle Overrides in `chain_overrides`-Tabelle.

## Offene Arbeitspakete (Reihenfolge)

1. DataSource-Abstraction — DONE für google-places + osm-overpass.
   audit_results-Tabelle DONE. Discovery/Signals/Scoring/Orchestrator
   DONE (B1–B4 auf feat/audit-pipeline).
   Offen: wko.ts (Phase 2), herold verworfen (AGB/§76c), firmenbuch →
   separater Enrichment-Step, kein DataSource.
2. `src/pipeline/audit.ts` — Orchestrator DONE (B4)
3. `src/pipeline/score.ts` — Gewichtungsmodell DONE (B4)
4. `src/pipeline/persist.ts` — writeSnapshot mit 500kB-Budget
5. `src/cli/` — CLI-Entry DONE für `audit`, Stub für `discover`/`export` (B4)
6. `src/cli/export.ts` — CSV-Export-Stub (B4). Finales Schreiben offen → #11
7. `src/pipeline/chainfilter.ts` — dynamische Ketten-Heuristik
8. OSM Discovery-Mode (quarterly): explorative Tag-Queries ohne
   Value-Filter (`nwr[shop](area.wien);`, `nwr[amenity](area.wien);` …),
   Value-Histogramme schreiben, manuell auf neue Kategorien sichten,
   `OSM_TAG_TO_GPLACES_KEY` entsprechend erweitern.
9. (reserved)
10. Feature-Branch `feat/audit-pipeline` — ready for merge review.
    B1–B4 done, 234 Tests grün, tsc clean.
11. CSV-Export CLI (`leadgen export`) — Stub; finale CSV-Schreibe + Filter
    (sort by score DESC, PLZ-filter, tier-filter) offen.
12. Scoring-Weights Tuning nach erstem Real-Run (≥200 Tier-A-Candidates).
13. PSI-Partial-Refresh: nur PSI neu holen wenn Static fresh aber PSI stale.
    Aktuell wird bei psi-stale der ganze Static-Pfad neu durchlaufen.
14. CSE-basiertes B1/B2-Tier-Mining: wenn Discovery keine eigene Website
    findet aber CSE-Treffer auf Social/Directory-Hosts liefert, Tier B1/B2
    statt B3 vergeben (aktuell pauschal B3).
22. Schema-Migration `has_structured_data` (bool) auf `audit_results` —
    aktuell via Export-Time-Inference aus dem score-gap zwischen stored
    und recomputed gefüllt (siehe `rowToExportShape` in
    `src/pipeline/export.ts`). Bei Migration: Inference-Block entfernen
    und Spalte in `rebuildScoreInput()` verdrahten.
23. [RESOLVED] Discovery-Resilience: per-seed Source-Fallback
    in `src/pipeline/discover.ts`. Bei Overpass-504/Timeout/beliebiger
    Exception einer Source fällt die Pipeline jetzt auf die nächste
    registrierte Source zurück (Priority-Reihenfolge). Vorher killte ein
    einzelner OSM-Ausfall den ganzen Audit-Run (3× beobachtet am
    2026-04-18 Samstag-Abend). Zusätzlich: `OVERPASS_URL` env-var support
    in `osm-overpass.ts` für Tests und Mirror-Override (alias zu
    `OVERPASS_ENDPOINT`).
24. [RESOLVED IN THIS PR] Präziser Filialketten-Filter (P0). B2C-
    Massenmarkt-Ketten (Supermärkte, Drogerien, Fast-Food, Tankstellen,
    Mobilfunk, Bank) werden in `src/tools/filters/chain-filter.ts`
    gedropt. Premium-Einzelbetriebe und Enterprise-Branchen bleiben via
    **Whitelist-Vorrang** IMMER drin (shop=jewelry/watches/antiques/art/
    gallery/boutique/interior_decoration/musical_instrument, office=
    lawyer/notary/engineer/architect/accountant/tax_advisor, amenity=
    arts_centre/gallery/auction_house) — auch bei international bekannten
    Namen wie Wempe oder Bucherer. Blacklist-Match ist strikt: OSM-
    Category aus fester Liste + Token-Subset im Namen + brand-Signal
    müssen alle zutreffen. Konfig in `data/chain-blacklist-wien.json`
    (≤30 Einträge) und `data/premium-whitelist.json`.
25. [RESOLVED IN THIS PR] Parked-Domain als Intent-Signal (P0). Neues
    Score-Gewicht `DOMAIN_REGISTERED_NO_SITE = +12` (stärker als
    `NO_WEBSITE +10` und `DEAD_WEBSITE +9`) kennzeichnet registrierte
    Domains ohne echte Website als HIGH-INTENT-Leads (Eigentümer hat
    bereits Kaufabsicht demonstriert). Umsetzung:
    - Neue `intent_tier`-Spalte auf `audit_results` (enum: PARKED, DEAD,
      LIVE, NONE) via Migration `0002_intent_tier.sql` + idx.
    - HTML-Fingerprint-Detektor `src/tools/probe/parking-detect.ts` mit
      10 Fingerprints (sedo, godaddy, namecheap, ionos, parkingcrew,
      bodis, server-default, coming-soon, empty-html, whmcs-cpanel).
      Default auf Unsicherheit: `inconclusive`, NICHT `parked` (I3).
    - Optionaler WHOIS-Fallback `src/tools/probe/whois.ts` (TCP/43,
      Timeout 3 s, fail-open → `registered: null`). Audit-Orchestrator
      ruft aktuell nur HTML-Detect; WHOIS bleibt als Library für spätere
      Integration verfügbar.
    - `src/pipeline/audit.ts` ruft `detectParking` nach dem Home-Fetch
      nur wenn `tier==="A" && discoveredUrl && homeBody`. Bei `parked`
      → `tier="C"`, `intentTier="PARKED"`. B3 (keine URL) bleibt
      unberührt.
    - Scorer `src/pipeline/score.ts`: Tier-C-Branch emittiert
      `DOMAIN_REGISTERED_NO_SITE` statt `DEAD_WEBSITE` wenn
      `intentTier==="PARKED"`. Andere Tiers ignorieren das Feld.
    - Export-Row trägt `intent_tier` als zusätzliche Spalte (Position
      nach `tier`, vor `score`).
26. [RESOLVED IN THIS PR] B3-Google-Places-Fallback (P0 Contact-Coverage).
    Tier B3 (kein Website in OSM gefunden) bekommt Google-Places-
    Enrichment: ggf. ist dort doch eine Website hinterlegt, oder
    zumindest Phone/Address. Ergebnis: weniger leere B3-Rows im CSV,
    bessere Kontaktdichte für Cold-Outreach. Umsetzung:
    - Neue `findPlaceByQuery(query)` in
      `src/tools/datasources/google-places.ts` (Text Search v1,
      Field-Mask auf websiteUri, nationalPhoneNumber,
      internationalPhoneNumber, formattedAddress, businessStatus,
      displayName).
    - Neuer Orchestrator `src/pipeline/enrich.ts` mit
      `enrichB3Candidate(candidate, opts)`. Cache per sha256(name+address)
      in `runs/places-cache/<hash>.json`, TTL via
      `PLACES_CACHE_TTL_DAYS` (Default 30). Quota-Guard via
      `runs/places-cache/quota.json` (UTC-day counter);
      `GOOGLE_PLACES_DAILY_QUOTA` Default 5000.
      Verdicts: `drop` (CLOSED_PERMANENTLY), `updated`, `no-match`,
      `skipped-quota`, `skipped-disabled`.
      `mergeEnrichment()` respektiert I6: OSM-Felder haben Priorität,
      Places füllt nur Lücken.
    - `src/pipeline/audit.ts` ruft Enrichment nur wenn
      `discovery.discoveredUrl === null` (B3 pre-classify). Bei
      `updated` + Website → neue probeHome-Runde mit
      `discoveryMethod="gplaces-tag"`, dann normale Tier-A-Pipeline.
      Bei `drop` → `auditOne` returned `null`, `processOne`
      überspringt den DB-Insert (Candidate fliegt aus dem Run).
    - `buildEmptyTierRow` surfaced `candidate.phone` /
      `candidate.address` als `impressum_phone` /
      `impressum_address` — damit enriched Kontakte im CSV sichtbar
      werden (I8: B3 ohne Website bleibt gültiger Lead-Tier für den
      Pitch "Wir bauen Ihre erste Website").
    - I9 (additiv): einziger Drop-Grund ist CLOSED_PERMANENTLY.
      Cache-Miss, Quota-Erschöpfung oder no-match lassen den
      Candidate unverändert als B3.
    - Neue env vars: `B3_ENRICHMENT_ENABLED` (Default true),
      `GOOGLE_PLACES_DAILY_QUOTA` (5000), `PLACES_CACHE_DIR`
      (./runs/places-cache), `PLACES_CACHE_TTL_DAYS` (30).
    - 6 neue Integrationstests in
      `tests/integration/b3-enrichment.test.ts` decken:
      Re-Klassifikation zu Tier A, CLOSED_PERMANENTLY-Drop,
      Quota-Skip, No-Match, Cache-Hit auf zweitem Aufruf,
      OSM-Priority bei Phone/Address-Merge.
27. [RESOLVED IN THIS PR] Aggressiver Impressum-Scraper (P0 Contact-
    Coverage). Zielkanäle sind Cold Mail + Cold Call + Persönlicher
    Besuch — jeder Lead braucht Phone + Email + Address. Umsetzung:
    - Neue Module `src/tools/enrich/email-extract.ts` und
      `src/tools/enrich/impressum-scraper.ts`.
    - Email-Extraction mit Deobfuscation (HTML-Entities &#64;/&#x40;,
      "[at]"/"(at)"/"(ät)"/"[æt]", "[dot]"/"(dot)") + mailto:-Hrefs.
      Noise-Filter strikt nur für technische Mails (noreply/webmaster/
      postmaster/abuse/admin@wordpress.org + example.com/test.com/
      domain.tld). Rollen-Mails (info@, office@, kontakt@, buero@, …)
      bleiben IM Output, werden aber hinter personalisierte Adressen
      sortiert (`prioritizeEmails`).
    - Scraper probiert /impressum, /imprint, /kontakt, /contact,
      /legal, /about, /ueber-uns; erster 200-OK gewinnt. Plus Footer-
      Link-Discovery auf der Home-Seite. Hartes Budget: 8 s Total-
      Deadline, 5 s/Request, max 3 Pages pro Domain.
    - Phone-Normalisierung zu E.164 via libphonenumber-js (Region AT);
      tel:-Hrefs haben Vorrang vor Body-Regex.
    - Wien-PLZ-Strict (1010..1230 Step 10) als Address-Quality-Gate:
      Nicht-Wien-PLZ → Adresse wird NICHT übernommen (I5).
    - Per-Domain File-Cache in `runs/impressum-cache/<sha256(host)>`,
      TTL 7 Tage (`IMPRESSUM_CACHE_TTL_DAYS`).
    - Robots.txt fail-closed: bei Disallow kein Request,
      `robotsBlocked=true` im Ergebnis. User-Agent
      `farne-leadgen/1.0 (Wien local business research)`.
    - Wiring in `src/pipeline/enrich.ts` als `enrichImpressumContacts`
      (nach B3-Enrichment). `src/pipeline/audit.ts` ruft den Scraper
      für jeden Candidate mit Website; Phone/Address werden mit
      OSM-Priorität in den Candidate gemerged, E-Mail + UID +
      companyName füllen Lücken in der Tier-A `ImpressumData`.
    - Neue Export-Column `coverage` ("P"/"E"/"A"/"PE"/"PA"/"EA"/
      "PEA"/""): Union der vorhandenen Kanäle pro Row. Treibt
      Outreach-Targeting ("≥PEA ist bereit für alle drei Kanäle").
    - 46 neue Unit-Tests: 25 für Email-Deobfuscation +
      Noise-Filter-Matrix, 21 für Scraper (5 Wien-Impressum-Fixtures
      für Anwalt/Ingenieur/Gastro/Einzelhandel/Handwerker, E.164-
      Matrix, PLZ-Quality-Gate, Cache-Hit, Robots-Disallow,
      Page-Cap, UA-Check, Coverage-Flag).
    - Neue env vars: `IMPRESSUM_SCRAPER_ENABLED` (Default true),
      `IMPRESSUM_CACHE_DIR` (./runs/impressum-cache),
      `IMPRESSUM_CACHE_TTL_DAYS` (7).
    - Neue Dependency: `libphonenumber-js` für E.164-Parsing.

## Was NICHT tun

- Keine Google-API-Calls ohne expliziten Check via `googleApiKey()` aus
  `src/lib/env.ts` (resolved `GOOGLE_API_KEY` → legacy Aliase).
  In v0.1 bleibt Google optional; OSM/WKO sind Default.
- Keine `npm audit fix --force` ohne Review — bricht oft mehr als es fixt.
- Keine direkten Imports aus `schema.sqlite.ts` oder `schema.pg.ts` in
  App-Code; immer via `schema.ts` re-export.
- Keine Screenshots/Vision-Calls in v0.1 (Spalten sind vorbereitet, aber
  Feature kommt in v0.2).
- Keine Scraper ohne Rate-Limit + User-Agent. Minimum 1 Req/Sek pro Host,
  exponentieller Backoff bei 429/503.

## DSGVO / Compliance

- Nur öffentlich zugängliche Daten (Impressum, Branchenverzeichnisse).
- Keine Mail-Adressen aus privaten Registern extrahieren.
- Leads mit Löschaufforderung landen in `chain_overrides` als `blacklist`.
- `robots.txt` der Quellen respektieren.
