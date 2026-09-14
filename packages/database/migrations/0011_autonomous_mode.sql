ALTER TABLE "agent" ADD COLUMN "autonomous_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "trusted_tools" text[] DEFAULT '{}'::text[] NOT NULL;