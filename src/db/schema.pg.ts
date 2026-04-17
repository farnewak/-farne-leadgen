import { pgTable, text, integer, bigint, jsonb, index } from "drizzle-orm/pg-core";

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
