ALTER TABLE "materials" ADD COLUMN "content_format" text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;