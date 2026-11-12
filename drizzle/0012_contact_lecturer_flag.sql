ALTER TABLE "library_entries" ADD COLUMN "lecturer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "library_entries" ADD CONSTRAINT "library_lecturer_contact_check" CHECK (not "library_entries"."lecturer" or "library_entries"."kind" = 'contact');--> statement-breakpoint
-- Contacts already lecturing a project keep their assignments.
UPDATE "library_entries" SET "lecturer" = true WHERE "id" IN (SELECT "contact_id" FROM "project_lecturers");
