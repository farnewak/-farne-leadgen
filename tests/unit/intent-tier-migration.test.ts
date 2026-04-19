import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/intent-tier-migration.db");

// Schema-drift guard: if a new migration lands without being added here,
// this test must be updated. Keep the list sorted by filename — matches
// drizzle's migrator ordering.
const MIGRATIONS = [
  "0000_init.sql",
  "0001_audit_results.sql",
  "0002_intent_tier.sql",
];

function applyMigrations(db: Database.Database): void {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(
      resolve(HERE, "../../src/db/migrations/sqlite", file),
      "utf8",
    );
    for (const part of sql.split("--> statement-breakpoint")) {
      const trimmed = part.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

describe("0002_intent_tier migration", () => {
  beforeEach(() => {
    try {
      rmSync(TMP_DB, { force: true });
      rmSync(`${TMP_DB}-wal`, { force: true });
      rmSync(`${TMP_DB}-shm`, { force: true });
    } catch {
      // file may not exist yet
    }
    mkdirSync(dirname(TMP_DB), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TMP_DB, { force: true });
      rmSync(`${TMP_DB}-wal`, { force: true });
      rmSync(`${TMP_DB}-shm`, { force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("adds intent_tier column to audit_results", () => {
    const db = new Database(TMP_DB);
    applyMigrations(db);
    const cols = db
      .prepare("PRAGMA table_info(audit_results)")
      .all() as Array<{ name: string; type: string }>;
    db.close();

    const names = cols.map((c) => c.name);
    expect(names).toContain("intent_tier");
    const col = cols.find((c) => c.name === "intent_tier");
    expect(col?.type.toLowerCase()).toContain("text");
  });

  it("creates idx_audit_intent_tier index", () => {
    const db = new Database(TMP_DB);
    applyMigrations(db);
    const idx = db
      .prepare("PRAGMA index_list(audit_results)")
      .all() as Array<{ name: string }>;
    db.close();

    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_audit_intent_tier");
  });

  it("allows insert of all 4 intent_tier enum values plus NULL", () => {
    const db = new Database(TMP_DB);
    applyMigrations(db);

    // Seed the minimum columns needed. static_signals_expires_at is NOT NULL
    // and all defaults (impressum_present, tech_stack, generic_emails,
    // social_links) are filled in by the schema.
    const stmt = db.prepare(
      `INSERT INTO audit_results
         (place_id, audited_at, tier, static_signals_expires_at, intent_tier)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    const expires = now + 30 * 24 * 60 * 60 * 1000;
    for (const v of ["PARKED", "DEAD", "LIVE", "NONE", null]) {
      stmt.run(`p-${v ?? "null"}`, now, "C", expires, v);
    }
    const rows = db
      .prepare("SELECT place_id, intent_tier FROM audit_results ORDER BY place_id")
      .all();
    db.close();

    expect(rows).toHaveLength(5);
  });
});
