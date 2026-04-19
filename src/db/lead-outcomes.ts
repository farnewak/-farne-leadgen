import { desc, eq } from "drizzle-orm";
import { getDb, isPostgres } from "./client.js";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import type { AuditResult, LeadOutcome } from "./schema.js";

// Canonical enum lists. Kept inline (not re-imported from schema.ts) because
// the CLI needs runtime values for validation — Drizzle's enum hint is a
// compile-time construct only.
export const LABEL_STATUSES = [
  "INTERESSIERT",
  "GESCHLOSSEN",
  "NICHT_RELEVANT",
  "NO_ANSWER",
  "FOLLOWUP",
] as const;
export type LabelStatus = (typeof LABEL_STATUSES)[number];

export const LABEL_CHANNELS = ["MAIL", "CALL", "BESUCH"] as const;
export type LabelChannel = (typeof LABEL_CHANNELS)[number];

export interface NewOutcomeInput {
  leadId: string;
  status: LabelStatus;
  channel: LabelChannel | null;
  notes: string | null;
  createdAt?: number;
}

// Append-only insert (spec §C I2). Callers who want to observe the history
// MUST query with ORDER BY created_at DESC.
export async function insertOutcome(input: NewOutcomeInput): Promise<number> {
  const db = getDb();
  const createdAt = input.createdAt ?? Date.now();

  if (isPostgres()) {
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    const rows = await pgDb
      .insert(pgSchema.leadOutcomes)
      .values({
        leadId: input.leadId,
        status: input.status,
        channel: input.channel,
        notes: input.notes,
        createdAt,
      })
      .returning({ id: pgSchema.leadOutcomes.id });
    return rows[0]!.id;
  }

  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  const rows = sqliteDb
    .insert(sqliteSchema.leadOutcomes)
    .values({
      leadId: input.leadId,
      status: input.status,
      channel: input.channel,
      notes: input.notes,
      createdAt,
    })
    .returning({ id: sqliteSchema.leadOutcomes.id })
    .all();
  return rows[0]!.id;
}

export async function listOutcomes(): Promise<LeadOutcome[]> {
  const db = getDb();
  if (isPostgres()) {
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    const rows = await pgDb
      .select()
      .from(pgSchema.leadOutcomes)
      .orderBy(desc(pgSchema.leadOutcomes.createdAt));
    return rows as unknown as LeadOutcome[];
  }
  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  return sqliteDb
    .select()
    .from(sqliteSchema.leadOutcomes)
    .orderBy(desc(sqliteSchema.leadOutcomes.createdAt))
    .all();
}

export async function findAuditByPlaceId(
  placeId: string,
): Promise<AuditResult | null> {
  const db = getDb();
  if (isPostgres()) {
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    const rows = await pgDb
      .select()
      .from(pgSchema.auditResults)
      .where(eq(pgSchema.auditResults.placeId, placeId));
    return (rows[0] as unknown as AuditResult) ?? null;
  }
  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  const rows = sqliteDb
    .select()
    .from(sqliteSchema.auditResults)
    .where(eq(sqliteSchema.auditResults.placeId, placeId))
    .all();
  return rows[0] ?? null;
}

export function isValidStatus(v: string): v is LabelStatus {
  return (LABEL_STATUSES as readonly string[]).includes(v);
}

export function isValidChannel(v: string): v is LabelChannel {
  return (LABEL_CHANNELS as readonly string[]).includes(v);
}
