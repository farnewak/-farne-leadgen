CREATE TABLE `chain_overrides` (
	`norm_name` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`norm_name` text NOT NULL,
	`address` text,
	`plz` text,
	`district` text,
	`industry` text NOT NULL,
	`places_types` text DEFAULT '[]' NOT NULL,
	`places_primary_type` text,
	`chain_flag` text,
	`status` text DEFAULT 'new' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`opportunity` text DEFAULT '[]' NOT NULL,
	`website` text,
	`phone` text,
	`email` text,
	`instagram` text,
	`facebook` text,
	`contact_source` text,
	`notes` text DEFAULT '' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_checked_at` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_leads_norm_name_plz` ON `leads` (`norm_name`,`plz`);--> statement-breakpoint
CREATE INDEX `idx_leads_score` ON `leads` (`score`);--> statement-breakpoint
CREATE INDEX `idx_leads_status` ON `leads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_leads_industry` ON `leads` (`industry`);--> statement-breakpoint
CREATE INDEX `idx_leads_chain_flag` ON `leads` (`chain_flag`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`command` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`stats` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`lighthouse_mobile` integer,
	`lighthouse_desktop` integer,
	`vision_verdict` text,
	`has_reservation` integer,
	`has_shop` integer,
	`tech_stack` text DEFAULT '[]' NOT NULL,
	`ssl_valid` integer,
	`social_last_post_at` integer,
	`screenshot_desktop` text,
	`screenshot_mobile` text,
	`raw_audit` text,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_lead_id` ON `snapshots` (`lead_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_taken_at` ON `snapshots` (`taken_at`);