CREATE TABLE `audit_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`place_id` text NOT NULL,
	`audited_at` integer NOT NULL,
	`tier` text NOT NULL,
	`discovered_url` text,
	`discovery_method` text,
	`ssl_valid` integer,
	`ssl_expires_at` integer,
	`http_to_https_redirect` integer,
	`has_viewport_meta` integer,
	`viewport_meta_content` text,
	`psi_mobile_performance` integer,
	`psi_mobile_seo` integer,
	`psi_mobile_accessibility` integer,
	`psi_mobile_best_practices` integer,
	`psi_fetched_at` integer,
	`impressum_url` text,
	`impressum_present` integer DEFAULT false NOT NULL,
	`impressum_uid` text,
	`impressum_company_name` text,
	`impressum_address` text,
	`impressum_phone` text,
	`impressum_email` text,
	`impressum_complete` integer,
	`tech_stack` text DEFAULT '{}' NOT NULL,
	`generic_emails` text DEFAULT '[]' NOT NULL,
	`social_links` text DEFAULT '{}' NOT NULL,
	`fetch_error` text,
	`fetch_error_at` integer,
	`static_signals_expires_at` integer NOT NULL,
	`psi_signals_expires_at` integer,
	`score` integer,
	CONSTRAINT `audit_results_tier_check` CHECK(`tier` IN ('A','B1','B2','B3','C')),
	CONSTRAINT `audit_results_discovery_method_check` CHECK(`discovery_method` IS NULL OR `discovery_method` IN ('osm-tag','gplaces-tag','dns-probe','cse','manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_results_place_id_unique` ON `audit_results` (`place_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_tier` ON `audit_results` (`tier`);--> statement-breakpoint
CREATE INDEX `idx_audit_score` ON `audit_results` (`score` DESC);--> statement-breakpoint
CREATE INDEX `idx_audit_static_expires` ON `audit_results` (`static_signals_expires_at`);
