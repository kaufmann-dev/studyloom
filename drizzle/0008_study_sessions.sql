CREATE TABLE "study_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"attempt" integer NOT NULL,
	"answer" text NOT NULL,
	"verdict" text NOT NULL,
	"next" text NOT NULL,
	"gap" text DEFAULT '' NOT NULL,
	"feedback" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"segment_index" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "study" jsonb;--> statement-breakpoint
ALTER TABLE "study_answers" ADD CONSTRAINT "study_answers_run_id_study_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."study_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_runs" ADD CONSTRAINT "study_runs_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "study_answers_turn_idx" ON "study_answers" USING btree ("run_id","segment_index","attempt");--> statement-breakpoint
CREATE INDEX "study_runs_output_idx" ON "study_runs" USING btree ("output_id");