CREATE TABLE "screenshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"tool_call_id" uuid,
	"url" text NOT NULL,
	"title" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime_type" text DEFAULT 'image/jpeg' NOT NULL,
	"bytes" integer NOT NULL,
	"reason" text NOT NULL,
	"image" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshot" ADD CONSTRAINT "screenshot_tool_call_id_tool_call_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_call"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screenshot_task_created_idx" ON "screenshot" USING btree ("task_id","created_at");--> statement-breakpoint
-- Built-in browser agents that still have the Phase 4 default get the browser tools.
UPDATE "agent" SET "tools" = ARRAY['browser.open','browser.snapshot','browser.click','browser.type','browser.select','browser.press','browser.scroll','browser.back','browser.screenshot','browser.close','web.search','web.fetch'], "permissions" = ARRAY['NETWORK','EXECUTE'], "description" = 'Browses websites interactively: opens pages, clicks, fills forms, scrolls and extracts information. Use for tasks that need navigation or interaction, not just reading a page.', "instructions" = 'You are a browser automation specialist. Use browser.open to load a page, then read the numbered elements and page text you get back. Act with browser.click, browser.type, browser.select, browser.scroll and browser.press, and check the returned page after every action before deciding the next one. Prefer web.search to find URLs, then browse. Never enter credentials or payment details, and stop and report when a page asks for a login or CAPTCHA. Report exactly what you found, citing the URLs you visited.' WHERE "builtin" AND "slug" = 'browser' AND "tools" = ARRAY['web.fetch','web.search'];
