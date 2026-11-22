ALTER TABLE "tasks" ADD COLUMN "moodle_feedback_course" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "moodle_opening_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_moodle_opening_id_tasks_id_fk" FOREIGN KEY ("moodle_opening_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_moodle_opening_idx" ON "tasks" USING btree ("moodle_opening_id") WHERE "tasks"."moodle_opening_id" is not null;