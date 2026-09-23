ALTER TABLE "task" ADD COLUMN "include_history" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;