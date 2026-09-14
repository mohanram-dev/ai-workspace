-- Built-in agents are seeded once per user and never rewritten, so tools added
-- to their definitions later (docker, ssh, github) must be appended to the rows
-- that already exist. Only missing names are added; nothing a user removed or
-- reordered is touched, and custom agents are left alone.
UPDATE "agent" SET "tools" = "tools" || ARRAY(
  SELECT t FROM unnest(ARRAY['docker.ps','docker.logs','docker.stats','docker.inspect','docker.restart','docker.stop','docker.remove','ssh.run']) AS t
  WHERE NOT (t = ANY("tools"))
) WHERE "builtin" = true AND "slug" = 'devops';--> statement-breakpoint
UPDATE "agent" SET "tools" = "tools" || ARRAY(
  SELECT t FROM unnest(ARRAY['github.search_repositories','github.list_issues','github.read_issue']) AS t
  WHERE NOT (t = ANY("tools"))
), "permissions" = CASE WHEN 'NETWORK' = ANY("permissions") THEN "permissions" ELSE "permissions" || ARRAY['NETWORK'] END
WHERE "builtin" = true AND "slug" = 'coding';--> statement-breakpoint
UPDATE "agent" SET "tools" = "tools" || ARRAY(
  SELECT t FROM unnest(ARRAY['github.search_repositories']) AS t
  WHERE NOT (t = ANY("tools"))
) WHERE "builtin" = true AND "slug" = 'research';
