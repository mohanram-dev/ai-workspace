CREATE TABLE "task_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text,
	"step_id" uuid,
	"description" text NOT NULL,
	"status" text DEFAULT 'info' NOT NULL,
	"tool_name" text,
	"duration_ms" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pause_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_step_id_task_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."task_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_event_task_id_idx" ON "task_event" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "task_event_user_created_idx" ON "task_event" USING btree ("user_id","created_at");