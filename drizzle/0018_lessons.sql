CREATE TABLE "lesson_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"values" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"score" real NOT NULL,
	"max_score" real NOT NULL,
	"status" text NOT NULL,
	"feedback" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lesson_answer_id" uuid;--> statement-breakpoint
ALTER TABLE "outputs" ADD COLUMN "lesson" jsonb;--> statement-breakpoint
ALTER TABLE "lesson_answers" ADD CONSTRAINT "lesson_answers_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_answers_question_idx" ON "lesson_answers" USING btree ("output_id","question_id","created_at");