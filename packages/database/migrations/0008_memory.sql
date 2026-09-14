CREATE TYPE "public"."memory_scope" AS ENUM('project', 'agent', 'conversation');--> statement-breakpoint
CREATE TYPE "public"."memory_source" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TABLE "memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"project_id" uuid,
	"agent_id" uuid,
	"conversation_id" uuid,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source" "memory_source" DEFAULT 'user' NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_user_scope_idx" ON "memory" USING btree ("user_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_project_key_idx" ON "memory" USING btree ("project_id","key") WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_agent_key_idx" ON "memory" USING btree ("agent_id","key") WHERE scope = 'agent';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_conversation_key_idx" ON "memory" USING btree ("conversation_id","key") WHERE scope = 'conversation';