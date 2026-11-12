-- Keep any course designation by moving it into the description.
UPDATE "projects" SET "description" = CASE WHEN "description" = '' THEN "course" ELSE "course" || E'\n' || "description" END WHERE "course" <> '';--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "course";