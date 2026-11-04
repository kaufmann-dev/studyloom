CREATE TABLE "moodle_calendar" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"url" text,
	"time_zone" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moodle_calendar_single_check" CHECK ("moodle_calendar"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_codes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "oauth_clients" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_codes" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_grants" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_tokens" CASCADE;--> statement-breakpoint
DROP INDEX "source_chunk_search_idx";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "source" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_check" CHECK ("events"."source" in ('custom', 'moodle'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_check" CHECK ("tasks"."source" in ('custom', 'moodle'));