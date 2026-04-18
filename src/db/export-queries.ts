import { and, gte, lte, inArray, type SQL } from "drizzle-orm";
import { getDb, isPostgres } from "./client.js";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import type { AuditResult } from "./schema.js";
import type { Tier } from "../models/audit.js";

export interface ExportQueryFilters {
  tiers: Tier[] | null;
  minScore: number;
  maxScore: number;
}

// Queries audit_results for the CSV/JSON exporter. Tier + score filters are
// pushed to SQL via Drizzle (parameterised — no string concatenation).
// PLZ + limit filters happen post-parse because:
//   - PLZ is parsed from impressum_address at row-shape time, not stored.
//   - Limit must apply AFTER the score-DESC sort, which is done in JS.
export async function queryAuditResultsForExport(
  f: ExportQueryFilters,
): Promise<AuditResult[]> {
  const db = getDb();

  if (isPostgres()) {
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    const conditions: SQL[] = [
      gte(pgSchema.auditResults.score, f.minScore),
      lte(pgSchema.auditResults.score, f.maxScore),
    ];
    if (f.tiers && f.tiers.length > 0) {
      conditions.push(inArray(pgSchema.auditResults.tier, f.tiers));
    }
    const rows = await pgDb
      .select()
      .from(pgSchema.auditResults)
      .where(and(...conditions));
    // PG row type and SQLite row type have identical structural shape by
    // design (schema.pg.ts mirrors schema.sqlite.ts). The cast is safe.
    return rows as unknown as AuditResult[];
  }

  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  const conditions: SQL[] = [
    gte(sqliteSchema.auditResults.score, f.minScore),
    lte(sqliteSchema.auditResults.score, f.maxScore),
  ];
  if (f.tiers && f.tiers.length > 0) {
    conditions.push(inArray(sqliteSchema.auditResults.tier, f.tiers));
  }
  return sqliteDb
    .select()
    .from(sqliteSchema.auditResults)
    .where(and(...conditions))
    .all();
}
