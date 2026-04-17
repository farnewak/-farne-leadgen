// Dialect-neutral re-export. v0.1 is SQLite-only; the Postgres mirror in
// schema.pg.ts stays in sync manually until v0.2 deploy work consolidates it.
// Application code imports types/tables from here — never from the *.sqlite.ts
// or *.pg.ts file directly — so the eventual switch is a single-file change.
export * from "./schema.sqlite.js";
