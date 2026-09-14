# Security

AI Workspace lets AI agents run real tools: they write files, run commands, control a browser, and can be given access to Docker, SSH hosts and a desktop. Read this before deploying it anywhere that matters.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. You will get an acknowledgement within a few days. Please include the version or commit, steps to reproduce, and what an attacker could achieve.

Only the `main` branch is supported; fixes are published there.

## What is protected

- **Secrets stay on the server.** Model API keys and MCP credentials are read only by server code; MCP secrets are encrypted at rest. Nothing under the browser bundle can read them.
- **Every request is authenticated and scoped.** Sessions via Better Auth; every database access is filtered by the signed-in user; mutations require a same-origin check. The first account becomes admin; further sign-ups are refused unless `ALLOW_REGISTRATION=true`.
- **Destructive actions need a human.** Deleting files, stopping or removing containers, destructive shell commands and similar all pause the task for approval. Autonomous mode can pre-approve named tools, but `terminal.run` and `ssh.run` can never be pre-approved, and every unattended action is written to the audit log.
- **Paths are confined.** All file access goes through a workspace guard; agents cannot reach outside their own workspace.
- **Outbound requests are checked.** Web fetching, the browser, GitHub and MCP HTTP servers refuse private and loopback addresses unless explicitly allowed.
- **Limits.** Per-agent time, tool-call and daily-budget limits; delegation depth and count limits; rate limits on sign-in, sign-up and chat.

## What is NOT protected — read this

**The command-running tools are not sandboxed.** `terminal.run`, `ssh.run`, the `docker.*` tools and the browser run as the operating-system user of the process (inside the worker container in the Docker deployment, which limits the damage but is not isolation). An agent — or a prompt-injection attack on an agent — that is granted these tools can do anything that user can do.

Because of this:

- These tools are **off by default** (`TERMINAL_ENABLED`, `DOCKER_TOOLS_ENABLED`, `SSH_TOOLS_ENABLED`). Enable them only on a host you are willing to hand to the agent.
- Run the app on a **dedicated machine or VM**, not on a server that also holds other services or data.
- Keep `MCP_STDIO_ENABLED=false` unless you trust every administrator: stdio MCP servers start arbitrary processes.
- Computer use (`COMPUTER_USE_ENABLED`) controls a real desktop. Never enable it on a machine with anything you would not show the agent.
- Treat web pages, MCP tool results and attached files as **untrusted input**: they reach the model and can try to steer it. The approval step exists for exactly this reason — do not routinely approve actions you did not expect.

## Deployment checklist

- Serve over HTTPS and set `APP_URL` to that origin (this is what enables secure cookies and the CSRF origin check).
- Generate fresh `BETTER_AUTH_SECRET` and `POSTGRES_PASSWORD` values; never reuse development ones.
- Keep `.env` out of version control (it is gitignored) and out of chat logs.
- Back up the database and workspaces (`scripts/backup.sh`) and test a restore.
- Review the audit log (`audit_log` table) if anything looks wrong; every approval, autonomous action and file creation is recorded there.
