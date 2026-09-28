CREATE TABLE "file_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_key" text NOT NULL,
	"path" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content" text NOT NULL,
	"file_mtime_ms" double precision NOT NULL,
	"file_size" integer NOT NULL,
	"model" text NOT NULL,
	"embedding" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_chunk" ADD CONSTRAINT "file_chunk_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_chunk_workspace_idx" ON "file_chunk" USING btree ("user_id","workspace_key");--> statement-breakpoint
CREATE UNIQUE INDEX "file_chunk_unique_idx" ON "file_chunk" USING btree ("user_id","workspace_key","path","chunk_index");