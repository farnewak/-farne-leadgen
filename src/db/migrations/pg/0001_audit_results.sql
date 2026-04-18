CREATE TABLE "audit_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"audited_at" timestamp with time zone NOT NULL,
	"tier" text NOT NULL,
	"discovered_url" text,
	"discovery_method" text,
	"ssl_valid" boolean,
	"ssl_expires_at" timestamp with time zone,
	"http_to_https_redirect" boolean,
	"has_viewport_meta" boolean,
	"viewport_meta_content" text,
	"psi_mobile_performance" integer,
	"psi_mobile_seo" integer,
	"psi_mobile_accessibility" integer,
	"psi_mobile_best_practices" integer,
	"psi_fetched_at" timestamp with time zone,
	"impressum_url" text,
	"impressum_present" boolean DEFAULT false NOT NULL,
	"impressum_uid" text,
	"impressum_company_name" text,
	"impressum_address" text,
	"impressum_phone" text,
	"impressum_email" text,
	"impressum_complete" boolean,
	"tech_stack" jsonb DEFAULT '{"cms":[],"pageBuilder":[],"analytics":[],"tracking":[],"payment":[],"cdn":[]}'::jsonb NOT NULL,
	"generic_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"social_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetch_error" text,
	"fetch_error_at" timestamp with time zone,
	"static_signals_expires_at" timestamp with time zone NOT NULL,
	"psi_signals_expires_at" timestamp with time zone,
	"score" integer,
	CONSTRAINT "audit_results_place_id_unique" UNIQUE("place_id"),
	CONSTRAINT "audit_results_tier_check" CHECK ("tier" IN ('A','B1','B2','B3','C')),
	CONSTRAINT "audit_results_discovery_method_check" CHECK ("discovery_method" IS NULL OR "discovery_method" IN ('osm-tag','gplaces-tag','dns-probe','cse','manual'))
	-- NOTE: FK audit_results.place_id → leads(id) intentionally omitted.
	-- Reason: pg deploy is v0.2 territory; leads-table init-migration does
	-- not yet exist in this folder. Add the FK in a follow-up pg migration
	-- once drizzle-kit generate emits a consistent baseline.
);
--> statement-breakpoint
CREATE INDEX "idx_audit_tier" ON "audit_results" ("tier");--> statement-breakpoint
CREATE INDEX "idx_audit_score" ON "audit_results" ("score" DESC);--> statement-breakpoint
CREATE INDEX "idx_audit_static_expires" ON "audit_results" ("static_signals_expires_at");
