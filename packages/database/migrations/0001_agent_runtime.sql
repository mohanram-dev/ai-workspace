CREATE TYPE "public"."agent_planning_mode" AS ENUM('auto', 'always', 'never');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'planning', 'running', 'waiting_for_tool', 'waiting_for_approval', 'paused', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"slug" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"provider" text DEFAULT 'gemini' NOT NULL,
	"model" text,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_output_tokens" integer DEFAULT 8192 NOT NULL,
	"planning_mode" "agent_planning_mode" DEFAULT 'auto' NOT NULL,
	"max_steps" integer DEFAULT 5 NOT NULL,
	"max_execution_seconds" integer DEFAULT 300 NOT NULL,
	"daily_budget_usd" numeric(10, 4),
	"use_conversation_history" boolean DEFAULT true NOT NULL,
	"max_history_messages" integer DEFAULT 20 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"routable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"status" "task_step_status" DEFAULT 'pending' NOT NULL,
	"output" text,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"conversation_id" uuid,
	"project_id" uuid,
	"retry_of_task_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"prompt" text NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"routing" jsonb,
	"model_override" text,
	"provider" text,
	"model" text,
	"result" text,
	"error" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "purpose" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_step" ADD CONSTRAINT "task_step_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_retry_of_task_id_task_id_fk" FOREIGN KEY ("retry_of_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_owner_slug_idx" ON "agent" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "task_step_task_index_idx" ON "task_step" USING btree ("task_id","index");--> statement-breakpoint
CREATE INDEX "task_user_created_idx" ON "task" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_user_status_idx" ON "task" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "task_agent_id_idx" ON "task" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "task_conversation_id_idx" ON "task" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("status");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_task_id_idx" ON "message" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "usage_log_agent_created_idx" ON "usage_log" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_log_task_id_idx" ON "usage_log" USING btree ("task_id");