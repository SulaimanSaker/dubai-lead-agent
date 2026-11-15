CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text,
	`areas` text,
	`beds` integer,
	`budget_aed` integer,
	`timeline` text,
	`financing` text,
	`status` text DEFAULT 'new' NOT NULL,
	`handoff_reason` text,
	`handoff_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`area` text NOT NULL,
	`property_type` text NOT NULL,
	`beds` integer NOT NULL,
	`baths` integer NOT NULL,
	`size_sqft` integer NOT NULL,
	`purpose` text NOT NULL,
	`price_aed` integer NOT NULL,
	`status` text NOT NULL,
	`handover_date` text,
	`furnished` integer NOT NULL,
	`features` text NOT NULL,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `listings_search_idx` ON `listings` (`purpose`,`area`,`beds`,`price_aed`);--> statement-breakpoint
CREATE TABLE `viewings` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`starts_at` text NOT NULL,
	`status` text DEFAULT 'booked' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viewings_one_booking_per_slot` ON `viewings` (`starts_at`) WHERE "viewings"."status" = 'booked';