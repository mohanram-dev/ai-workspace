-- Built-in agents are seeded once per user and never rewritten (CLAUDE.md §21),
-- so files.semantic_search, added to the Coding, Research and File agents'
-- definitions, is appended to the rows that already exist. It is a READ tool,
-- so no permission grant is needed. Nothing a user removed is re-added twice.
UPDATE "agent" SET "tools" = "tools" || ARRAY['files.semantic_search']
WHERE "builtin" = true AND "slug" IN ('coding', 'research', 'file') AND NOT ('files.semantic_search' = ANY("tools"));
