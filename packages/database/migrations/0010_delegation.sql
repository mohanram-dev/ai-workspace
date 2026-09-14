ALTER TABLE "task" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;