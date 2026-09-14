# AI Workspace

A self-hosted AI agent workspace: give the AI a task, watch it plan and work, approve sensitive actions, get the result.

The original product specification this was built from is kept verbatim in [docs/spec.md](docs/spec.md).

> **Current status: Phase 12 (Production).** Authentication, the database, the Gemini provider, streaming chat, configurable agents, automatic routing, the task runtime and live execution (SSE timeline, Pause / Resume / Stop / Continue / Retry) are implemented. Agents call real tools: workspace files, git, a terminal (disabled by default), web search, web page fetching, tools from **MCP servers** (Streamable HTTP, and stdio for administrators), a **real headless browser** (open, click, type, select, scroll) with a live preview and stored screenshots, and **computer use**: controlling the server's own screen, mouse and keyboard, with the screenshot sent to the model. Each agent gets the tools and permissions assigned to it, and **destructive actions pause the task until you approve or reject them**. Work can be grouped into **projects** with their own files and memory, and there is a **file browser** over the agent workspaces. **Schedules** run agents on their own — daily, weekly, monthly, on an interval, on a cron expression or once. A **Manager Agent** can **delegate** pieces of work to other agents, within limits on depth, count, time and budget. For production there are **Docker images, a Redis/BullMQ worker tier, health and readiness endpoints and backup scripts**. Their sections are labelled `NOT IMPLEMENTED` with the phase that delivers them. Until approvals exist (Phase 8), `DESTRUCTIVE` actions are always blocked.

## Architecture

### Agent tasks (Phase 2)

```
POST /api/tasks ──► TaskService ──► task row (queued) + user/assistant messages
                          │
                          ▼  InProcessTaskExecutor (background, outside the request)
                    AgentRuntime.execute(taskId)
                          │  claim (queued → planning)
                          ├─ route   : structured LLM choice among enabled agents (or manual)
                          ├─ model   : task override → agent model → provider default
                          ├─ plan    : structured steps (auto / always / never), plus a final step
                          ├─ steps   : one model call per step, earlier outputs as context
                          │            budget check · time limit · retry on 429/503 · stop signal
                          └─ finish  : task result/error, assistant message, usage totals
```

- Every transition is persisted **and** recorded as a typed event (see below).
- **Pause** sets a flag that the runtime checks at step boundaries: the current step finishes, then the task becomes `paused` without holding a worker. **Resume** re-queues it from the next step.
- **Continue** re-queues a failed or cancelled task and skips completed steps. **Retry** creates a new task linked by `retryOfTaskId`.
- On server start, `instrumentation.ts` marks tasks left running by a previous process as `interrupted` so they can be continued.
- Failures are stored as readable reports: what happened, which step, suggested next action, and a safe technical detail.

### Live execution (Phase 3)

```
AgentRuntime / TaskService
   │  TaskEventRecorder.emit(type, …)  ──►  task_event row (bigserial id)
   │                                   └─► TaskEventBus.publish  (in-memory, or Redis pub/sub in queue mode)
   │  step output chunks ──────────────────► bus only (ephemeral "delta")
   ▼
GET /api/tasks/:id/events  (Accept: text/event-stream)
   subscribe → replay rows after Last-Event-ID → flush buffered → live → "end"
   ▼
EventSource in the browser → timeline, status line, live output, snapshot refresh
```

- Event types: `TASK_CREATED`, `AGENT_SELECTED`, `AGENT_STARTED`, `THINKING_STATUS`, `PLAN_CREATED`, `STEP_STARTED`, `STEP_COMPLETED`, `STEP_FAILED`, `TASK_PROGRESS`, `MODEL_CALL_FINISHED`, `TASK_PAUSE_REQUESTED`, `TASK_PAUSED`, `TASK_RESUMED`, `TASK_COMPLETED`, `TASK_FAILED`, `TASK_CANCELLED`. Tool events (Phases 4–5): `TOOL_CALL_STARTED`, `TOOL_CALL_FINISHED`, `FILE_READ`, `FILE_CREATED`, `FILE_UPDATED`, `TERMINAL_COMMAND_STARTED`, `TERMINAL_COMMAND_FINISHED`, `PAGE_READ`, `MCP_TOOL_STARTED`, `MCP_TOOL_FINISHED`, `BROWSER_OPENED`, `PAGE_NAVIGATED`, `BROWSER_ACTION`, `BROWSER_SCREENSHOT`, `BROWSER_CLOSED`, `COMPUTER_STARTED`, `COMPUTER_ACTION`, `COMPUTER_SCREENSHOT`, `COMPUTER_STOPPED`, `APPROVAL_REQUIRED`, `APPROVAL_GRANTED`, `APPROVAL_REJECTED`. Each carries a timestamp, agent, human-readable description, status, duration and typed data (`packages/shared/src/events.ts`). All event types are implemented.
- Streams resume without gaps or duplicates via `Last-Event-ID`, send a heartbeat every 15 s, and close with `event: end` when the task completes, fails, is cancelled or pauses.
- The **Activity** page is the workspace-wide dashboard (see below). The task page offers **Overview** (plan, live output, result), **Activity** (timeline) and **Logs** (model calls and raw events). **Tools**, **Browser**, **Computer**, **Terminal** and **Files** tabs appear when the task used them.

### Tools (Phase 4)

```
step model call (tools declared) ──► tool call(s) ──► AgentRuntime.executeToolCall
   │    ├─ assigned to the agent?          no → denied (not_found)
   │    ├─ Zod input validation            bad → failed (invalid_input)
   │    ├─ permission decision             READ auto · WRITE/EXECUTE/NETWORK need a grant · DESTRUCTIVE blocked
   │    ├─ run with timeout + task abort signal, inside the user's workspace
   │    └─ tool_call row · TOOL_CALL_* / FILE_* / TERMINAL_* / PAGE_READ events · live terminal deltas
   └─◄ results (and Gemini thought signatures) fed back until the model answers or the tool-call limit is hit
```

| Tool | Permission | Notes |
| --- | --- | --- |
| `files.list`, `files.read`, `files.search` | READ | Relative paths only. Traversal, absolute paths and symlinks that escape are rejected |
| `files.write`, `files.edit` | WRITE | Exact-match edits; size caps |
| `files.delete` | DESTRUCTIVE | Always blocked until Phase 8 |
| `git.status`, `git.diff`, `git.log` | READ | Hooks, fsmonitor, pager and the `file://` protocol are disabled |
| `git.init`, `git.add`, `git.commit` | WRITE | |
| `terminal.run` | EXECUTE | `{program, args}` with no shell. Allowlisted programs only, timeout, output cap, env stripped of secrets. Destructive patterns (`rm`, `git push --force`, `docker rm`, …) are classified DESTRUCTIVE and blocked |
| `web.search` | NETWORK | Gemini Google Search grounding (default) or SearXNG |
| `web.fetch` | NETWORK | http/https only, private/loopback/link-local addresses refused at the socket and on every redirect, size and time caps, readable-text extraction |

- Every user gets a workspace at `WORKSPACE_ROOT/users/<userId>`. Built-in agents come with sensible default tools and grants, and the agent editor controls tools, permissions and the per-task tool-call limit (`GET /api/tools` lists the tools and whether each is available).
- Later steps receive a list of tool actions already performed, and of calls that were denied, so they neither repeat work nor retry blocked actions.
- **The terminal is not a sandbox.** Commands run as the server's OS user, and the allowlist plus `shell: false` are the only guard. Leave `TERMINAL_ENABLED=false` unless the host is disposable or isolated. In the production stack it runs inside the worker container, which limits the blast radius to that container but is still not a sandbox.

### MCP (Phase 5)

```
/mcp UI ──► /api/mcp (CRUD, refresh, per-tool settings) ──► mcp_server / mcp_tool rows (secrets AES-256-GCM)
                              │ refresh
                              ▼
                McpConnectionManager (one client per server, @modelcontextprotocol/client 2.0)
                  ├─ stdio  : command + args, env = safe defaults + configured vars, cwd = owner workspace
                  └─ http   : Streamable HTTP through the SSRF-guarded fetch, configured headers
                              │ tools/list (paginated) → names, schemas, annotations → default permission
AgentRuntime ◄── McpToolSource.toolsForUser(userId) ── tools as `<prefix>.<tool>` (e.g. github.search_repositories)
   └─ same checks as built-in tools (assignment, permission, timeout, abort) → tools/call → MCP_TOOL_* events
```

- **Servers are per user.** Each has a tool name prefix (immutable), transport, URL or command, encrypted headers or environment variables, a per-call timeout and an enabled switch. Adding a server tests the connection and discovers its tools; **Test and refresh tools** repeats that. Tools that disappear are removed and unassigned from agents; deleting a server unassigns all its tools.
- **Permissions per tool.** The default level comes from the server's annotations: `destructiveHint` → DESTRUCTIVE (blocked), `readOnlyHint` → READ, anything else → EXECUTE. Annotations are hints from the server, so each tool's level can be overridden and each tool can be disabled. Agents still need each tool assigned, plus the grant for its level.
- **stdio servers run a command on the host** without a sandbox. They are disabled unless `MCP_STDIO_ENABLED=true`, and even then only administrators can add or change them. The process gets only safe default variables (PATH, HOME, …) plus its configured variables, never this app's secrets. It starts in the owner's workspace and exits when the app exits.
- **http servers** go through the same SSRF protection as `web.fetch`: loopback, private and metadata addresses are refused unless `MCP_ALLOW_PRIVATE_NETWORK=true`.
- **Secrets** (header and env values) are encrypted with AES-256-GCM using a key derived from `BETTER_AUTH_SECRET`, are write-only in the API and UI, and never appear in audit logs. Rotating `BETTER_AUTH_SECRET` makes them unreadable; re-enter them.
- Tool results: text and text resources go to the model; images, audio and binary resources are recorded by size but **not** sent to the model. Tool errors (`isError`) are reported to the model as failures. Descriptions and results are marked as external data in the system prompt.
- Connections are opened lazily, reused across tasks, reconnected when the configuration changes, and closed after 5 idle minutes. Connection tests are rate limited (10 per minute per user).
- **NOT IMPLEMENTED:** OAuth sign-in for MCP servers (use header tokens), MCP prompts, resources and sampling, the legacy HTTP+SSE transport, and live `tools/list_changed` updates (use refresh).

### Browser agent (Phase 6)

```
browser.open / click / type / select / press / scroll / back / snapshot / screenshot / close
   │  BrowserManager: one headless Chromium (Playwright), one isolated context per task
   │    ├─ all traffic through a local egress proxy with the SSRF-safe DNS lookup (no loopback/private/metadata, also via redirects and subresources)
   │    ├─ page snapshot: numbered interactive elements + readable text → the model acts by element number (Browser Use style)
   │    ├─ after every action: PAGE_NAVIGATED / BROWSER_ACTION events, a JPEG screenshot stored in `screenshot` (BROWSER_SCREENSHOT event)
   │    └─ CDP screencast → in-memory latest frame → `event: browser` on the task stream → GET /api/tasks/:id/browser/frame
   └─ session closes when the task ends, is stopped, times out, or after 10 idle minutes
```

- The **Browser Agent** is assigned the browser tools by default (NETWORK for opening pages, EXECUTE for clicking, typing and selecting). Any agent can be given them.
- The task page's **Browser** tab and the chat card show the live preview with the URL, the current action, zoom, full screen, collapse (activity-only) and a strip of stored screenshots. The model never sees images; it works from the element list and page text.
- Dialogs are dismissed automatically, downloads and file uploads are refused, and up to 60 screenshots are kept per task (older ones are pruned).
- Chromium comes from Playwright (`pnpm exec playwright-core install chromium`) or an installed Chrome/Edge via `BROWSER_CHANNEL`. Set `BROWSER_ENABLED=false` to remove the tools.
- **NOT IMPLEMENTED:** persistent logins/cookies across tasks, file uploads and downloads, multi-tab control (the newest tab is followed), and a sandboxed browser container (the production worker image contains the browser, but pages are not isolated from each other beyond a fresh context per task).

### Computer use (Phase 7)

```
computer.start / screenshot / click / move / drag / scroll / type / key / wait / stop
   │  ComputerManager: ONE task controls the desktop at a time (there is only one real screen)
   │    └─ platform driver
   │         ├─ Windows: a long-lived PowerShell process (.NET capture + SendKeys, user32 for buttons)
   │         └─ Linux (X11, untested here): xdotool + ImageMagick `import`
   │  every action → screenshot → stored in `screenshot` (source "computer") + live frame + COMPUTER_* events
   └─◄ the screenshot goes back to the model AS AN IMAGE, so it can see the screen and act by pixel coordinates
```

- **The model sees the screen.** Tool results may carry images; the Gemini provider nests them inside the function response. Coordinates are screenshot pixels (screens are scaled down to `COMPUTER_MAX_WIDTH`), mapped back to real screen pixels by the session.
- The **Computer Use Agent** gets these tools by default with the EXECUTE grant. Its prompt tells it to look, act in small steps, and stop and ask before anything destructive.
- The task page's **Computer** tab and the chat card show the live desktop with the current action, zoom, full screen, collapse (activity-only) and the screenshot history.
- **This is the server's real desktop, not a sandbox.** It is off unless `COMPUTER_USE_ENABLED=true`; anything visible on screen is captured into screenshots and sent to the model. Only enable it on a machine you are willing to hand to the agent.
- **NOT IMPLEMENTED:** a virtual/second display, per-user desktops, the Windows/Super key (SendKeys cannot send it), file drag-and-drop from outside, and approval gating for risky desktop actions (Phase 8).

### Human approval (Phase 8)

```
tool call → permission engine
   ├─ READ                         → runs
   ├─ WRITE / EXECUTE / NETWORK    → runs when the agent was granted it, otherwise denied
   └─ DESTRUCTIVE                  → approval_request row · task status "waiting_for_approval" · APPROVAL_REQUIRED
                                      │
             Reject ────────────────┼──→ the agent is told why, and continues without the action
             Approve once ──────────┤    the call runs; later calls ask again
             Approve for this task ─┘    the call runs, and that tool stops asking for the rest of the task
```

- A waiting task keeps its place: it blocks on the decision, reports `waiting_for_approval`, and resumes the moment you choose. No decision within `APPROVAL_TIMEOUT_MINUTES` refuses the action; stopping the task cancels the request.
- The prompt shows the agent, the tool, the action (for example `rm -rf build`), the permission level and the full arguments, with **Reject / Approve once / Approve for this task** (spec §17). It appears both in the chat card and on the task page.
- DESTRUCTIVE is never granted in advance: the agent editor shows it as "asks you" rather than a permission you can switch on. Permissions the agent was not granted stay denied without prompting, because that is a configuration choice you already made.
- Every decision is written to the audit log with the tool, the action and the scope, and a request can only be decided once.

### Projects, files and memory (Phase 9)

```
project ──► conversations + tasks (task.projectId)
   ├─ files   : WORKSPACE_ROOT/users/<user>/projects/<project>/…  (agents in the project work here)
   └─ memory  : short "key: value" facts, injected into the agent's system prompt
                 scopes: project (shared) · agent (follows the agent) · conversation
                 written by you in the UI, or by the agent with memory.remember / memory.forget
```

- **Projects** group conversations, tasks, files and memory (spec §23). Pick one in the composer, or open a project and start a task from there; a new conversation inherits it. Projects can be archived, and deleting one keeps its conversations and tasks but removes its memory.
- **Files** (spec §24): every project has its own folder inside the user's workspace, so project work stays together and personal work stays separate. The Files page browses either, with preview, download, upload and delete. Every path goes through the same workspace guard as the agent tools, so traversal, absolute paths and symlinks that escape are refused.
- **Memory** (spec §25) is structured and inspectable, never a transcript: short keys and values you can read, edit and delete, plus `memory.remember`, `memory.list` and `memory.forget` for agents. What an agent remembers for the project and for itself is put into its system prompt, so a later task uses it without being told again.
- **NOT IMPLEMENTED:** project members and sharing (the tables exist, but everything is owner-only), folder creation and rename in the browser, file search, and automatic memory extraction from conversations.

### Scheduler (Phase 10)

```
schedule (trigger + timezone) ──► ticker every 30 s ──► claim (conditional update on next_run_at)
                                                          ├─ TaskService.createTask → a normal task
                                                          ├─ schedule_run row: started | skipped | failed
                                                          └─ next_run_at recomputed from the time it was DUE
```

- **Triggers:** `daily`, `weekly`, `monthly`, `interval`, `cron` (five fields) and `once`. Calendar triggers are resolved in the schedule's own IANA timezone, so 08:00 stays 08:00 across a daylight-saving change, and a monthly schedule on day 31 falls back to the last day of shorter months.
- Each schedule names the task, optionally an agent (otherwise routing picks one), a project and a model override. A run starts an ordinary task, so it appears in Tasks with its full timeline.
- **Execution history** per schedule: every firing is recorded, including ones that were skipped because you were at your task limit, with the reason.
- The next run is computed from the time the run was **due**, not from when the ticker noticed, so a slow tick does not drift. Claiming is a conditional update, so two tickers cannot double-fire one schedule. A trigger that stops being usable disables the schedule and records why.
- **Run now** starts the task immediately without changing the next scheduled run.
- **NOT IMPLEMENTED:** catch-up for runs missed while the server was down (a missed occurrence is skipped, and the schedule resumes at its next one), per-schedule retries, and notifications.

### Multi-agent delegation (Phase 11)

```
Manager Agent task (depth 0)
   │  agent.delegate { agent: "research", task: "…" }
   ▼
child task row (parent_task_id, depth 1) ──► the SAME AgentRuntime.execute
   │                                            ├─ the sub-agent's own tools, permissions and approvals
   │                                            ├─ its own plan, timeline, tool calls and usage rows
   │                                            └─ the parent's stop signal and time limit
   ▼
result text returned to the manager as the tool result
```

- **A sub-task is a real task.** It is claimed, planned, executed, recorded and billed like any other: you can open it, read its timeline and see what it cost. Nothing about delegation is simulated.
- **The sub-agent starts fresh.** It never sees the parent conversation, only the instruction it was given, so the manager has to say what it needs.
- **Four limits keep delegation bounded** (spec §28): `MAX_DELEGATION_DEPTH` (default 1, so helpers cannot delegate again), `MAX_DELEGATIONS_PER_TASK` (default 5), `MAX_SUBTASK_SECONDS` (default 600) on top of each agent's own `maxExecutionSeconds`, `maxToolCalls` and `dailyBudgetUsd`. A refused delegation is reported to the manager as a failed tool call, not as a crash.
- **A failed sub-task does not fail the parent.** The manager is told plainly what went wrong and decides what to do next.
- The task page gains a **Team** tab listing every delegated task with its result, tokens and cost, and a delegated task links back to the task that started it.
- **NOT IMPLEMENTED:** agents talking to each other while both run (a delegation is one request and one answer), delegating to an agent owned by another user, and running sub-tasks in parallel — the manager waits for each one.

### Chat and providers

```
Browser (Next.js client)
   │  fetch + SSE (POST /api/chat streams typed events)
   ▼
Next.js route handlers ── Better Auth (sessions, rate limits)
   │
   ├── chat service ── ProviderRegistry ── GeminiProvider ──► Gemini API
   │
   └── repositories (Drizzle) ──► PostgreSQL
```

- The browser never talks to a model provider. API keys stay on the server.
- A chat turn is **prepared** first (validation, ownership, provider/model resolution, persistence of the user message and an assistant placeholder). Only then is it **executed**, streaming typed events: `start → delta* → done | error`.
- Generation is decoupled from the HTTP reader. If the client disconnects or presses Stop, the provider call is aborted and the partial reply is still saved as `cancelled`.
- Every model call writes a `usage_log` row (tokens, estimated cost, duration, status).

### Autonomous mode (spec §27)

- Per agent: **Run unattended** plus a list of **trusted actions**. A trusted DESTRUCTIVE tool runs without stopping for approval; everything else still waits for you.
- **A floor that cannot be lowered:** `terminal.run` and `ssh.run` always ask, whatever is trusted, because an arbitrary command is how a deployment, a destructive change or a read of a secret would actually happen. The floor is enforced in the permission engine (`NEVER_AUTONOMOUS` in `@aiw/shared`), not in the UI, so no configuration can bypass it.
- Every unattended action is recorded as an `AUTONOMOUS_ACTION` timeline event and an `agent.autonomous_action` audit-log row, so you can see afterwards exactly what ran without asking.
- Off for every agent by default.

### Infrastructure tools (spec §15)

| Tools | What | Switch |
| --- | --- | --- |
| `docker.ps` `logs` `stats` `inspect` `restart` `stop` `remove` | The real `docker` CLI on this host; `stop` and `remove` are DESTRUCTIVE | `DOCKER_TOOLS_ENABLED` |
| `ssh.run` | A command on a host you named in `SSH_HOSTS`; the agent picks by name and can never invent a destination; commands are classified like `terminal.run` | `SSH_TOOLS_ENABLED` |
| `github.search_repositories` `list_issues` `read_issue` | Read-only GitHub REST calls; `GITHUB_TOKEN` raises the rate limit | always on |

Docker and SSH are assigned to the DevOps Agent, GitHub to the Coding and Research Agents. Container names are validated as plain identifiers rather than interpolated, and SSH uses this server's own keys or agent — nothing is stored by the app.

### Attachments (spec §3)

- The composer's paperclip uploads files into the workspace on local disk (`chat-uploads/`); the message carries only a reference the server re-reads through the workspace guard, so a crafted path cannot escape.
- In **chat**, images (PNG/JPEG/WebP) are sent to the model as pictures and other files are read as text; binary files are reported as unreadable rather than sent as rubbish. In a **task**, the prompt lists the files' workspace paths so the agent can read them with its own tools.
- Attachments are stored on the message and shown as chips in the conversation.

### Files page (spec §24)

Upload, view, **search by name** (recursive, skipping hidden and dependency folders, capped so a huge workspace cannot stall the request), **create** a new text file, download and delete. Agents work in the same folders with their file tools.

### Asking the agent to fix a failure (spec §40)

On a failed task, **Ask agent to fix** re-runs from the first unfinished step with the previous failure written into that step's prompt, so the agent works out why it failed rather than repeating the attempt blind. Retry starts a fresh task; Stop ends it.

### Activity dashboard

```
tasks + tool_call + usage_log ──► GET /api/activity?range=24h|7d|30d|all  (aggregates)
task_event ──► TaskEventBus per-user channel ──► GET /api/activity/events (SSE, live)
```

- Tasks, success rate, agents used, average run time, estimated cost, tool calls and failures for the chosen window, plus breakdowns **by agent, by model, by tool** and **by error**, and a tasks-per-day bar.
- Every number is a `SELECT` over rows the runtime already wrote. Nothing is sampled or synthesised; a figure with no data shows as `—` rather than zero.
- The **live event stream** uses a per-user channel on the event bus, so it works whether tasks run in this process or in the worker tier, and one user can never receive another's events. It also re-reads the totals when a task finishes, instead of polling.
- **NOT IMPLEMENTED:** exporting the figures (CSV/Prometheus), per-project filtering, and retention/rollups — every event and usage row is kept forever.

### Production: the worker tier (Phase 12)

```
                    REDIS_URL unset                     REDIS_URL set
                    ──────────────                      ─────────────
POST /api/tasks ──► InProcessTaskExecutor          ──► QueueTaskExecutor ──► BullMQ ──► worker
                    runs the task here                  web tier only enqueues        runs the task
                    InMemoryTaskEventBus                RedisTaskEventBus ◄── events published by the worker
                    SSE reads it directly               SSE reads it over Redis pub/sub
```

- **One process or two, same code.** `@aiw/runtime` is the single composition root: env, providers, tools, browser, computer, MCP, agent services. The web server and `apps/worker` both build from it, so an agent behaves identically either way. Without `REDIS_URL` everything runs in the web process — that is the supported single-server setup, not a degraded mode.
- **The web tier stops doing long work.** It enqueues, and a deploy of the web tier no longer kills running tasks.
- **Stop, pause and resume cross the process boundary.** `executor.stop()` asks Redis whether the task is actually running (the worker holds a heartbeat key) and publishes a stop signal to the worker holding it; when nothing is running the web tier records the cancellation itself, exactly as before.
- **Live previews follow the work.** The browser and desktop run in the worker, so it copies the newest preview frame to Redis with a short TTL and the web tier serves it from there. Stored screenshots stay in Postgres.
- **Graceful shutdown.** On SIGTERM the worker stops taking jobs and aborts what it is running, so tasks record themselves as cancelled instead of being killed mid-step; anything still unfinished is marked interrupted on the next start.
- **Exactly one scheduler.** In queue mode the worker fires schedules; otherwise the web server does. `RUN_SCHEDULER=false` turns it off on extra replicas. Claiming a due schedule is atomic, so a mistake here cannot double-fire.
- **Monitoring:** `GET /api/health` reports the database and queue (503 when either is unreachable) and backs the container healthcheck; `GET /api/ready` adds queue depth (waiting/active/delayed/failed) for an orchestrator.
- **Backups:** `scripts/backup.sh` writes a `pg_dump` custom-format dump plus a tar of the agent workspaces, keeping the newest `BACKUP_KEEP` (14) of each; `scripts/restore.sh` restores one and refuses to run without typed confirmation.
- **NOT IMPLEMENTED:** container sandboxing for `terminal.run` and the browser (both still run as the process user, now inside the worker container), horizontal scaling beyond several workers on one Redis, log shipping and metrics export (logs go to stdout for the platform to collect), and automatic backup scheduling (run `scripts/backup.sh` from cron or your platforms scheduler).

## Deployment

```bash
# On the VPS, with Docker installed and the repository cloned:
cp .env.example .env               # set APP_URL, BETTER_AUTH_SECRET, POSTGRES_PASSWORD, GEMINI_API_KEY
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec worker pnpm --filter @aiw/database db:migrate
```

The migrate command runs from the **worker** image, which carries the database package and pnpm; the web image is a slim bundle without them. Run it after every deploy that adds a migration.

The stack listens on port `3000` over plain HTTP. Put a TLS reverse proxy in front and set `APP_URL` to the https address, or sign-in will refuse the origin. With Caddy on the host:

```
workspace.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews the certificate itself. Keep `WEB_PORT` bound to localhost in that case by setting `WEB_PORT=127.0.0.1:3000`.

The stack is Postgres, Redis, `web` and `worker`. The two app images share a volume for the agent workspaces, because the worker writes the files the web tier browses. The worker image is built on Playwrights so the browser agent has a real Chromium, which makes it much larger than the web image; `COMPUTER_USE_ENABLED` is forced off there, since a container has no desktop.

**Coolify:** point a new resource at this repository, choose *Docker Compose* with `docker-compose.prod.yml`, and set the environment variables above in Coolifys UI (it substitutes them into the file). Coolify terminates TLS and provides the domain — set `APP_URL` to that https URL so secure cookies and CSRF origin checks line up. Scale by raising `WORKER_CONCURRENCY` or adding worker replicas; keep exactly one with `RUN_SCHEDULER=true`.

## Repository layout

```
apps/
  web/                    Next.js 16 app (UI + API route handlers)
    src/app/              routes: (auth) sign-in/up, (workspace) chat, settings, …
    src/features/         chat, conversations, auth UI
    src/components/       shell (sidebar, mobile nav), ui (shadcn/ui)
    src/server/           env, auth, http helpers, rate limiting, chat service
packages/
  shared/                 Zod schemas, typed stream events, SSE framing
  database/               Drizzle schema, migrations, repositories, test helpers
  ai/                     ModelProvider interface, ProviderRegistry, GeminiProvider, pricing, JSON output
  agents/                 built-in agents, router, planner, AgentRuntime (tool loop), executor, TaskService, events/bus, SSE stream, recovery
  tools/                  ToolRegistry, permissions, Workspace path guard, process runner, safe fetch, built-in tools
  mcp/                    MCP connection manager, discovery, tool source, result conversion, secret encryption
  browser/                Playwright browser manager, egress proxy, page snapshots, browser tools
  computer/               desktop drivers (Windows PowerShell, Linux xdotool), session manager, computer tools
  scheduler/              trigger maths (timezone aware), the ticker that fires due schedules
  queue/                  BullMQ executor, Redis event bus, worker consumer, live-frame handoff
  runtime/                the composition root shared by the web server and the worker
apps/worker/              the worker tier: consumes the queue, runs agents, fires schedules
Dockerfile                web image (Next.js standalone)
Dockerfile.worker         worker image (Playwright base, for the browser agent)
docker-compose.yml        PostgreSQL and Redis for development (+ aiw_test database)
docker-compose.prod.yml   production stack: postgres, redis, web, worker
docs/spec.md              the original 46-section product specification, verbatim
scripts/backup.sh         database + workspace backups, with retention
scripts/restore.sh        restores a backup into a database
```

## Prerequisites

- Node.js 22+
- pnpm 10 (`corepack enable`)
- Docker (for PostgreSQL), or your own PostgreSQL 15+

## Getting started

```bash
pnpm install
cp .env.example .env               # then fill in BETTER_AUTH_SECRET and GEMINI_API_KEY
docker compose up -d postgres
pnpm db:migrate
pnpm dev                           # http://localhost:3000
```

Open the app and create an account. **The first account becomes the administrator**, and registration then closes unless `ALLOW_REGISTRATION=true`.

Production mode:

```bash
pnpm build
pnpm start
```

## Environment variables

All variables live in the root `.env`. Real environment variables take precedence.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `APP_URL` | yes | — | Public URL of the app. Used for CSRF origin checks; `https://` enables Secure cookies and HSTS |
| `BETTER_AUTH_SECRET` | yes | — | ≥ 32 characters. Generate with `openssl rand -base64 48` |
| `GEMINI_API_KEY` | for chat | — | Google Gemini API key. Chat is disabled (with a clear notice) until set |
| `GEMINI_DEFAULT_MODEL` | no | `gemini-2.5-flash` | Default model |
| `GEMINI_MODELS` | no | all text models | Comma-separated allowlist for the model picker (checked against the live Gemini models API) |
| `ROUTER_MODEL` | no | `GEMINI_DEFAULT_MODEL` | Model used by the automatic agent router |
| `MAX_RUNNING_TASKS_PER_USER` | no | `3` | Concurrent agent tasks allowed per user |
| `ALLOW_REGISTRATION` | no | `false` | Allow sign-ups after the first (admin) account |
| `CHAT_RATE_LIMIT_PER_MINUTE` | no | `20` | Per-user chat request limit |
| `WORKSPACE_ROOT` | no | `./data/workspaces` | Base directory for per-user tool workspaces (relative to the repo root) |
| `TERMINAL_ENABLED` | no | `false` | Enable `terminal.run`. Not a sandbox, see Tools |
| `TERMINAL_ALLOWED_COMMANDS` | no | `ls,cat,echo,pwd,grep,find,wc,head,tail,du,df,git,node,npm,python3` | Programs `terminal.run` may start |
| `TERMINAL_TIMEOUT_SECONDS` | no | `60` | Default and maximum command time |
| `WEB_SEARCH_PROVIDER` | no | `gemini` | `gemini` (Google Search grounding), `searxng`, or `none` |
| `WEB_SEARCH_MODEL` | no | `gemini-2.5-flash-lite` | Model used for grounded search (needs grounding quota on your key) |
| `SEARXNG_URL` | for searxng | — | SearXNG base URL (JSON format enabled) |
| `WEB_FETCH_ALLOW_PRIVATE_NETWORK` | no | `false` | Allow `web.fetch` to reach private/loopback addresses |
| `APPROVAL_TIMEOUT_MINUTES` | no | `30` | How long a destructive action waits for your decision before it is refused |
| `COMPUTER_USE_ENABLED` | no | `false` | Let agents control this machine's screen, mouse and keyboard. Not a sandbox |
| `COMPUTER_MAX_WIDTH` | no | `1280` | Width screenshots are scaled to before the model sees them |
| `BROWSER_ENABLED` | no | `true` | Offer the browser tools |
| `BROWSER_CHANNEL` | no | — | `chrome` or `msedge` to use an installed browser instead of Playwright's Chromium |
| `BROWSER_EXECUTABLE_PATH` | no | — | Explicit Chromium-based executable |
| `BROWSER_MAX_SESSIONS` | no | `3` | Concurrent browser sessions (one per running task) |
| `BROWSER_ALLOW_PRIVATE_NETWORK` | no | `false` | Allow the agent browser to open loopback/private addresses |
| `MCP_STDIO_ENABLED` | no | `false` | Allow stdio MCP servers (administrators only). Not a sandbox |
| `MCP_ALLOW_PRIVATE_NETWORK` | no | `false` | Allow http MCP servers on loopback/private addresses |
| `DOCKER_TOOLS_ENABLED` | no | `false` | Offer the `docker.*` tools (runs the docker CLI on this host) |
| `DOCKER_TIMEOUT_SECONDS` | no | `60` | Ceiling for one docker command |
| `SSH_TOOLS_ENABLED` | no | `false` | Offer `ssh.run` |
| `SSH_HOSTS` | for ssh | — | `name=user@host:port`, comma separated; the only destinations an agent can reach |
| `SSH_TIMEOUT_SECONDS` | no | `60` | Ceiling for one remote command |
| `GITHUB_TOKEN` | no | — | Token for the `github.*` tools; without it GitHub rate-limits quickly |
| `GITHUB_API_URL` | no | `https://api.github.com` | For GitHub Enterprise |
| `DELEGATION_ENABLED` | no | `true` | Offer the `agent.delegate` tool at all |
| `MAX_DELEGATION_DEPTH` | no | `1` | How many levels deep delegation may go (0 disables it in practice) |
| `MAX_DELEGATIONS_PER_TASK` | no | `5` | Sub-tasks one task may start |
| `MAX_SUBTASK_SECONDS` | no | `600` | Ceiling for one delegated sub-task |
| `REDIS_URL` | no | — | Set it to run tasks in a separate worker tier; unset keeps everything in one process |
| `WORKER_CONCURRENCY` | no | `3` | Tasks one worker process runs at once |
| `RUN_SCHEDULER` | no | `true` | Whether this process fires schedules; exactly one should |
| `TEST_DATABASE_URL` | no | `postgres://aiw:aiw@localhost:5432/aiw_test` | Database reset by integration tests (name must end in `_test`) |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm build` / `pnpm start` | Production build / server |
| `pnpm typecheck` | `tsc --noEmit` in every package (web runs `next typegen` first) |
| `pnpm lint` | ESLint (zero warnings allowed) |
| `pnpm test` | Unit + integration tests (needs PostgreSQL running) |
| `pnpm check` | typecheck → lint → test → build |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Drizzle Studio |

The live Gemini smoke test (`packages/ai/test/gemini.test.ts`) runs only when `GEMINI_API_KEY` is set in the test environment.

## API

| Method | Path | Description |
| --- | --- | --- |
| `*` | `/api/auth/*` | Better Auth: sign-up, sign-in, sign-out, session |
| `POST` | `/api/chat` | `{action:"send", content, conversationId?, model?}` or `{action:"retry", conversationId, model?}` → SSE stream |
| `GET` | `/api/conversations?q=&archived=` | List/search (titles and message content) |
| `GET` | `/api/conversations/:id` | Conversation with messages |
| `PATCH` | `/api/conversations/:id` | `{title?, pinned?, archived?}` |
| `DELETE` | `/api/conversations/:id` | Delete (audit logged) |
| `GET` | `/api/models` | Provider status and selectable models |
| `GET` `POST` | `/api/agents` | List agents (built-ins are created on first access) / create a custom agent |
| `GET` `PATCH` `DELETE` | `/api/agents/:id` | Read / update / delete (built-in agents can only be disabled) |
| `GET` | `/api/activity` | Dashboard aggregates for a time range |
| `GET` | `/api/files/search` | Files whose name contains a query, anywhere in the workspace |
| `POST` | `/api/files/create` | A new empty text file; never overwrites |
| `GET` | `/api/executions` | Execution history: every task run with its origin (user, delegated, retry) |
| `GET` | `/api/activity/events` | SSE feed of every event across your tasks |
| `GET` | `/api/tasks?status=all\|active\|completed\|failed\|cancelled` | Task history with progress and usage |
| `POST` | `/api/tasks` | `{prompt, agentId?, conversationId?, model?}` → 202; auto-routed when `agentId` is omitted |
| `GET` | `/api/tasks/:id` | Task with plan steps, routing decision, result or error |
| `GET` | `/api/tasks/:id/events` | SSE stream with `Accept: text/event-stream` (resumes after `Last-Event-ID` / `?after=`); otherwise JSON `{ events }` |
| `GET` | `/api/tasks/:id/screenshots/:screenshotId` | Stored browser screenshot (JPEG, owner only) |
| `GET` | `/api/tasks/:id/browser/frame` | Latest live browser frame (JPEG) or 204 |
| `GET` | `/api/tasks/:id/computer/frame` | Latest live desktop frame (JPEG) or 204 |
| `GET` | `/api/approvals` | Pending approval requests |
| `GET` `POST` | `/api/projects` | List or create projects |
| `GET` `PATCH` `DELETE` | `/api/projects/:id` | Read, rename/archive, or delete |
| `GET` | `/api/files?path=&projectId=` | One folder of a workspace |
| `GET` | `/api/files/content?path=&projectId=&download=` | File text, or the bytes as a download |
| `POST` | `/api/files/upload` | Multipart upload into a workspace folder |
| `POST` | `/api/files/delete?path=&projectId=` | Remove one file |
| `GET` `POST` | `/api/memory` | List memories, or store one (`{scope, key, value, …}`) |
| `GET` `POST` | `/api/schedules` | List or create schedules |
| `GET` `PATCH` `DELETE` | `/api/schedules/:id` | Schedule with its runs, update (recomputes the next run), or delete |
| `POST` | `/api/schedules/:id/run` | Run it now, without changing the schedule |
| `PATCH` `DELETE` | `/api/memory/:id` | Edit or forget one |
| `POST` | `/api/approvals/:id/approve` | `{scope: "once" | "task"}` |
| `POST` | `/api/approvals/:id/reject` | `{reason?}` |
| `POST` | `/api/tasks/:id/pause` \| `/resume` \| `/stop` \| `/continue` \| `/retry` | Task control |
| `GET` | `/api/tools` | Built-in and the user's MCP tools with category, permission and availability |
| `GET` `POST` | `/api/mcp` | List MCP servers and server capabilities / add a server (tests the connection and discovers tools) |
| `GET` `PATCH` `DELETE` | `/api/mcp/:id` | Server with its tools (secret values never returned) / update (write-only secrets: value replaces, `null` removes) / delete |
| `POST` | `/api/mcp/:id/refresh` | Test the connection and re-discover tools |
| `PATCH` | `/api/mcp/:id/tools/:toolId` | `{enabled?, permission?}` (`null` = use the default level) |
| `GET` | `/api/health` | Liveness and database connectivity |

Errors always use `{ "error": { "code", "message", "details?" } }`. Internal error details are never returned to clients.

## Security measures

- Database-backed sessions with HttpOnly, SameSite=Lax cookies (Secure over HTTPS). Passwords are hashed by Better Auth (scrypt).
- First user is admin; registration is closed by default; the `role` field cannot be set by clients.
- Rate limits: sign-in 5/min, sign-up 5/hour, auth API 100/min, chat configurable per user.
- CSRF: `Origin` / `Sec-Fetch-Site` checks on every mutating API route, plus Better Auth's trusted-origin checks.
- Zod validation on every request body and query; 256 KB JSON body cap; UUID validation on ids.
- Every query is scoped to the owner, and cross-user access returns 404.
- Security headers: CSP, `frame-ancestors 'none'`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP, and HSTS over HTTPS.
- Model ids are validated against the provider's live model list.
- Markdown is rendered without raw HTML; external images are rendered as links.
- Audit log for user creation, sign-in sessions, conversation deletion, agent changes and task control actions.
- Agent execution limits: per-agent time limit, maximum plan steps, daily budget (estimated cost), per-user running-task limit, and a routing time limit.
- Model ids for agents and task overrides are validated against the provider's live model list.
- Built-in agents are seeded once per user and never rewritten, so when a built-in agent's default tools change, a data migration appends the new names to existing rows (see `0013_builtin_agent_tools.sql`). Without that, an agent silently lacks the tool and answers from memory instead.
- Delegation (Phase 11): a sub-task runs as the same user with the sub-agent's own permissions, so delegation cannot be used to gain a permission the manager lacks; DESTRUCTIVE calls inside a sub-task still stop for your approval; depth, count and time limits are enforced server-side before the child task is created.
- Schedules (Phase 10): schedules are owner-only; a firing goes through the same task service, so agent permissions, approvals and task limits all still apply; claiming is atomic so a schedule cannot double-fire.
- Projects, files and memory (Phase 9): every file path goes through the workspace guard; uploads keep only a sanitised basename and never overwrite; project files, memory and downloads are owner-only; memory holds short facts you can inspect and delete, never whole conversations.
- Approvals (Phase 8): DESTRUCTIVE always stops for a human; decisions are single-use and owner-scoped; requests expire and are cancelled when a task stops or the server restarts; every decision is audit logged.
- Computer use (Phase 7): off by default and refused unless enabled; one task at a time; screenshots and frames are owner-only; the desktop session closes when the task ends, stops or idles.
- Browser (Phase 6): every request from the agent browser goes through the egress proxy with the private-address guard; isolated context per task; downloads, uploads and service workers blocked; screenshots and frames are owner-only; session limits and idle timeouts.
- MCP (Phase 5): encrypted write-only secrets, stdio restricted to administrators behind `MCP_STDIO_ENABLED`, secret-free child environment, SSRF-guarded HTTP transport, per-tool permission levels and enablement, per-user rate limit on connection tests, audit log entries for server and tool changes.
- Tools (Phase 4): per-agent tool assignment and permission grants, DESTRUCTIVE always blocked, per-task tool-call limit, workspace path guard with symlink checks, `shell: false` with a program allowlist and secret-free environment, git hooks disabled, SSRF protection on web fetches, output caps, and a `tool_call` record for every attempt, including denials.

## Roadmap

1. **Foundation** ✅
2. **Agent runtime** ✅: agents, router, AgentRuntime, tasks
3. **Live execution** ✅: events, SSE transport, timeline, pause/stop/resume
4. **Tools** ✅: tool registry, permissions, files, git, terminal, web search and fetch. The interactive browser is Phase 6
5. **MCP** ✅: server management, discovery, execution, per-tool permissions, MCP events
6. **Browser agent** ✅: Playwright Chromium, page snapshots, actions, screenshots, live view
7. **Computer use** ✅: screen capture to the model, mouse and keyboard, live desktop view
8. **Human approval** ✅: permission engine, approval requests, approve once / for task, reject, audit
9. **Projects, files, memory** ✅: projects with their own workspace and memory, file browser, agent memory tools
10. **Scheduler** ✅: cron/daily/weekly/monthly/interval/once triggers, autonomous runs, execution history
11. **Multi-agent** ✅: Manager Agent, `agent.delegate`, sub-tasks in the task tree, limits on depth, count, time and budget
12. **Production** ✅: Docker images, Redis/BullMQ worker tier, health/readiness endpoints, backup and restore scripts, Coolify deployment
