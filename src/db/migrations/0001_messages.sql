CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`meta` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `messages` (`lead_id`,`id`);