CREATE TYPE "public"."schedule_run_status" AS ENUM('started', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_trigger" AS ENUM('cron', 'interval', 'daily', 'weekly', 'monthly', 'once');--> statement-breakpoint
CREATE TABLE "schedule_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"task_id" uuid,
	"status" "schedule_run_status" NOT NULL,
	"detail" text,
	"scheduled_for" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"model" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" "schedule_trigger" NOT NULL,
	"cron" text,
	"interval_minutes" integer,
	"time_of_day" text,
	"weekday" integer,
	"day_of_month" integer,
	"run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_task_id" uuid,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_last_task_id_task_id_fk" FOREIGN KEY ("last_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_run_schedule_idx" ON "schedule_run" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_user_idx" ON "schedule" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "schedule_due_idx" ON "schedule" USING btree ("enabled","next_run_at");