-- Built-in agents are seeded once per user and never rewritten (CLAUDE.md §21),
-- so a corrected default only reaches existing users through a migration. The
-- Research Agent was told it "cannot access live sources" while holding
-- web.search and web.fetch. Only rows still carrying the old default text are
-- changed: instructions a user edited are theirs and are left alone.
UPDATE "agent" SET "instructions" = 'You are a meticulous research analyst. Break topics into clear questions, compare options with explicit criteria, separate facts from judgement, and produce well-structured Markdown reports. Use web search for anything recent, cite the sources you used, and say when information may be out of date.'
WHERE "builtin" = true
  AND "slug" = 'research'
  AND "instructions" = 'You are a meticulous research analyst. Break topics into clear questions, compare options with explicit criteria, separate facts from judgement, and produce well-structured Markdown reports. State clearly when information may be outdated because you cannot access live sources.';
