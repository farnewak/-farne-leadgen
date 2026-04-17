import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type ChainOverride = typeof chainOverrides.$inferSelect;
