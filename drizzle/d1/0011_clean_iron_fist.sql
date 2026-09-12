CREATE TABLE `p_momentum` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`as_of` text NOT NULL,
	`source_max_date` text NOT NULL,
	`bars` integer NOT NULL,
	`closes` text NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL
);
