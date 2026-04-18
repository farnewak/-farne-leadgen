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
   Offen: wko.ts (Phase 2), herold verworfen (AGB/§76c), firmenbuch →
   separater Enrichment-Step, kein DataSource.
2. `src/pipeline/audit.ts` — Website-Audit (SSL, Mobile-Viewport, PSI API,
   Tech-Stack, Impressum, Ladezeit)
3. `src/pipeline/score.ts` — Gewichtungsmodell → score
4. `src/pipeline/persist.ts` — writeSnapshot mit 500kB-Budget
5. `src/cli.ts` — CLI-Entry (`leadgen discover --plz 1070 --max 100`)
6. `src/cli/export-csv.ts` — Export sortiert nach score
7. `src/pipeline/chainfilter.ts` — dynamische Ketten-Heuristik
8. OSM unmapped-tags Review — `runs/overpass-cache/unmapped-tags.log`
   nach jedem Run sichten, häufige Tag-Kombis ins
   `OSM_TAG_TO_GPLACES_KEY` nachziehen.

## Was NICHT tun

- Keine Google-API-Calls ohne expliziten Check auf `GOOGLE_MAPS_API_KEY`.
  In v0.1 bleibt Google optional; Herold/WKO sind Default.
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
