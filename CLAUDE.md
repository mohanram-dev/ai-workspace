# CLAUDE.md — AI Workspace

**Read this file before doing any work in this repository.** It is the source of truth for how the project is built, what must not change casually, and how future changes should be made. Update it whenever architecture, commands, conventions or important behaviour change.

---

## 1. Project overview

A self-hosted **AI Agent Workspace**: the user gives an AI a task, the system picks an agent, plans, calls real tools (files, git, terminal, web, browser, desktop, Docker, SSH, GitHub, MCP servers), pauses for human approval on destructive actions, streams every step live to the browser, and saves the complete execution history.

The product intent, verbatim from the original specification: *"I assigned work to an AI employee and I can watch it work."* The full 46-section spec is kept verbatim in [`docs/spec.md`](docs/spec.md). Every spec section is implemented except: S3-compatible storage (local disk by the owner's decision), the Anthropic native API (reachable through an OpenAI-compatible gateway), and voice input (spec defers it).

**Two rules from the spec govern everything (§42, §32):**
1. **No fake functionality.** Never simulate browser results, MCP responses, terminal output or agent execution. If something is not built, label it `NOT IMPLEMENTED` — and remove that label the moment it *is* built.
2. **Never expose API keys to the browser. Never allow arbitrary destructive commands without permission.**

**Status:** all 12 build phases complete and verified (2026-09-13/14). 252 tests across 12 packages. `pnpm check` exits 0. Source: https://github.com/mohanram-dev/ai-workspace (branch `main`).

---

## 2. Tech stack

| Layer | Choice | Pinned |
| --- | --- | --- |
| Runtime | Node.js ≥ 22, pnpm 10 (`corepack enable`) | `packageManager: pnpm@10.34.5` |
| Web | Next.js 16 (App Router, Turbopack), React 19, TypeScript 6 strict | `next 16.3.5`, `react 19.2.8`, `typescript 6.0.3` |
| UI | Tailwind CSS 4, shadcn/ui (style `radix-nova`, base `neutral`), Radix, lucide-react, Geist fonts, sonner toasts, next-themes | |
| Validation | Zod 4 (shared schemas used by both server and client) | `zod 4.6.4` |
| Database | PostgreSQL 17, Drizzle ORM + postgres-js | `drizzle-orm 0.45.2` |
| Auth | Better Auth (email + password, Drizzle adapter) | `better-auth 1.7.4` |
| AI | `@google/genai` (Gemini) and any OpenAI-compatible server (vLLM, Ollama, LiteLLM, self-hosted gateways) — registered twice: once as `openai-compatible` for a gateway you run, once as `openrouter`. Provider abstraction in `packages/ai` | |
| Queue | Redis + BullMQ (optional worker tier) | `bullmq 6.3.4`, `ioredis 6.0.0` |
| Browser agent | playwright-core (Chromium) behind a local SSRF egress proxy | `playwright-core 1.63.0` |
| Scheduler | cron-parser + timezone maths | |
| Tests | Vitest 5 | |
| Lint | ESLint 9 with `eslint-config-next`, `--max-warnings 0` | |
| Deploy | Docker multi-stage images, docker-compose, Coolify-compatible | |

Dependencies are **pinned to exact versions** in most packages. Follow that when adding one — and do not add one without a clear reason (see §26).

---

## 3. Architecture

```
Browser ── fetch + SSE ──► Next.js route handlers (apps/web/src/app/api/**)
                              │  Better Auth session, Zod validation, same-origin check
                              ▼
                     @aiw/runtime  (the ONE composition root: env, providers, tools,
                              │    browser/computer managers, MCP, agent services, queue)
                              ▼
                     @aiw/agents  AgentRuntime: route → plan → model/tool loop → events
                       │   │   │
              @aiw/tools │  @aiw/mcp  @aiw/browser  @aiw/computer  (real tools)
                         ▼
                 @aiw/database (Drizzle) ──► PostgreSQL
                 TaskEventBus ──► SSE streams (in-memory, or Redis pub/sub in queue mode)
```

**Two run modes, same code:**
- `REDIS_URL` **unset** → everything runs in the Next.js process: `InProcessTaskExecutor` + `InMemoryTaskEventBus`. This is the supported single-server setup, not a degraded mode.
- `REDIS_URL` **set** → the web tier only enqueues (`QueueTaskExecutor` → BullMQ); `apps/worker` runs the agents; events cross processes over `RedisTaskEventBus`; live browser/desktop frames are handed over through `RedisFrameStore`; exactly one process runs the schedule ticker (`RUN_SCHEDULER`).

**Task lifecycle:** `POST /api/tasks` → `TaskService.createTask` (capacity check, routing if no agent chosen) → executor → `AgentRuntime.execute` claims the row atomically (`claimQueuedTask`) → plan → per-step model calls with a tool loop → `TaskEventRecorder.emit` persists each event to `task_event` **then** publishes it → `finish` writes result/error/usage. Pause/stop/resume/retry/continue go through `TaskService`; stop reaches a worker over Redis.

**Permission flow (spec §16–17, §27):** tool declares `permission` (static, or a function of the input for `terminal.run` / `ssh.run`). `decidePermission(level, agent.permissions, {toolName, approvedForTask, autonomous})` → `allowed` | `needs_approval` | `denied`. READ always allowed; WRITE/EXECUTE/NETWORK need a grant; DESTRUCTIVE needs human approval unless approved-for-task or trusted in autonomous mode — and `NEVER_AUTONOMOUS` (`terminal.run`, `ssh.run`) can never be trusted. Every unattended action is an `AUTONOMOUS_ACTION` event + audit row.

---

## 4. Folder structure

```
apps/
  web/                      Next.js app: pages, API route handlers, features, UI
    src/app/(auth)/         sign-in, sign-up
    src/app/(workspace)/    every signed-in page (see §6)
    src/app/api/            route handlers (see §7)
    src/features/<area>/    UI + hooks per area: activity agents auth chat conversations files mcp projects schedules tasks
    src/components/shell/   sidebar, mobile bottom nav, nav-config.ts, user menu
    src/components/ui/      shadcn primitives (generated; lint-ignored; do not hand-edit style)
    src/components/         theme provider, not-implemented placeholder
    src/lib/                api-client.ts (apiFetch/errorMessage), auth-client.ts, format.ts, utils.ts (cn)
    src/server/             HTTP helpers, session, DTO mappers, chat service, files helpers,
                            and one-line re-exports of @aiw/runtime (env, providers, tools, browser, computer, agents)
    src/proxy.ts            Next "proxy" (middleware): cookie-presence redirect to /sign-in
    src/instrumentation.ts  startup: recover interrupted tasks, start scheduler (single-process mode)
    next.config.ts          security headers (CSP etc.), transpilePackages, BUILD_STANDALONE switch
  worker/                   queue consumer (tsx src/main.ts): TaskWorker + scheduler, graceful SIGTERM
packages/
  shared/      Zod schemas + DTO types shared by server and client; typed event map; NEVER_AUTONOMOUS; SSE framing
  database/    Drizzle schema (src/schema/*.ts), repositories (src/repositories/*.ts), migrations/, testing.ts, migrate.ts
  ai/          ModelProvider interface, ProviderRegistry, GeminiProvider, pricing, JSON output helpers
  agents/      BUILTIN_AGENTS, router, planner, AgentRuntime (tool loop), ApprovalService, delegation, memory tools,
               events/bus, SSE stream, executor, TaskService, recovery, prompts
  tools/       ToolRegistry, permissions engine, Workspace path guard, process runner, SSRF-safe fetch,
               built-ins: files, git, terminal, web, docker, ssh, github
  mcp/         MCP client manager, discovery, tool source, SecretBox (AES-GCM) for server secrets
  browser/     Playwright manager, egress proxy, page snapshots, browser.* tools, live frames
  computer/    desktop drivers (Windows PowerShell, Linux xdotool), computer.* tools
  scheduler/   trigger maths (timezone aware, cron), Scheduler ticker
  queue/       BullMQ QueueTaskExecutor, RedisTaskEventBus, TaskWorker, RedisFrameStore
  runtime/     composition root shared by web + worker (env schema lives here: src/env.ts); tests reset the module graph and the __aiw* globals per case
docs/spec.md              the original specification, verbatim (do not edit)
AGENTS.md, SECURITY.md, CONTRIBUTING.md, LICENSE (Apache-2.0)   open-source front matter; AGENTS.md and CONTRIBUTING.md point here
docker/postgres/init/     creates the aiw_test database
scripts/backup.sh|restore.sh
Dockerfile, Dockerfile.worker, docker-compose.yml (dev), docker-compose.prod.yml, .dockerignore
data/workspaces/          per-user agent workspaces on local disk (gitignored)
```

---

## 5. Important files

| File | Why it matters |
| --- | --- |
| `packages/runtime/src/env.ts` | **The** environment schema (Zod). Every env var, its default and validation. Add new vars here first. |
| `packages/runtime/src/agents.ts` | Builds ApprovalService, event bus, AgentRuntime, executor, TaskService; switches single-process vs queue mode. |
| `packages/agents/src/runtime.ts` | The agent loop: claim, route, plan, steps, tool calls, permissions, approvals, events, finish. ~1,200 lines; read before touching execution behaviour. |
| `packages/agents/src/service.ts` | TaskService: create/stop/retry/continue/pause/resume with ownership + capacity checks. |
| `packages/agents/src/builtin.ts` | Default agents and their tools/permissions. **Changing tools here does not reach existing users** — see §21. |
| `packages/tools/src/permissions.ts` | `decidePermission`; the autonomous floor. |
| `packages/shared/src/events.ts` | `TASK_EVENT_TYPES` + `TaskEventDataMap`. Adding an event type also requires an icon in `activity-timeline.tsx` and, if it is a tool activity, a description in `runtime.ts`. |
| `packages/shared/src/agents.ts` | Agent config schema/DTO, `NEVER_AUTONOMOUS`. |
| `packages/database/src/schema/*.ts` | 22 tables. Change → `pnpm db:generate` → rename the migration → `pnpm db:migrate`. |
| `packages/database/src/testing.ts` | Resets the test DB; refuses any DB whose name does not end in `_test`. |
| `apps/web/src/server/http.ts` | `HttpError`, `errorResponse`, `assertSameOrigin`, `readJson(schema)`, `isUuid`. Use these in every route. |
| `apps/web/src/server/session.ts` | `requireApiSession` (routes) / `requirePageSession` (pages). |
| `apps/web/src/server/agent-dto.ts`, `dto.ts`, `project-dto.ts` | Row → DTO mappers. Never return Drizzle rows to the client directly. |
| `apps/web/src/lib/api-client.ts` | `apiFetch<T>()` and `errorMessage()`; the only way the client calls the API. |
| `apps/web/src/components/shell/nav-config.ts` | Sidebar + mobile nav. Sidebar rows are inset `px-2`; the conversation search box and dividers must match, or the left edge steps in and out. |
| `apps/web/next.config.ts` | CSP and security headers; `BUILD_STANDALONE=true` enables standalone output (Docker only — it breaks `next start`). |
| `apps/web/src/instrumentation.ts` | Startup recovery and scheduler; does nothing in queue mode (the worker owns those). |

---

## 6. Pages / routes

All under `(workspace)` require a session (page-level `requirePageSession`; the proxy only checks cookie presence).

| Route | Purpose |
| --- | --- |
| `/` | New task / chat composer (agent picker, project picker, model picker, attachments). The model picker lists **every configured provider's** models, grouped by provider, default provider first — pick per task without touching `DEFAULT_PROVIDER` |
| `/c/[conversationId]` | A conversation with its messages and task cards |
| `/conversations` | Search, rename, delete, archive, pin |
| `/agents`, `/agents/new`, `/agents/[agentId]` | Agent list and editor (tools, permissions, limits, autonomous mode) |
| `/projects`, `/projects/[projectId]` | Projects with files, memory, tasks, schedules |
| `/tasks`, `/tasks/[taskId]` | History; task page with tabs Overview · Activity · Tools · Browser · Computer · Team · Terminal · Files · Logs (shown only when relevant) |
| `/schedules` | Cron/daily/weekly/monthly/interval/once schedules + run history |
| `/files` | Workspace browser: upload, preview, search, create, download, delete. Previews text, images, PDF, audio and video |
| `/mcp`, `/mcp/new`, `/mcp/[serverId]` | MCP servers, tool discovery, per-tool permissions |
| `/activity` | Observability dashboard + live event feed |
| `/settings` | Providers, account |
| `/sign-in`, `/sign-up` | Auth. First account becomes admin; further sign-ups need `ALLOW_REGISTRATION=true` |

Mobile bottom nav: Chat · Tasks · Agents · Activity · Settings.

The desktop sidebar's `PRIMARY_NAV` lists workspace destinations only. **Settings is deliberately not in it** — account and server configuration lives in the user menu (`components/shell/user-menu.tsx`), which also holds the theme switcher. The mobile bottom bar keeps Settings because there is no persistent user menu there.

`PRIMARY_NAV`, `MORE_NAV` and the user menu must stay **mutually disjoint**: the sidebar is visible while either menu is open, so an entry in two of them appears twice on one screen. `PRIMARY_NAV` is the always-visible rows, `MORE_NAV` is the sidebar's "More" flyout (set-up-once destinations), and the user menu holds account-scoped items only (Settings, Theme, Sign out).

The "More" flyout opens to the right on desktop and **downwards below `md`**, chosen from `matchMedia`, not left to Radix: inside the mobile sheet an animated ancestor carries a transform, so collision detection measures the wrong box and a right-opening menu ran 176px off a 390px screen instead of flipping.

---

## 7. API architecture

Route handlers live at `apps/web/src/app/api/**/route.ts`. Every handler follows the same shape:

```ts
export async function POST(request: Request) {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);   // mutations only (CSRF)
    const { user } = await requireApiSession(request);   // 401 otherwise
    const input = await readJson(request, someZodSchema); // 400 with issue paths
    // ... ownership is always checked: getXForUser(db, user.id, id) → 404 if not theirs
    return Response.json(toXDto(row), { status: 201 });
  } catch (error) {
    return errorResponse(error);                          // HttpError/AppError → status; else 500
  }
}
```

- **Errors** are `{ error: { code, message, issues? } }`. Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `internal`. Package code throws `AppError` (from `@aiw/shared`); routes throw `HttpError`; both are recognised by **shape** (`isAppError`), not `instanceof` — see §21.
- **Streaming**: `POST /api/chat` streams typed SSE events (`start → delta* → done|error`); `GET /api/tasks/:id/events` streams the task timeline with replay via `Last-Event-ID` / `?replay=1`; `GET /api/activity/events` streams every event for the user.
- **Live task controls**: `POST /api/tasks/:id/{stop,pause,resume,retry,continue}` share `server/task-control.ts`.
- **Health**: `GET /api/health` (db + queue, 503 if degraded, backs the Docker healthcheck); `GET /api/ready` (adds queue depth).
- Full route list: see `find apps/web/src/app/api -name route.ts`. The README has a table.

---

## 8. Database

PostgreSQL via Drizzle. Schema in `packages/database/src/schema/`, one file per area; all tables are exported from `schema/index.ts` and re-exported as `schema` from `@aiw/database`.

**Tables (22):** `user session account verification` · `agent task task_step` · `task_event` · `tool_call` · `approval_request` · `conversation message` · `project project_member` · `memory` · `mcp_server mcp_tool` · `schedule schedule_run` · `screenshot` · `usage_log audit_log`.

**Conventions**
- UUID primary keys (`defaultRandom`), `created_at`/`updated_at` timestamptz, `onDelete` cascades from `user`.
- Access goes through **repositories** (`src/repositories/*.ts`): `getXForUser(db, userId, id)` is the ownership check; never query a user's rows without the userId filter.
- Aggregates use raw `sql\`\`` with `.mapWith(Number)` (Drizzle subqueries lose table qualification — Phase 5 lesson).
- Partial index predicates must use `sql.raw` (Postgres rejects bound parameters in DDL).
- **Migrations**: `pnpm db:generate` creates `NNNN_<random>.sql`; **rename it descriptively and update the `tag` in `migrations/meta/_journal.json`**, then `pnpm db:migrate`. 14 migrations exist, `0000_init` → `0013_builtin_agent_tools`. Data migrations (like 0013) are hand-written.
- **Test DB**: tests reset `aiw_test` (created by `docker/postgres/init`). `testing.ts` refuses any name not ending in `_test`. **Never run package tests while a live server uses the test DB.**

---

## 9. Authentication & authorization

- Better Auth, email + password (min 10 chars), 7-day sessions refreshed daily, secure cookies when `APP_URL` is https, rate limits (5 sign-ins/min, 5 sign-ups/hour per IP).
- `user.role` is `admin | member`. **First account becomes admin**; later sign-ups are refused unless `ALLOW_REGISTRATION=true`. The role field has `input: false` so clients cannot set it.
- Admin-only today: stdio MCP servers (`isAdmin` in `server/mcp.ts`). Everything else is per-user ownership.
- `proxy.ts` redirects cookie-less visitors to `/sign-in` but is **optimistic**: every page and route still validates the session server-side. Do not rely on the proxy for security.
- Trusted origin = `APP_URL`. If the server runs on a different port/host than `APP_URL`, sign-in fails with "Invalid origin" — this is intentional CSRF protection, not a bug.

---

## 10. UI & component conventions

- **Feature folders** (`src/features/<area>/`) hold the page component (`<area>-page.tsx`), sub-components, `api.ts`, and hooks (`use-*.ts`). Pages under `src/app/` are thin wrappers that render the feature component and set `metadata`.
- `"use client"` only where hooks/events are needed; data-loading pages fetch on the server where possible.
- shadcn primitives in `src/components/ui/` are generated. Available: alert-dialog avatar badge button card dialog dropdown-menu input label progress scroll-area select separator sheet skeleton sonner switch tabs textarea tooltip. **There is no Checkbox** — use `Switch`. Add a primitive with the shadcn CLI, not by hand.
- Icons: `lucide-react` only. Class merging: `cn()` from `@/lib/utils`.
- Loading → `Skeleton`; empty → dashed-border message; errors → `role="alert"` paragraph or `toast.error(errorMessage(e))`.
- Toasts: `sonner` (`toast.success/error`).
- Placeholders for unbuilt features use `components/not-implemented.tsx` or an inert, labelled control — and must be **removed when the feature ships**. Three stale placeholders were found in an audit; do not create a fourth.
- The `"use client"` directive must be the **first line** of the file, before imports.
- Browser code must not depend on **secure-context-only** APIs (`crypto.randomUUID`, `crypto.subtle`, clipboard write, etc.) without a fallback: a LAN address or bare IP over plain http is a legitimate deployment, and those APIs are `undefined` there. `crypto.getRandomValues` is safe everywhere.
- Relative time / tokens / cost / duration / bytes: always via `@/lib/format.ts` (`formatCost` keeps 4 decimals under $1 so totals match their rows).

---

## 11. Styling

- Tailwind 4 with `@theme inline` tokens in `src/app/globals.css`; colours are CSS variables (`--background`, `--brand`, `--success`, `--warning`, `--destructive`, sidebar and chart tokens). Use token classes (`bg-card`, `text-muted-foreground`, `border-warning/40`), never hard-coded colours.
- Dark mode via `next-themes` (`attribute="class"`, default `system`); the `dark` custom variant is `&:is(.dark *)`.
- Fonts: Geist Sans / Geist Mono through `--font-geist-*`. Code, paths and tool names are `font-mono text-xs`.
- Layout rhythm used everywhere: page wrapper `mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10`; cards `rounded-xl border bg-card`; section header `border-b px-4 py-3 text-sm font-semibold`.
- Scrollable regions get `scrollbar-thin`. Wide tables/code go inside `overflow-x-auto`; the page body must never scroll horizontally.

---

## 12. State management

No external state library. Patterns in use:
- Local `useState`/`useReducer` inside feature components.
- One React context: `features/conversations/conversations-context.tsx` (sidebar list).
- Server data is fetched with `apiFetch` inside `useEffect` using the **promise-chain pattern** (`.then(...)` with an `active` flag) — the React Compiler lint rule rejects synchronous `setState` in an effect and directly-invoked async functions. Copy `schedules-page.tsx` or `activity-page.tsx`.
- Live data comes from SSE: `use-task-live.ts` (per task: events, deltas, terminal chunks, browser/computer frames, refresh-on-event) and the Activity page's `EventSource`.
- Optimistic updates for toggles/deletes, rolled back on error (see `schedules-page.tsx`).
- `localStorage` only for per-device conveniences (remembered agent mode), always in try/catch.

---

## 13. Form validation

- **Schemas live in `@aiw/shared`** and are used on both sides: the server validates with `readJson(request, schema)`; the client relies on server messages (`errorMessage(e)` appends issue paths). There is no form library.
- Forms are controlled `useState` + `onSubmit` with `event.preventDefault()`, a `saving` flag, and an inline `role="alert"` error. Example: `features/schedules/schedule-form.tsx`. **Every `<form>` carries `method="post"`**: if JavaScript has not attached, the browser's fallback submit must never put field values (passwords, API keys) into the URL.
- Numeric limits come from shared constants (`AGENT_LIMITS`, `MAX_MESSAGE_LENGTH`, `MAX_ATTACHMENTS_PER_MESSAGE`) — never duplicate a limit in the client.

---

## 14. Error handling

- **Server**: throw `HttpError(status, code, message)` in routes, `AppError` in packages; `errorResponse` maps them. Unknown errors log and return 500 without detail.
- **Agent tasks**: failures become a `TaskError` (`code, title, message, stepIndex, stepTitle, retryable, suggestedAction, detail`) — human-readable first, raw detail behind an expander (spec §40). Tool failures are `ToolError(code, message)` and are **fed back to the model** so it can recover; they do not fail the task.
- **"Ask agent to fix"**: continuing a failed task keeps the failed step's `error` and writes it into the retried step's prompt. `resetUnfinishedSteps` deliberately does not clear `error`.
- A delegated sub-task that fails does not fail its parent; the manager is told and decides.
- Provider 429/503 are retried with backoff (`retryDelaysMs`); tests pass `[]`.

---

## 15. Security rules (enforced; do not weaken)

1. Model API keys and secrets exist only on the server (`getServerEnv()`); nothing under `src/features` or `src/components` may read them.
2. Every mutation route calls `assertSameOrigin`; every route calls `requireApiSession`; every row access is scoped by `user.id`.
3. **Path traversal**: all file access goes through `Workspace.resolve()` (`@aiw/tools`), which confines paths to the user's/project's workspace. Uploaded names are sanitised (`safeFileName`).
   **Serving workspace bytes inline** (`/api/files/content?raw=1`) is limited to the `PREVIEWABLE` allowlist in `server/files.ts`, always with the allowlist's own media type, never a sniffed one — a type the browser executes (`text/html`, `.js`, `.xhtml`) would be stored XSS on this origin. That route also carries its own `Content-Security-Policy: sandbox; default-src 'none'` from `next.config.ts`: a route handler cannot set it, because Next replaces a header the global rule already defines, and the app's own policy allows `script-src 'unsafe-inline'`, which would let a directly-opened SVG run.
4. **SSRF**: `web.fetch`, MCP http, GitHub and the browser use socket-level DNS checks that refuse private/loopback addresses (re-checked on redirects); the browser goes through a local egress proxy. The `*_ALLOW_PRIVATE_NETWORK` flags are off by default.
5. **Terminal / SSH / Docker** run as the server's OS user — **not a sandbox**. Off by default; `terminal.run` uses an allowlist and `shell: false`; commands are classified and destructive ones need approval; `ssh.run` can only reach hosts named in `SSH_HOSTS`; Docker container args are validated as plain identifiers.
6. **DESTRUCTIVE** always needs a human unless approved-for-task or autonomously trusted; `terminal.run`/`ssh.run` are never trustable (`NEVER_AUTONOMOUS`). Autonomous actions are audited.
7. MCP header/env secrets are encrypted at rest (`SecretBox`, key derived from `BETTER_AUTH_SECRET`) and never returned to the client after saving.
8. Security headers (CSP, nosniff, DENY framing, HSTS on https) are set in `next.config.ts`.
9. Audit log (`audit_log`) records task controls, approvals, memory writes, file creation, autonomous actions, MCP changes.
10. Per-agent limits: `maxExecutionSeconds`, `maxToolCalls`, `dailyBudgetUsd` (execution stops on `budget_exceeded`); delegation depth/count/time limits.

---

## 16. Environment variables

Defined and validated in `packages/runtime/src/env.ts`. Documented with comments in `.env.example` (copy to `.env`). **Never print `.env` contents, and never commit it** (it is gitignored).

| Group | Variables |
| --- | --- |
| Required | `DATABASE_URL`, `APP_URL` (must match the served origin), `BETTER_AUTH_SECRET` (≥ 32 chars) |
| Gemini | `GEMINI_API_KEY`, `GEMINI_DEFAULT_MODEL`, `GEMINI_MODELS`, `ROUTER_MODEL` |
| OpenAI-compatible | `OPENAI_BASE_URL` (unset = off), `OPENAI_API_KEY` (optional), `OPENAI_DEFAULT_MODEL`, `OPENAI_MODELS`, `OPENAI_PROVIDER_NAME` |
| OpenRouter | `OPENROUTER_API_KEY` (unset = off), `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_MODELS`, `OPENROUTER_APP_NAME` |
| Provider default | `DEFAULT_PROVIDER` (`gemini` \| `openai-compatible` \| `openrouter`). `ROUTER_MODEL` resolves against it, so change them together |
| Fallback | `MODEL_FALLBACKS` — models tried in order when the chosen one cannot answer; resolved through the registry, so they may span providers |
| Security | `ALLOW_REGISTRATION` (false), `CHAT_RATE_LIMIT_PER_MINUTE` |
| Tasks | `MAX_RUNNING_TASKS_PER_USER`, `WORKSPACE_ROOT` (`./data/workspaces`) |
| Terminal | `TERMINAL_ENABLED` (false), `TERMINAL_ALLOWED_COMMANDS`, `TERMINAL_TIMEOUT_SECONDS` |
| Web | `WEB_SEARCH_PROVIDER` (gemini/searxng/none), `WEB_SEARCH_MODEL`, `SEARXNG_URL`, `WEB_FETCH_ALLOW_PRIVATE_NETWORK` |
| Infra tools | `DOCKER_TOOLS_ENABLED`, `DOCKER_TIMEOUT_SECONDS`, `SSH_TOOLS_ENABLED`, `SSH_HOSTS`, `SSH_TIMEOUT_SECONDS`, `GITHUB_TOKEN`, `GITHUB_API_URL` |
| MCP | `MCP_STDIO_ENABLED` (false, admins only), `MCP_ALLOW_PRIVATE_NETWORK` |
| Browser | `BROWSER_ENABLED`, `BROWSER_CHANNEL`, `BROWSER_EXECUTABLE_PATH`, `BROWSER_MAX_SESSIONS`, `BROWSER_ALLOW_PRIVATE_NETWORK` |
| Computer | `COMPUTER_USE_ENABLED` (false), `COMPUTER_MAX_WIDTH`, `DISPLAY` (Linux) |
| Approvals | `APPROVAL_TIMEOUT_MINUTES` |
| Delegation | `DELEGATION_ENABLED`, `MAX_DELEGATION_DEPTH`, `MAX_DELEGATIONS_PER_TASK`, `MAX_SUBTASK_SECONDS` |
| Production | `REDIS_URL` (unset = single process), `WORKER_CONCURRENCY`, `RUN_SCHEDULER`, `BUILD_STANDALONE` (Docker build only) |
| Tests | `TEST_DATABASE_URL` (default `…/aiw_test`) |

Known quirk of this dev machine: `WEB_SEARCH_MODEL` is deliberately `gemini-2.5-flash-lite` because grounding returns 429 on `gemini-3.1-flash-lite` with this key.

---

## 17. External services

- **Any OpenAI-compatible server** (`OPENAI_BASE_URL`): streaming, tool calls and `json_schema` structured output. Its base URL is **operator configuration**, so a private/LAN address is expected there and does not weaken the SSRF guards on `web.fetch`, MCP and the browser, which take untrusted input. Reasoning models put thinking in `reasoning_content` (vLLM/NIM) or `reasoning` (OpenRouter) — never emit either as answer text. Tool-call arguments arrive as streamed fragments and must be accumulated before use.
- **OpenRouter** (`OPENROUTER_API_KEY`): the same provider class with `id: "openrouter"` and `requiresApiKey: true`, because its base URL has a default and only the key decides whether it is usable. `OPENROUTER_MODELS` defaults to a set verified live against the API — every entry streams, calls tools **and** honours `json_schema` **on the app's real 8-agent router prompt**; the comment above the list in `env.ts` names each excluded model and what it failed. Watch for a model that returns `finish_reason: "stop"` with **empty content** because reasoning ate the whole budget (`openai/gpt-oss-20b` does this): nothing errors, routing just silently falls back to the general agent. An id the account cannot use comes back as `invalid_request` with OpenRouter's own sentence.
- **Google Gemini** (`@google/genai`): chat, planning, routing, tool calling, grounded search. Tool-result **images must be nested inside `functionResponse.parts`** (siblings leak stray tokens); user images are `inlineData` parts after the text; function names are sanitised to `[a-zA-Z0-9_]`, ≤ 64 chars; thought signatures must be echoed back with function calls.
- **GitHub REST API** (read-only tools), **Docker CLI**, **ssh** client, **SearXNG** (optional), **MCP servers** the user configures.
- **PostgreSQL**, **Redis** (optional).

---

## 18. Development commands

```bash
pnpm install
cp .env.example .env            # fill BETTER_AUTH_SECRET, GEMINI_API_KEY
docker compose up -d postgres   # (+ redis only if testing queue mode)
pnpm db:migrate
pnpm dev                        # http://localhost:3000

pnpm typecheck                  # all packages (next typegen + tsc)
pnpm lint                       # ESLint, zero warnings allowed
pnpm test                       # Vitest, packages one at a time; resets aiw_test
pnpm build                      # next build
pnpm check                      # typecheck + lint + test + build — must exit 0 before any change is "done"

pnpm db:generate / db:migrate / db:studio
pnpm --filter @aiw/worker start # worker tier (needs REDIS_URL)
pnpm --filter @aiw/agents exec vitest run test/delegation.test.ts   # one file
```

**Live verification** (how this project was built): run `pnpm build && pnpm start`, sign in, and exercise the feature through the real API/UI (Playwright via `playwright-core` with `channel: "msedge"` works on this machine). Free port 3000 first (EADDRINUSE is common). Sign-up is rate limited to 5/hour — reuse an existing test account.

---

## 19. Deployment

- **Images**: `Dockerfile` (web, Next standalone; `BUILD_STANDALONE=true` set inside), `Dockerfile.worker` (built on `mcr.microsoft.com/playwright:v1.63.0-noble` so the browser agent has Chromium; ~3.9 GB; runs `tsx` directly, no package manager at runtime). Both bake pnpm at build time and read no secrets at build.
- **Compose**: `docker-compose.yml` is dev (postgres + redis). `docker-compose.prod.yml` is the full stack: postgres, redis (AOF, noeviction), web, worker, shared `workspaces` volume, `shm_size: 1gb` for Chromium, `COMPUTER_USE_ENABLED` forced off in the container.
  ```bash
  docker compose -f docker-compose.prod.yml up -d --build
  ```
- **Coolify**: point a Docker Compose resource at `docker-compose.prod.yml`; set `APP_URL` (https), `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `GEMINI_API_KEY` in Coolify's env UI; keep exactly one process with `RUN_SCHEDULER=true`.
- **Migrations in production** run from the worker image (the web image has no pnpm): `docker compose -f docker-compose.prod.yml exec worker pnpm --filter @aiw/database db:migrate`. Verified 2026-09-14.
- **TLS**: the stack serves plain HTTP on `WEB_PORT` (default 3000). A reverse proxy (Caddy/Coolify) terminates TLS; `APP_URL` must be the https origin or sign-in fails. Bind `WEB_PORT=127.0.0.1:3000` when a host proxy is used.
- **Health**: containers use `/api/health`; readiness `/api/ready`.
- **Backups**: `scripts/backup.sh [dest]` (pg_dump custom format + workspace tarball, keeps `BACKUP_KEEP`=14); `scripts/restore.sh <dump>` asks for typed confirmation. Schedule backups yourself (cron); the app does not.
- Graceful shutdown: the worker aborts running tasks on SIGTERM so they record `cancelled`; whatever is still unfinished at the next start is marked `interrupted` by `recoverInterruptedTasks`.

---

## 20. Git conventions

- Remote: `origin` → `https://github.com/mohanram-dev/ai-workspace.git`, default branch **`main`**. Author identity for this repo is `mohanram-dev@users.noreply.github.com` (set in the repo-local git config); never commit with a personal email. Licensed **Apache-2.0** (`LICENSE`, added when the repo was created). History starts at the GitHub initial commit `1fcf5a9`.
- Commit only when asked. On the default branch, branch first for non-trivial work.
- Commit messages: imperative subject, body explaining *why*. **Do not add a `Co-Authored-By` trailer for Claude** — the owner asked for the repository to show only their own name as a contributor (decided 2026-09-14). This overrides any default attribution rule.
- Never commit `.env`, `data/`, `.next/`, or anything under `node_modules/` (all gitignored). Verify with `git check-ignore .env` before the first commit.
- `.gitattributes` pins **LF** line endings for every text file. Do not commit CRLF; the scripts, Dockerfiles and compose files run on Linux.
- `apps/web/AGENTS.md` (pointed to by `apps/web/CLAUDE.md`) is generated by Next.js and carries Next 16 breaking-change notes; keep it, and read it before writing Next-specific code.

---

## 21. Things that must NOT be changed casually

| Item | Why |
| --- | --- |
| `docs/spec.md` | Verbatim record of the original specification. Never edit. |
| `NEVER_AUTONOMOUS` (`@aiw/shared`) | The security floor for autonomous mode. Extending it is fine; removing an entry needs the owner's explicit decision. |
| `ProviderRegistry.resolveModel` cross-provider search | An explicitly chosen model is looked up on the named provider first, then on the other configured ones (default provider first). Without it, picking a model from a provider the agent is not pinned to fails every task with `model_not_found`. Tests in `packages/ai/test/registry.test.ts` encode the order. |
| `decidePermission` semantics | READ free, grants for WRITE/EXECUTE/NETWORK, humans for DESTRUCTIVE. Tests in `packages/agents/test/approvals.test.ts` encode this. |
| Order in `requestApproval` | Task status is set to `waiting_for_approval` **before** the approval row is created. Reversing it reintroduces a race where a pending approval is visible while the task claims to be running. |
| Event publish order | `TaskEventRecorder.emit` persists first, then publishes. SSE replay depends on it. |
| `FALLBACK_CODES` in `runtime.ts` | Which provider failures switch model. `aborted` must stay out (Stop and the execution timeout surface as it, and re-running that work elsewhere ignores them), and a budget stop is a `TaskFailure` so it never reaches the check. `RunState.fallbackModel` makes the switch stick for the rest of the task, and `resolveAgent` copies it back off the routing state — without either, every call pays the dead model's full backoff again. Tests in `packages/agents/test/model-fallback.test.ts`. |
| `resetUnfinishedSteps` keeping `error` | That error is what "Ask agent to fix" shows the agent. |
| `BUILTIN_AGENTS` tools | Seeded once per user with `onConflictDoNothing`. **Changing a built-in agent's tools requires a data migration** (see `0013_builtin_agent_tools.sql`), or existing users never get the tool and the agent answers from memory instead of using it. |
| Shape-based error guards (`isAppError`, `isProviderError`, `isToolError`) | Turbopack can load a workspace package twice, so `instanceof` fails across package boundaries. |
| `Workspace.resolve` as the only path resolver | It is the path-traversal guard. |
| Gemini image placement | Tool images inside `functionResponse.parts`; anything else corrupts model output. |
| `output: "standalone"` gating | Only under `BUILD_STANDALONE=true`; unconditional standalone breaks `pnpm start`. |
| `src/components/ui/**` | Generated shadcn code, lint-ignored. Regenerate with the CLI rather than editing. |
| `testing.ts` `_test` guard | Prevents tests from wiping a real database. |
| `.env` on this machine | Holds real credentials. Never echo it. |

---

## 22. Known limitations / issues

- **No sandbox** for `terminal.run`, `ssh.run`, Docker tools or the browser: they run as the process user (inside the worker container in production, which limits blast radius but is not isolation). This is the one genuine security gap; all three tool groups are off by default because of it.
- Providers: **Gemini**, **OpenAI-compatible** and **OpenRouter**. The Anthropic native API is not implemented natively; reach Claude models through OpenRouter or another gateway. A gateway's `/models` may list hundreds of entries (OpenRouter: 400+), so set `OPENAI_MODELS` / `OPENROUTER_MODELS` to keep the picker usable.
- **S3** storage is not implemented (owner's decision: local disk under `WORKSPACE_ROOT`).
- Voice input: not built (spec says "later").
- MCP: OAuth sign-in, prompts and resources are NOT IMPLEMENTED (tools only).
- Browser: no persistent logins across tasks, no file download/upload through the page, follows the newest tab only.
- Scheduler: no catch-up for runs missed while the server was down; no per-schedule retries.
- Activity: no export (CSV/Prometheus), no per-project filter, no retention/rollups — events and usage rows are kept forever.
- Delegation: sequential only (the manager waits for each sub-task); no cross-user delegation; sub-tasks bypass `MAX_RUNNING_TASKS_PER_USER` by design.
- Worker image is large (Playwright base). Logs go to stdout only.
- Windows dev notes: Defender AMSI blocks PowerShell scripts that base64-encode screenshots in-script (the desktop driver writes a temp file instead); `page.evaluate(fn)` gets bundler helpers injected — keep in-page scripts as plain JS strings.

---

## 23. Current status & remaining TODOs

**Status:** feature-complete against the spec, verified live (real Gemini, real Docker, real GitHub, headless-browser UI passes), `pnpm check` green with 252 tests across 12 packages.

**TODOs, in priority order**
1. **Rotate the Gemini API key** in `.env` — it has been exposed in chat sessions during development.
2. Remove the stray `0` on the last line of `.env` (harmless, ignored by the parser).
3. Use the app for real for a week and fix what daily use surfaces.
4. Before internet exposure: fresh `BETTER_AUTH_SECRET`/`POSTGRES_PASSWORD`, `APP_URL` = real https URL, `ALLOW_REGISTRATION=false`, cron for `scripts/backup.sh`.
5. Sandboxing for terminal/browser/SSH (disposable container per task) if those tools will be enabled on a shared host.
6. Nice-to-haves from §22: second model provider, MCP OAuth, activity export, scheduler catch-up.

---

## 24. Naming conventions

- Files: `kebab-case.ts(x)`; feature pages `<area>-page.tsx`; hooks `use-<thing>.ts`; tests `<thing>.test.ts` next to package `test/` dirs (web tests sit beside the source as `*.test.ts`).
- Packages: `@aiw/<name>`; exports through each package's `src/index.ts` only.
- Tool names: `<category>.<verb>` (`files.read`, `docker.logs`, `agent.delegate`); MCP tools are `mcp.<server-slug>.<tool>` via `qualifiedToolName`.
- Events: `SCREAMING_SNAKE` in `TASK_EVENT_TYPES`; DTO types end in `Dto`; Zod schemas end in `Schema`; env vars `SCREAMING_SNAKE`.
- DB: snake_case columns and table names, singular table names (`task`, `agent`), Drizzle exports plural (`tasks`, `agents`).
- Route folders mirror REST nouns; dynamic segments `[id]` in API routes, descriptive `[taskId]`/`[agentId]` in pages.

---

## 25. Code quality rules

- TypeScript strict with `noUncheckedIndexedAccess` — handle `undefined` from index access.
- ESLint must pass with **zero warnings**. The React Compiler rules are on: no synchronous `setState` in effects, no unused vars (prefix `_` to ignore).
- Comments explain *why* and cite the spec section where relevant (`(spec §27)`); avoid restating what the code does.
- No `console.log` in product code; `console.error/warn/info` are used for server diagnostics only.
- Every new behaviour gets a test in the owning package; integration tests run against the real test database, not mocks. The `ScriptedProvider` in `packages/agents/test/helpers.ts` drives deterministic agent runs.
- Never leave raw control bytes (NUL, 0x1F) in source — it has happened twice via shell-generated regexes; use explicit byte checks.
- When a shell one-liner would need `\n` escapes inside template literals, use the Edit tool instead; shells have turned `\n` into real newlines and broken files.

---

## 26. Dependencies policy

- Do not add a package without a clear need that existing code cannot meet. The whole platform uses ~35 direct deps.
- Pin exact versions in package.json (house style). Add to the owning package, not the root.
- Browser-safe code (`src/features`, `src/components`) may import only from `@aiw/shared` among workspace packages — importing `@aiw/tools`, `@aiw/database`, etc. pulls Node built-ins into the client bundle and Turbopack panics.

---

## 27. Performance / SEO

- The app is entirely behind auth; there is no public SEO surface. Pages set `metadata.title` only.
- SSE streams send heartbeats every 25 s and de-duplicate by event id; task snapshots refresh on state-changing events only (`LOCAL_ONLY_EVENTS` in `use-task-live.ts` lists the ones that do not).
- Tool output sent to the model is clipped (`MAX_TOOL_CONTENT_CHARS` 30k); stored tool output is capped at 100k; screenshots are pruned per task; frames in Redis expire after 60 s.
- Aggregates for Activity are single SQL queries with `count(*) filter (where …)`; keep new dashboard numbers in SQL, not in JS loops over rows.

---

## 28. Mobile / responsive

- Every page must work at ~390 px width with no horizontal scroll: wrap with `flex-wrap`, stack grids (`sm:grid-cols-2 lg:grid-cols-4`), `min-w-0` + `truncate` on text, wide tables inside `overflow-x-auto`.
- Bottom navigation on mobile (`MOBILE_NAV`), sidebar on `md+`.
- Browser/computer previews support full screen, zoom, collapse and activity-only mode (spec §39).
- UI verification scripts check for overflowing elements at 390 px; keep that at zero.

---

## 29. Recommended workflow for a change

1. Read this file. Then read the relevant package's `src/index.ts` and the feature folder you are touching.
2. Find the existing pattern for what you need (a similar route, form, hook, tool) and copy it rather than inventing a new one.
3. If the change touches shared code (`@aiw/shared` types, `TaskEventBus`, `decidePermission`, DTO mappers, `nav-config`), grep for every consumer first.
4. Schema change → `pnpm db:generate` → rename migration + journal tag → `pnpm db:migrate`. Built-in agent tool change → also a data migration.
5. New event type → `events.ts` + timeline icon (+ activity description if tool-originated) + `LOCAL_ONLY_EVENTS` decision.
6. New env var → `env.ts` → `.env.example` → README table → `docker-compose.prod.yml` if the container needs it.
7. Write or update tests in the owning package.
8. `pnpm check` must exit 0. Then verify the behaviour **live** — the codebase's history shows that several real bugs (lost projectId, hallucinated answers, stale placeholders, container startup crash) were only caught by running the real thing.
9. Update README (feature section, API table, env table) and **this file** if conventions, commands or important behaviour changed.
10. Report what changed and why; report failures plainly.

---

## 30. Rules for future Claude sessions

- **Read `CLAUDE.md` before doing any work.**
- **Understand the existing implementation before changing it.** Read the code path end to end; this codebase has non-obvious invariants (§21).
- **Prefer modifying existing components/functions to creating duplicates.** Search first.
- **Reuse existing patterns and dependencies.** The house pattern almost always exists already.
- **Avoid unnecessary package installation** and **unnecessary architecture changes.**
- **Never expose secrets or `.env` values** in output, logs, tests or commits.
- **Never remove working functionality without explicit permission.** Never mark something NOT IMPLEMENTED that works, and never leave NOT IMPLEMENTED on something that now works.
- **Never make large refactors unless explicitly requested.**
- **Check related files before changing shared components** (`@aiw/shared`, DTO mappers, the event bus, permissions, nav).
- **Run `pnpm check` after significant changes**, and verify live for behaviour changes. Do not claim a live verification you did not perform.
- **Explain what was changed and why**, including bugs found along the way.
- **Keep `CLAUDE.md` updated** whenever architecture, commands, conventions or important behaviour change. Also keep `README.md` in step — it is the user-facing document; this file is the developer contract.
- Work one scoped change at a time; do not build ahead of what was asked.
- Do not fake results. If a feature cannot be implemented, say so and label it.
