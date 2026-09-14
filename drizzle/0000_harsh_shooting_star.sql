CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"path" text NOT NULL,
	"label" text NOT NULL,
	"mime_type" text NOT NULL,
	"locator" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"grades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" integer,
	"max_score" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"material_ids" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"material_id" uuid,
	"kind" text NOT NULL,
	"queue" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" text DEFAULT 'Waiting to start' NOT NULL,
	"error" text,
	"output_id" uuid,
	"conversation_id" uuid,
	"attempt_id" uuid,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"tries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "material_size_nonnegative" CHECK ("materials"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"quiz" jsonb,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material_ids" jsonb NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"material_id" uuid NOT NULL,
	"start_sample" bigint NOT NULL,
	"end_sample" bigint,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"id_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"locator" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"turn_id" integer NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"text" text NOT NULL,
	"speaker" text
);
--> statement-breakpoint
CREATE TABLE "upload_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"size" integer NOT NULL,
	"hash" text NOT NULL,
	"start_sample" bigint
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_turns" ADD CONSTRAINT "transcript_turns_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_turns" ADD CONSTRAINT "transcript_turns_segment_id_recording_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."recording_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_material_idx" ON "assets" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "attempts_output_idx" ON "attempts" USING btree ("output_id");--> statement-breakpoint
CREATE INDEX "conversations_project_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("queue","status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_project_idx" ON "jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "materials_project_idx" ON "materials" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "outputs_project_idx" ON "outputs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "recording_segments_material_idx" ON "recording_segments" USING btree ("material_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunk_ordinal_idx" ON "source_chunks" USING btree ("material_id","ordinal");--> statement-breakpoint
CREATE INDEX "source_chunk_search_idx" ON "source_chunks" USING gin (to_tsvector('simple', "text"));--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segment_turn_idx" ON "transcript_turns" USING btree ("segment_id","turn_id");--> statement-breakpoint
CREATE INDEX "transcript_material_idx" ON "transcript_turns" USING btree ("material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_chunk_sequence_idx" ON "upload_chunks" USING btree ("material_id","sequence");