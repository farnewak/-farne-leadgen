import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  serial,
  index,
} from "drizzle-orm/pg-core";
import type { TechStackSignals, SocialLinks } from "../models/audit.js";

// Mirrors schema.sqlite.ts 1:1. Kept in sync manually until v0.2 consolidation.
// Intentionally uses text for JSON columns (app-side (de)serialize) to keep
// queries dialect-agnostic. Timestamps as bigint millis, matching SQLite storage.
//
// IMPORTANT for v0.2 port: snapshots.raw_audit is TEXT in SQLite today and
// MUST be migrated to JSONB on Postgres for indexability + compression.
// Snapshot-writer enforces a 500kB per-row truncation budget (see persist.ts).
// The jsonb import below stays as a reminder; swap type when porting.

export const leads = pgTable(
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
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastCheckedAt: bigint("last_checked_at", { mode: "number" }).notNull(),
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

export const snapshots = pgTable(
  "snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    takenAt: bigint("taken_at", { mode: "number" }).notNull(),
    lighthouseMobile: integer("lighthouse_mobile"),
    lighthouseDesktop: integer("lighthouse_desktop"),
    visionVerdict: text("vision_verdict"),
    hasReservation: integer("has_reservation"),
    hasShop: integer("has_shop"),
    techStack: text("tech_stack").notNull().default("[]"),
    sslValid: integer("ssl_valid"),
    socialLastPostAt: bigint("social_last_post_at", { mode: "number" }),
    screenshotDesktop: text("screenshot_desktop"),
    screenshotMobile: text("screenshot_mobile"),
    rawAudit: text("raw_audit"),
  },
  (t) => ({
    leadIdIdx: index("idx_snapshots_lead_id").on(t.leadId),
    takenAtIdx: index("idx_snapshots_taken_at").on(t.takenAt),
  }),
);

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  finishedAt: bigint("finished_at", { mode: "number" }),
  command: text("command").notNull(),
  params: text("params").notNull().default("{}"),
  stats: text("stats").notNull().default("{}"),
  status: text("status").notNull().default("running"),
  errorMessage: text("error_message"),
});

export const chainOverrides = pgTable("chain_overrides", {
  normName: text("norm_name").primaryKey(),
  verdict: text("verdict").notNull(),
  note: text("note"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Postgres mirror of src/db/schema.sqlite.ts:auditResults.
// Diffs vs. SQLite: SERIAL id, TIMESTAMPTZ for timestamps, native BOOLEAN
// and JSONB. FK to leads(id) stays app-enforced; the audit row can exist
// ahead of lead discovery in edge cases (manual re-audit of a purged lead).
export const auditResults = pgTable(
  "audit_results",
  {
    id: serial("id").primaryKey(),
    placeId: text("place_id").notNull().unique(),
    auditedAt: timestamp("audited_at", { withTimezone: true, mode: "date" })
      .notNull(),
    tier: text("tier", { enum: ["A", "B1", "B2", "B3", "C"] }).notNull(),
    discoveredUrl: text("discovered_url"),
    discoveryMethod: text("discovery_method", {
      enum: ["osm-tag", "gplaces-tag", "dns-probe", "cse", "manual"],
    }),
    sslValid: boolean("ssl_valid"),
    sslExpiresAt: timestamp("ssl_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    httpToHttpsRedirect: boolean("http_to_https_redirect"),
    hasViewportMeta: boolean("has_viewport_meta"),
    viewportMetaContent: text("viewport_meta_content"),
    psiMobilePerformance: integer("psi_mobile_performance"),
    psiMobileSeo: integer("psi_mobile_seo"),
    psiMobileAccessibility: integer("psi_mobile_accessibility"),
    psiMobileBestPractices: integer("psi_mobile_best_practices"),
    psiFetchedAt: timestamp("psi_fetched_at", {
      withTimezone: true,
      mode: "date",
    }),
    impressumUrl: text("impressum_url"),
    impressumPresent: boolean("impressum_present").notNull().default(false),
    impressumUid: text("impressum_uid"),
    impressumCompanyName: text("impressum_company_name"),
    impressumAddress: text("impressum_address"),
    impressumPhone: text("impressum_phone"),
    impressumEmail: text("impressum_email"),
    impressumComplete: boolean("impressum_complete"),
    techStack: jsonb("tech_stack")
      .$type<TechStackSignals>()
      .notNull()
      .default({
        cms: [],
        pageBuilder: [],
        analytics: [],
        tracking: [],
        payment: [],
        cdn: [],
      }),
    genericEmails: jsonb("generic_emails")
      .$type<string[]>()
      .notNull()
      .default([]),
    socialLinks: jsonb("social_links")
      .$type<SocialLinks>()
      .notNull()
      .default({}),
    fetchError: text("fetch_error"),
    fetchErrorAt: timestamp("fetch_error_at", {
      withTimezone: true,
      mode: "date",
    }),
    staticSignalsExpiresAt: timestamp("static_signals_expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    psiSignalsExpiresAt: timestamp("psi_signals_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    score: integer("score"),
  },
  (t) => ({
    tierIdx: index("idx_audit_tier").on(t.tier),
    scoreIdx: index("idx_audit_score").on(t.score),
    staticExpiresIdx: index("idx_audit_static_expires").on(
      t.staticSignalsExpiresAt,
    ),
  }),
);
