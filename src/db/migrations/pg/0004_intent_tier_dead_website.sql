-- FIX 4: extend intent_tier enum with DEAD_WEBSITE (tier-B3 "no discovered
-- URL" bucket). Drop + recreate the CHECK constraint since PG has no
-- ALTER CONSTRAINT. SQLite mirror has no CHECK (Drizzle's SQLite driver
-- does not emit the enum as a constraint), so no matching SQLite migration.
ALTER TABLE "audit_results" DROP CONSTRAINT IF EXISTS "audit_results_intent_tier_check";--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_intent_tier_check" CHECK ("intent_tier" IS NULL OR "intent_tier" IN ('PARKED','DEAD','DEAD_WEBSITE','LIVE','NONE'));
