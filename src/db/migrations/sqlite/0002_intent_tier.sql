ALTER TABLE `audit_results` ADD COLUMN `intent_tier` text;--> statement-breakpoint
CREATE INDEX `idx_audit_intent_tier` ON `audit_results` (`intent_tier`);
