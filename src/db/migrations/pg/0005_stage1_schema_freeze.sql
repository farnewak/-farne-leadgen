-- FIX 13: consolidate every Phase-2B/3/4 column the SQLite schema already
-- carries so the PG mirror matches. All ADDs are guarded with IF NOT EXISTS
-- so re-running against a partially-migrated PG database is safe. This
-- migration is the paired step for the stage1-results 25-column freeze in
-- `schemas/stage1_results.schema.ts`; any schema addition after this point
-- must bump a new migration number in BOTH pg/ and sqlite/.

-- Chain-apex dedupe metadata (Phase 2B).
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "chain_detected" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "chain_name" text;--> statement-breakpoint
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "branch_count" integer NOT NULL DEFAULT 1;--> statement-breakpoint

-- Sub-tier (Phase 3 scoring granularity within Tier A).
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "sub_tier" text;--> statement-breakpoint
ALTER TABLE "audit_results" DROP CONSTRAINT IF EXISTS "audit_results_sub_tier_check";--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_sub_tier_check" CHECK ("sub_tier" IS NULL OR "sub_tier" IN ('A1','A2','A3'));--> statement-breakpoint

-- Freshness signal (Phase 4 FIX 11). Footer copyright year or
-- last-modified header folded into a single integer bucket. Plausibility
-- window: 1995..next-year.
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "last_modified_signal" integer;--> statement-breakpoint
ALTER TABLE "audit_results" DROP CONSTRAINT IF EXISTS "audit_results_last_modified_signal_check";--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_last_modified_signal_check" CHECK ("last_modified_signal" IS NULL OR ("last_modified_signal" BETWEEN 1995 AND (EXTRACT(YEAR FROM now())::int + 1)));--> statement-breakpoint

-- schema.org / JSON-LD presence (Phase 4 FIX, replaces export-time inference).
ALTER TABLE "audit_results" ADD COLUMN IF NOT EXISTS "has_structured_data" boolean;--> statement-breakpoint

-- intent_tier already exists (migration 0002) but 0004 replaced its CHECK
-- to include DEAD_WEBSITE. A fresh PG database running migrations 0001..0005
-- in order will carry the 0004 constraint. No action needed here.
