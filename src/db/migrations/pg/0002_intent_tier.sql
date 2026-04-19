ALTER TABLE "audit_results" ADD COLUMN "intent_tier" text;--> statement-breakpoint
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_intent_tier_check" CHECK ("intent_tier" IS NULL OR "intent_tier" IN ('PARKED','DEAD','LIVE','NONE'));--> statement-breakpoint
CREATE INDEX "idx_audit_intent_tier" ON "audit_results" ("intent_tier");
