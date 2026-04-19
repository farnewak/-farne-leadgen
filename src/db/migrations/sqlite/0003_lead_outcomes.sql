CREATE TABLE `lead_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`status` text NOT NULL,
	`channel` text,
	`notes` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `lead_outcomes_status_check` CHECK(`status` IN ('INTERESSIERT','GESCHLOSSEN','NICHT_RELEVANT','NO_ANSWER','FOLLOWUP')),
	CONSTRAINT `lead_outcomes_channel_check` CHECK(`channel` IS NULL OR `channel` IN ('MAIL','CALL','BESUCH'))
);
--> statement-breakpoint
CREATE INDEX `idx_lead_outcomes_lead_id` ON `lead_outcomes` (`lead_id`);--> statement-breakpoint
CREATE INDEX `idx_lead_outcomes_status` ON `lead_outcomes` (`status`);
