import { eq } from "drizzle-orm";
import { getDb, isPostgres } from "./client.js";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";

export interface AuditCacheEntry {
  placeId: string;
  // `staticFresh` = static signals (SSL/viewport/tech-stack/impressum/socials)
  // still inside their TTL window. Callers skip re-fetch when true.
  staticFresh: boolean;
  // `psiFresh` = PageSpeed-Insights payload still inside its shorter TTL.
  // Independent of staticFresh because PSI is rate-limited separately.
  psiFresh: boolean;
  // Raw row for downstream merging; typed as `unknown` so callers parse
  // via models/audit.ts schemas rather than leaking Drizzle row types.
  existing: unknown | null;
}

// Read-only lookup for the audit pipeline's skip-logic. Write-path (upsert)
// lands in a later prompt (B4) so this module stays scoped to cache-check.
export async function checkAuditCache(
  placeId: string,
): Promise<AuditCacheEntry> {
  const db = getDb();
  const now = Date.now();

  if (isPostgres()) {
    // Column names are identical across dialects; the cast is safe because
    // we go through the pg-specific schema's table reference immediately.
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    const rows = await pgDb
      .select()
      .from(pgSchema.auditResults)
      .where(eq(pgSchema.auditResults.placeId, placeId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { placeId, staticFresh: false, psiFresh: false, existing: null };
    }
    return {
      placeId,
      staticFresh: row.staticSignalsExpiresAt.getTime() > now,
      psiFresh:
        row.psiSignalsExpiresAt !== null &&
        row.psiSignalsExpiresAt.getTime() > now,
      existing: row,
    };
  }

  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  const rows = sqliteDb
    .select()
    .from(sqliteSchema.auditResults)
    .where(eq(sqliteSchema.auditResults.placeId, placeId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    return { placeId, staticFresh: false, psiFresh: false, existing: null };
  }
  return {
    placeId,
    staticFresh: row.staticSignalsExpiresAt.getTime() > now,
    psiFresh:
      row.psiSignalsExpiresAt !== null &&
      row.psiSignalsExpiresAt.getTime() > now,
    existing: row,
  };
}
