# Contributing

Thanks for your interest. This project has one rule above all others, inherited from its specification:

> **No fake functionality.** Never simulate browser results, MCP responses, terminal output or agent execution. If something is not built, label it `NOT IMPLEMENTED` — and remove that label the moment it is.

Contributions are welcome whether you write every line yourself or work with an AI coding assistant. The bar is the same either way; the sections below say what each path looks like.

## Start here

**Read [`CLAUDE.md`](CLAUDE.md).** It is the development contract for this repository — architecture, conventions, the list of things that must not be changed casually, and the workflow for a change. It was written for humans and for AI assistants; every contributor is expected to know it. The original product specification is in [`docs/spec.md`](docs/spec.md) and is kept verbatim; do not edit it.

## Setting up

Requires Node 22+, pnpm 10 (`corepack enable`) and Docker (for PostgreSQL).

```bash
pnpm install
cp .env.example .env            # add BETTER_AUTH_SECRET and GEMINI_API_KEY
docker compose up -d postgres   # add redis if you work on the worker tier
pnpm db:migrate
pnpm dev                        # http://localhost:3000
pnpm check                      # typecheck + lint + tests + build; must pass before you start
```

## How to contribute

1. **Open an issue first** for anything bigger than a small fix, so the approach is agreed before you spend time on it. Bug reports need steps to reproduce; feature proposals need the user problem, not just the solution.
2. **Fork** the repository and clone your fork.
3. **Branch** from `main`: `git checkout -b fix/short-description` or `feat/short-description`.
4. **Make one scoped change.** No drive-by refactors, no unrelated formatting, no new dependencies without a stated reason (see `CLAUDE.md` §26).
5. **Test it.** New behaviour needs a test in the owning package; integration tests run against the real `aiw_test` database, not mocks. If the change affects behaviour, run it for real (`pnpm build && pnpm start`) and say so in the PR — several real bugs in this project's history were only found that way.
6. `pnpm check` must exit 0: typecheck, lint with zero warnings, all tests, production build.
7. **Update the docs** that the change touches: `README.md` (user-facing), `CLAUDE.md` (developer contract), `.env.example` and the README env table for new variables.
8. **Commit** with an imperative subject and a body that says *why*. Commit under your own name and email (a GitHub no-reply address is fine).
9. **Open a pull request** against `main`. Describe what changed, why, how you verified it, and anything you noticed but did not fix. Report failures plainly.

Schema changes: `pnpm db:generate`, rename the migration descriptively, update the journal tag, and call it out in the PR. Changing a built-in agent's default tools also needs a data migration (`CLAUDE.md` §21).

## Contributing with an AI coding assistant

You are welcome to use Claude Code, Cursor, Codex, Copilot, Gemini CLI or any other assistant. The project is set up for it:

- **Claude Code** reads `CLAUDE.md` automatically when opened in the repository root.
- **Other tools** that follow the `AGENTS.md` convention will find the root [`AGENTS.md`](AGENTS.md), which points them at `CLAUDE.md`. If your tool reads neither, paste `CLAUDE.md` into its context or point it at the file explicitly before asking for any change.

Rules that apply when an assistant does the typing:

1. **The assistant must read `CLAUDE.md` before making changes** and follow §29 (workflow) and §30 (rules). Ask it to confirm it has.
2. **You are the author.** Review every line before you commit it. Do not open a PR containing code you have not read and understood; reviewers will ask you about it, not the assistant.
3. **Verify, don't trust.** Assistants are prone to claiming a test passed or a feature works. Run `pnpm check` yourself and exercise the change in the running app. The no-fake-functionality rule applies to verification claims too.
4. **Say so in the PR.** A line such as "Written with Claude Code; reviewed and tested by me" is enough. It is not a mark against the contribution — it helps reviewers know where to look.
5. **Commit as yourself.** Do not add AI co-author trailers; contributions are attributed to the person responsible for them.
6. **Keep the assistant scoped.** Give it one change at a time; do not let it refactor, add packages or rewrite documents you did not ask about. If it did, remove that before opening the PR.

## Contributing without an AI assistant

Exactly the same process — nothing above depends on using one. `CLAUDE.md` is worth reading in full even so: it is the fastest route into the codebase, and §21 lists the non-obvious invariants that tests enforce but code comments do not always explain.

## What makes a good first contribution

- Anything labelled `good first issue`.
- Items under **Known limitations** in `CLAUDE.md` §22 that do not require a security decision: activity export, a second model provider behind the existing `ProviderRegistry`, scheduler catch-up, MCP prompts/resources.
- Test coverage for a code path that currently has none (`packages/runtime` has no tests).

Things that need discussion in an issue first: anything touching `decidePermission`, `NEVER_AUTONOMOUS`, the approval flow, SSRF or path guards, or the sandboxing question. These are the security boundary and are not changed casually.

## Security

Do not report vulnerabilities in public issues — see [`SECURITY.md`](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
