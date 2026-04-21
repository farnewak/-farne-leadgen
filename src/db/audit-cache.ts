import { eq } from "drizzle-orm";
import { getDb, isPostgres } from "./client.js";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";
import type {
  FetchError,
  Tier,
  IntentTier,
  DiscoveryMethod,
  TechStackSignals,
  SocialLinks,
} from "../models/audit.js";
import { loadEnv } from "../lib/env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Dialect-independent insert shape. Both SQLite (timestamp_ms mode) and
// Postgres (timestamp mode: "date") accept Date objects for these columns —
// Drizzle serialises them internally. Keep this shape wide on the *input*
// side so callers can omit columns that the DB already defaults.
export interface UpsertAuditInput {
  placeId: string;
  auditedAt: Date;
  tier: Tier;
  discoveredUrl: string | null;
  discoveryMethod: DiscoveryMethod | null;
  sslValid: boolean | null;
  sslExpiresAt: Date | null;
  httpToHttpsRedirect: boolean | null;
  hasViewportMeta: boolean | null;
  viewportMetaContent: string | null;
  psiMobilePerformance: number | null;
  psiMobileSeo: number | null;
  psiMobileAccessibility: number | null;
  psiMobileBestPractices: number | null;
  psiFetchedAt: Date | null;
  impressumUrl: string | null;
  impressumPresent: boolean;
  impressumUid: string | null;
  impressumCompanyName: string | null;
  impressumAddress: string | null;
  impressumPhone: string | null;
  impressumEmail: string | null;
  impressumComplete: boolean | null;
  techStack: TechStackSignals;
  genericEmails: string[];
  socialLinks: SocialLinks;
  fetchError: FetchError | null;
  fetchErrorAt: Date | null;
  intentTier: IntentTier | null;
  staticSignalsExpiresAt: Date;
  psiSignalsExpiresAt: Date | null;
  score: number | null;
  // FIX 6: chain-apex dedupe. Collapsed canonical rows carry
  // chainDetected=true + chainName=<apex> + branchCount=N. Non-chain rows
  // default to (false, null, 1) and must carry branchCount=1.
  chainDetected: boolean;
  chainName: string | null;
  branchCount: number;
  // FIX 11: last_modified year (1995..now+1) or null. Informational.
  lastModifiedSignal: number | null;
  // #22: persisted schema.org/JSON-LD signal. Null on legacy rows only;
  // all post-#22 writes set either `true` or `false`.
  hasStructuredData: boolean | null;
}

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

// INSERT-or-UPDATE on place_id. Column list duplicates the full insert on
// the UPDATE side so re-audits overwrite every signal, not just the mutated
// ones — prevents ghost values sticking around from a prior tier/error state.
// `staticSignalsExpiresAt` is the TTL anchor: setting it afresh on every
// upsert is what makes `checkAuditCache` return the right freshness flag.
export async function upsertAudit(row: UpsertAuditInput): Promise<void> {
  const db = getDb();

  if (isPostgres()) {
    const pgDb = db as ReturnType<
      typeof import("drizzle-orm/postgres-js").drizzle<typeof pgSchema>
    >;
    await pgDb
      .insert(pgSchema.auditResults)
      .values(row)
      .onConflictDoUpdate({
        target: pgSchema.auditResults.placeId,
        set: buildUpdateSet(row),
      });
    return;
  }

  const sqliteDb = db as ReturnType<
    typeof import("drizzle-orm/better-sqlite3").drizzle<typeof sqliteSchema>
  >;
  sqliteDb
    .insert(sqliteSchema.auditResults)
    .values(row)
    .onConflictDoUpdate({
      target: sqliteSchema.auditResults.placeId,
      set: buildUpdateSet(row),
    })
    .run();
}

// Omits id + placeId from the SET clause; everything else is a fair overwrite.
function buildUpdateSet(row: UpsertAuditInput): Partial<UpsertAuditInput> {
  const { placeId: _ignore, ...rest } = row;
  return rest;
}

// Records a failed audit so the same defective domain isn't retried next
// run. Writes a minimal row: tier + fetch_error + TTL anchor set to "now +
// static TTL" → behaves like a negative cache inside the normal cache window.
export async function markAuditError(
  placeId: string,
  fetchError: FetchError,
  tier: Tier | null,
): Promise<void> {
  const env = loadEnv();
  const now = new Date();
  const expires = new Date(now.getTime() + env.AUDIT_STATIC_TTL_DAYS * DAY_MS);

  const emptyTech: TechStackSignals = {
    cms: [],
    pageBuilder: [],
    analytics: [],
    tracking: [],
    payment: [],
    cdn: [],
  };
  const emptySocial: SocialLinks = {};

  await upsertAudit({
    placeId,
    auditedAt: now,
    // `C` is the right neutral value for "we tried and it failed" when the
    // orchestrator has no better tier info. Callers that DO know the tier
    // pass it through — useful when the error happens mid-signals, not at
    // discovery time.
    tier: tier ?? "C",
    discoveredUrl: null,
    discoveryMethod: null,
    sslValid: null,
    sslExpiresAt: null,
    httpToHttpsRedirect: null,
    hasViewportMeta: null,
    viewportMetaContent: null,
    psiMobilePerformance: null,
    psiMobileSeo: null,
    psiMobileAccessibility: null,
    psiMobileBestPractices: null,
    psiFetchedAt: null,
    impressumUrl: null,
    impressumPresent: false,
    impressumUid: null,
    impressumCompanyName: null,
    impressumAddress: null,
    impressumPhone: null,
    impressumEmail: null,
    impressumComplete: null,
    techStack: emptyTech,
    genericEmails: [],
    socialLinks: emptySocial,
    fetchError,
    fetchErrorAt: now,
    intentTier: null,
    staticSignalsExpiresAt: expires,
    psiSignalsExpiresAt: null,
    score: null,
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    lastModifiedSignal: null,
    hasStructuredData: null,
  });
}
