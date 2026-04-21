-- FIX 6: chain-apex dedupe columns. A collapsed chain row carries
-- chain_detected=1, chain_name=<apex>, branch_count=<N>. Non-chain rows
-- default to (0, NULL, 1). PG migration is deferred to Phase 5 schema
-- freeze (alongside sub_tier / last_modified_signal).
ALTER TABLE `audit_results` ADD COLUMN `chain_detected` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `audit_results` ADD COLUMN `chain_name` text;--> statement-breakpoint
ALTER TABLE `audit_results` ADD COLUMN `branch_count` integer NOT NULL DEFAULT 1;
