CREATE TYPE "public"."tool_call_status" AS ENUM('running', 'completed', 'failed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TABLE "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" uuid,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"provider_call_id" text,
	"tool_name" text NOT NULL,
	"category" text,
	"permission" text,
	"status" "tool_call_status" DEFAULT 'running' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"summary" text,
	"error" text,
	"error_code" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "tools" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "permissions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "max_tool_calls" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_step_id_task_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."task_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_call_task_created_idx" ON "tool_call" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_call_user_created_idx" ON "tool_call" USING btree ("user_id","created_at");--> statement-breakpoint
-- Default tools for existing built-in agents (only where nothing has been assigned yet).
UPDATE "agent" SET "tools" = ARRAY['web.search','web.fetch'], "permissions" = ARRAY['NETWORK'] WHERE "builtin" AND "slug" = 'general' AND cardinality("tools") = 0;--> statement-breakpoint
UPDATE "agent" SET "tools" = ARRAY['files.list','files.read','files.search','files.write','files.edit','files.delete','git.status','git.diff','git.log','git.init','git.add','git.commit','terminal.run'], "permissions" = ARRAY['WRITE','EXECUTE'] WHERE "builtin" AND "slug" = 'coding' AND cardinality("tools") = 0;--> statement-breakpoint
UPDATE "agent" SET "tools" = ARRAY['web.search','web.fetch','files.list','files.read','files.search','files.write'], "permissions" = ARRAY['NETWORK','WRITE'] WHERE "builtin" AND "slug" = 'research' AND cardinality("tools") = 0;--> statement-breakpoint
UPDATE "agent" SET "tools" = ARRAY['web.fetch','web.search'], "permissions" = ARRAY['NETWORK'] WHERE "builtin" AND "slug" = 'browser' AND cardinality("tools") = 0;--> statement-breakpoint
UPDATE "agent" SET "tools" = ARRAY['terminal.run','files.list','files.read','files.search','web.search','web.fetch'], "permissions" = ARRAY['EXECUTE','NETWORK'] WHERE "builtin" AND "slug" = 'devops' AND cardinality("tools") = 0;--> statement-breakpoint
UPDATE "agent" SET "tools" = ARRAY['files.list','files.read','files.search','files.write','files.edit','files.delete'], "permissions" = ARRAY['WRITE'] WHERE "builtin" AND "slug" = 'file' AND cardinality("tools") = 0;
