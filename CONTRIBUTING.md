# Contributing

Thanks for your interest. This project has one rule above all others, inherited from its specification:

> **No fake functionality.** Never simulate browser results, MCP responses, terminal output or agent execution. If something is not built, label it `NOT IMPLEMENTED` — and remove that label the moment it is.

## Start here

**Read [`CLAUDE.md`](CLAUDE.md).** It is the development contract for this repository — architecture, conventions, the list of things that must not be changed casually, and the workflow for a change. It applies to humans and AI coding assistants alike. The original product specification is in [`docs/spec.md`](docs/spec.md) and is kept verbatim; do not edit it.

## Setting up

```bash
pnpm install
cp .env.example .env            # add BETTER_AUTH_SECRET and GEMINI_API_KEY
docker compose up -d postgres   # add redis if you work on the worker tier
pnpm db:migrate
pnpm dev
```

Requires Node 22+ and pnpm 10 (`corepack enable`).

## Before you open a pull request

1. `pnpm check` must exit 0 — typecheck, lint with zero warnings, all tests, production build.
2. New behaviour needs a test in the owning package. Integration tests run against the real `aiw_test` database, not mocks.
3. If the change touches behaviour, verify it **live** (`pnpm build && pnpm start`) and say so in the PR. Several real bugs in this project's history were only found by running the real thing.
4. Schema changes: `pnpm db:generate`, rename the migration descriptively, update the journal tag, and note it in the PR. Changing a built-in agent's tools also needs a data migration (see `CLAUDE.md` §21).
5. Update `README.md` (user-facing) and `CLAUDE.md` (developer contract) when commands, conventions or important behaviour change.
6. One scoped change per PR. No drive-by refactors, no new dependencies without a stated reason.

## Pull request description

Say what changed, why, how you verified it, and anything you found along the way that you did not fix. Report failures plainly.

## Security

Do not report vulnerabilities in public issues — see [`SECURITY.md`](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
