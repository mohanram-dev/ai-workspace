-- Built-in agents are seeded once per user and never rewritten (CLAUDE.md §21),
-- so sandbox.run, added to the Coding Agent's definition, is appended to the rows
-- that already exist. Only a missing name is added; nothing a user removed or
-- reordered is touched. EXECUTE, which it needs, is already the Coding Agent's.
-- The tool stays unavailable until the operator sets SANDBOX_ENABLED=true.
UPDATE "agent" SET "tools" = "tools" || ARRAY['sandbox.run']
WHERE "builtin" = true AND "slug" = 'coding' AND NOT ('sandbox.run' = ANY("tools"));
