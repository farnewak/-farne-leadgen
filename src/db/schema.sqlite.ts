import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { TechStackSignals, SocialLinks } from "../models/audit.js";

// `leads.id` is a generic opaque string, NOT named google_place_id by design.
// Convention: Google-sourced leads use the raw place_id; other sources use a
// prefixed synthetic ID like `herold:<sha256>` or `wko:<sha256>`. This keeps
// the primary key stable across source additions without schema churn.
//
// `raw_audit` (snapshots) is TEXT here and will become JSONB on the Postgres
// port. App-side writer MUST enforce a 500kB truncation budget — see
// src/pipeline/persist.ts (writeSnapshot).
export const leads = sqliteTable(
  "leads",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normName: text("norm_name").notNull(),
    address: text("address"),
    plz: text("plz"),
    district: text("district"),
    industry: text("industry").notNull(),
    placesTypes: text("places_types").notNull().default("[]"),
    placesPrimaryType: text("places_primary_type"),
    chainFlag: text("chain_flag"),
    status: text("status").notNull().default("new"),
    score: integer("score").notNull().default(0),
    opportunity: text("opportunity").notNull().default("[]"),
    website: text("website"),
    phone: text("phone"),
    email: text("email"),
    instagram: text("instagram"),
    facebook: text("facebook"),
    contactSource: text("contact_source"),
    notes: text("notes").notNull().default(""),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastCheckedAt: integer("last_checked_at").notNull(),
    source: text("source").notNull(),
  },
  (t) => ({
    normNamePlzIdx: index("idx_leads_norm_name_plz").on(t.normName, t.plz),
    scoreIdx: index("idx_leads_score").on(t.score),
    statusIdx: index("idx_leads_status").on(t.status),
    industryIdx: index("idx_leads_industry").on(t.industry),
    chainFlagIdx: index("idx_leads_chain_flag").on(t.chainFlag),
  }),
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    takenAt: integer("taken_at").notNull(),
    lighthouseMobile: integer("lighthouse_mobile"),
    lighthouseDesktop: integer("lighthouse_desktop"),
    visionVerdict: text("vision_verdict"),
    hasReservation: integer("has_reservation"),
    hasShop: integer("has_shop"),
    techStack: text("tech_stack").notNull().default("[]"),
    sslValid: integer("ssl_valid"),
    socialLastPostAt: integer("social_last_post_at"),
    screenshotDesktop: text("screenshot_desktop"),
    screenshotMobile: text("screenshot_mobile"),
    rawAudit: text("raw_audit"),
  },
  (t) => ({
    leadIdIdx: index("idx_snapshots_lead_id").on(t.leadId),
    takenAtIdx: index("idx_snapshots_taken_at").on(t.takenAt),
  }),
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  command: text("command").notNull(),
  params: text("params").notNull().default("{}"),
  stats: text("stats").notNull().default("{}"),
  status: text("status").notNull().default("running"),
  errorMessage: text("error_message"),
});

export const chainOverrides = sqliteTable("chain_overrides", {
  normName: text("norm_name").primaryKey(),
  verdict: text("verdict").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
});

// `audit_results` is the per-website audit snapshot. One row per place_id;
// re-audits UPSERT via the unique index. `tier` / `discovery_method` are
// enforced by Drizzle at type-level and by CHECK constraints at DB-level —
// the migration duplicates the enums because Drizzle's SQLite driver does
// not emit CHECKs from the `enum:` type hint.
//
// JSON columns store typed payloads. The `$type<T>()` hint is narrative only;
// app-side code MUST go through zod parsers (src/models/audit.ts) on read.
export const auditResults = sqliteTable(
  "audit_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    placeId: text("place_id").notNull().unique(),
    auditedAt: integer("audited_at", { mode: "timestamp_ms" }).notNull(),
    tier: text("tier", { enum: ["A", "B1", "B2", "B3", "C"] }).notNull(),
    discoveredUrl: text("discovered_url"),
    discoveryMethod: text("discovery_method", {
      enum: ["osm-tag", "gplaces-tag", "dns-probe", "cse", "manual"],
    }),
    sslValid: integer("ssl_valid", { mode: "boolean" }),
    sslExpiresAt: integer("ssl_expires_at", { mode: "timestamp_ms" }),
    httpToHttpsRedirect: integer("http_to_https_redirect", { mode: "boolean" }),
    hasViewportMeta: integer("has_viewport_meta", { mode: "boolean" }),
    viewportMetaContent: text("viewport_meta_content"),
    psiMobilePerformance: integer("psi_mobile_performance"),
    psiMobileSeo: integer("psi_mobile_seo"),
    psiMobileAccessibility: integer("psi_mobile_accessibility"),
    psiMobileBestPractices: integer("psi_mobile_best_practices"),
    psiFetchedAt: integer("psi_fetched_at", { mode: "timestamp_ms" }),
    impressumUrl: text("impressum_url"),
    impressumPresent: integer("impressum_present", { mode: "boolean" })
      .notNull()
      .default(false),
    impressumUid: text("impressum_uid"),
    impressumCompanyName: text("impressum_company_name"),
    impressumAddress: text("impressum_address"),
    impressumPhone: text("impressum_phone"),
    impressumEmail: text("impressum_email"),
    impressumComplete: integer("impressum_complete", { mode: "boolean" }),
    techStack: text("tech_stack", { mode: "json" })
      .$type<TechStackSignals>()
      .notNull()
      .default(sql`'{}'`),
    genericEmails: text("generic_emails", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    socialLinks: text("social_links", { mode: "json" })
      .$type<SocialLinks>()
      .notNull()
      .default(sql`'{}'`),
    fetchError: text("fetch_error"),
    fetchErrorAt: integer("fetch_error_at", { mode: "timestamp_ms" }),
    // Intent-tier is orthogonal to `tier` — see src/models/audit.ts. NULL
    // on historical rows until the next re-audit populates it.
    intentTier: text("intent_tier", {
      enum: ["PARKED", "DEAD", "DEAD_WEBSITE", "LIVE", "NONE"],
    }),
    staticSignalsExpiresAt: integer("static_signals_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    psiSignalsExpiresAt: integer("psi_signals_expires_at", {
      mode: "timestamp_ms",
    }),
    score: integer("score"),
    // FIX 6: chain-apex dedupe columns. `chain_detected=true` marks a
    // collapsed canonical row; `chain_name` carries the apex eTLD+1 and
    // `branch_count` the number of original branch rows that merged in.
    // Non-chain rows default to (false, NULL, 1). PG migration deferred
    // to Phase 5 schema freeze.
    chainDetected: integer("chain_detected", { mode: "boolean" })
      .notNull()
      .default(false),
    chainName: text("chain_name"),
    branchCount: integer("branch_count").notNull().default(1),
  },
  (t) => ({
    tierIdx: index("idx_audit_tier").on(t.tier),
    scoreIdx: index("idx_audit_score").on(t.score),
    staticExpiresIdx: index("idx_audit_static_expires").on(
      t.staticSignalsExpiresAt,
    ),
  }),
);

// Append-only outcome log. One row per touchpoint — the CLI never updates
// an existing row, the history of status changes is the data (spec §C I2).
// `lead_id` references `audit_results.place_id` semantically but is kept as
// a plain text column: we want labels to survive audit re-runs and soft
// deletes, and a hard FK would force either cascade (loses history) or
// restrict (blocks cleanup).
export const leadOutcomes = sqliteTable(
  "lead_outcomes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: text("lead_id").notNull(),
    status: text("status", {
      enum: [
        "INTERESSIERT",
        "GESCHLOSSEN",
        "NICHT_RELEVANT",
        "NO_ANSWER",
        "FOLLOWUP",
      ],
    }).notNull(),
    channel: text("channel", { enum: ["MAIL", "CALL", "BESUCH"] }),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    leadIdIdx: index("idx_lead_outcomes_lead_id").on(t.leadId),
    statusIdx: index("idx_lead_outcomes_status").on(t.status),
  }),
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type ChainOverride = typeof chainOverrides.$inferSelect;
export type AuditResult = typeof auditResults.$inferSelect;
export type NewAuditResult = typeof auditResults.$inferInsert;
export type LeadOutcome = typeof leadOutcomes.$inferSelect;
export type NewLeadOutcome = typeof leadOutcomes.$inferInsert;
