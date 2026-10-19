CREATE TABLE `yahoo_proxy_cooldown` (
	`id` integer PRIMARY KEY NOT NULL,
	`retry_at_ms` integer NOT NULL,
	`upstream_status` integer,
	CONSTRAINT "yahoo_proxy_cooldown_singleton" CHECK("yahoo_proxy_cooldown"."id" = 1),
	CONSTRAINT "yahoo_proxy_cooldown_deadline" CHECK(typeof("yahoo_proxy_cooldown"."retry_at_ms") = 'integer' AND "yahoo_proxy_cooldown"."retry_at_ms" >= 0 AND "yahoo_proxy_cooldown"."retry_at_ms" <= 9007199254740991),
	CONSTRAINT "yahoo_proxy_cooldown_status" CHECK(("yahoo_proxy_cooldown"."retry_at_ms" = 0 AND "yahoo_proxy_cooldown"."upstream_status" IS NULL) OR ("yahoo_proxy_cooldown"."retry_at_ms" > 0 AND "yahoo_proxy_cooldown"."upstream_status" IS NOT NULL AND "yahoo_proxy_cooldown"."upstream_status" IN (429, 503)))
);
--> statement-breakpoint
-- 未観測の初期状態。上流HTTPの架空値を保存しない。runtimeでは欠損行を再作成しない。
INSERT INTO `yahoo_proxy_cooldown` (`id`, `retry_at_ms`, `upstream_status`) VALUES (1, 0, NULL);
