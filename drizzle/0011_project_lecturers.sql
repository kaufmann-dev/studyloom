CREATE TABLE "project_lecturers" (
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "project_lecturers_project_id_contact_id_pk" PRIMARY KEY("project_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "course" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lecturers" ADD CONSTRAINT "project_lecturers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lecturers" ADD CONSTRAINT "project_lecturers_contact_id_library_entries_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."library_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_lecturers_contact_idx" ON "project_lecturers" USING btree ("contact_id");