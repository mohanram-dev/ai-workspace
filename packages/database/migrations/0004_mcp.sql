CREATE TYPE "public"."mcp_server_status" AS ENUM('unknown', 'connected', 'error');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('stdio', 'http');--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"transport" "mcp_transport" NOT NULL,
	"command" text,
	"args" text[] DEFAULT '{}'::text[] NOT NULL,
	"url" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_seconds" integer DEFAULT 60 NOT NULL,
	"status" "mcp_server_status" DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"server_name" text,
	"server_version" text,
	"tools_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"annotations" jsonb,
	"default_permission" text NOT NULL,
	"permission" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool" ADD CONSTRAINT "mcp_tool_server_id_mcp_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool" ADD CONSTRAINT "mcp_tool_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_owner_slug_idx" ON "mcp_server" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_server_name_idx" ON "mcp_tool" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "mcp_tool_owner_idx" ON "mcp_tool" USING btree ("owner_id");