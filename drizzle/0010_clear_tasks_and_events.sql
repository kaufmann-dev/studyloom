-- One-time reset for the Moodle calendar release: Studyloom starts with no own events or tasks.
DELETE FROM "event_exceptions";--> statement-breakpoint
DELETE FROM "events";--> statement-breakpoint
DELETE FROM "tasks";
