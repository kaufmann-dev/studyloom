CREATE TABLE "calendar_feed" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"token" text,
	"time_zone" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feed_single_check" CHECK ("calendar_feed"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "event_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"title" text,
	"location" text,
	"notes" text,
	"start_date" date,
	"start_time" text,
	"end_date" date,
	"end_time" text,
	CONSTRAINT "event_exceptions_override_check" CHECK ("event_exceptions"."cancelled" or ("event_exceptions"."title" is not null and "event_exceptions"."start_date" is not null and "event_exceptions"."end_date" is not null))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"start_date" date NOT NULL,
	"start_time" text,
	"end_date" date NOT NULL,
	"end_time" text,
	"repeat" text DEFAULT 'none' NOT NULL,
	"repeat_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_repeat_check" CHECK ("events"."repeat" in ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly')),
	CONSTRAINT "events_time_check" CHECK (("events"."start_time" is null) = ("events"."end_time" is null) and ("events"."start_time" is null or ("events"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "events"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))),
	CONSTRAINT "events_order_check" CHECK (("events"."end_date", coalesce("events"."end_time", '')) >= ("events"."start_date", coalesce("events"."start_time", ''))),
	CONSTRAINT "events_until_check" CHECK ("events"."repeat_until" is null or "events"."repeat" <> 'none')
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"due_date" date NOT NULL,
	"due_time" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_due_time_check" CHECK ("tasks"."due_time" is null or "tasks"."due_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_exceptions_occurrence_idx" ON "event_exceptions" USING btree ("event_id","occurrence_date");--> statement-breakpoint
CREATE UNIQUE INDEX "events_uid_idx" ON "events" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "events_range_idx" ON "events" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "events" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_uid_idx" ON "tasks" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("completed_at","due_date");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");