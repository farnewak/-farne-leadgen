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
