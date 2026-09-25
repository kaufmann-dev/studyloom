CREATE TABLE "library_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"filename" text,
	"mime_type" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_kind_check" CHECK ("library_entries"."kind" in ('folder', 'file', 'link', 'contact', 'note')),
	CONSTRAINT "library_not_own_parent_check" CHECK ("library_entries"."parent_id" is distinct from "library_entries"."id"),
	CONSTRAINT "library_size_check" CHECK ("library_entries"."size" >= 0 and "library_entries"."received_bytes" >= 0 and "library_entries"."received_bytes" <= "library_entries"."size")
);
--> statement-breakpoint
CREATE TABLE "library_upload_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"size" integer NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"library_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pins_one_target_check" CHECK (("pins"."project_id" is null) <> ("pins"."library_id" is null))
);
--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_parent_id_library_entries_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_upload_chunks" ADD CONSTRAINT "library_upload_chunks_entry_id_library_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_library_id_library_entries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_parent_idx" ON "library_entries" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_upload_chunk_sequence_idx" ON "library_upload_chunks" USING btree ("entry_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "pins_project_idx" ON "pins" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pins_library_idx" ON "pins" USING btree ("library_id");