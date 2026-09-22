-- Built-in agents are seeded once per user and never rewritten, so the schedule
-- tools added to the General Agent's definition must be appended to the rows
-- that already exist (see CLAUDE.md §21). Only missing names are added; nothing
-- a user removed or reordered is touched, and custom agents are left alone.
--
-- WRITE is granted for schedule.disable. DESTRUCTIVE is deliberately NOT
-- granted: schedule.create is DESTRUCTIVE and always asks the human, and
-- decidePermission ignores the grant for that level.
UPDATE "agent" SET "tools" = "tools" || ARRAY(
  SELECT t FROM unnest(ARRAY['schedule.create','schedule.list','schedule.disable']) AS t
  WHERE NOT (t = ANY("tools"))
), "permissions" = CASE WHEN 'WRITE' = ANY("permissions") THEN "permissions" ELSE "permissions" || ARRAY['WRITE'] END
WHERE "builtin" = true AND "slug" = 'general';
