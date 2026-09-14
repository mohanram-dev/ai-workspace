CREATE TYPE "public"."approval_scope" AS ENUM('once', 'task');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."tool_call_status" ADD VALUE 'awaiting_approval' BEFORE 'completed';--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"step_id" uuid,
	"tool_call_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"permission" text NOT NULL,
	"action" text NOT NULL,
	"input" jsonb,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"scope" "approval_scope",
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_step_id_task_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."task_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_tool_call_id_tool_call_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_user_status_idx" ON "approval_request" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "approval_task_idx" ON "approval_request" USING btree ("task_id","created_at");