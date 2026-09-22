ALTER TYPE "public"."schedule_run_status" ADD VALUE 'completed' BEFORE 'skipped';--> statement-breakpoint
ALTER TYPE "public"."schedule_run_status" ADD VALUE 'errored' BEFORE 'skipped';--> statement-breakpoint
ALTER TYPE "public"."schedule_run_status" ADD VALUE 'cancelled' BEFORE 'skipped';