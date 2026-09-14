I want you to build a production-quality, self-hosted **AI Agent Workspace** from scratch.

This is NOT a normal chatbot.
This is NOT a Slack/Discord clone.

The core idea is:

**I give the AI a task → the AI plans the task → selects an agent → uses tools → performs actions → I can watch everything happening live → the agent completes the task → I receive the final result.**

The product should feel like:

**ChatGPT + Claude Code + Cursor + Browser Use + Computer Use + MCP + Autonomous AI Agents**

inside one application.

---

# 1. PRODUCT VISION

The application is my personal/business **AI Operating Workspace**.

Example:

User:

"Research the latest AI agent frameworks, compare the top 5, create a Markdown report and save it to my project."

The system should:

1. Understand the request.
2. Determine which agent is appropriate.
3. Create an execution plan.
4. Select required tools.
5. Execute the task.
6. Show live execution to the user.
7. Ask for approval when required.
8. Continue execution after approval.
9. Save files/results.
10. Return a final answer.
11. Save the complete execution history.

The user should never feel like the AI is simply generating text.

The user should feel like:

**"I assigned work to an AI employee and I can watch it work."**

---

# 2. MAIN UI

Build a beautiful modern UI inspired by:

* ChatGPT
* Claude
* Linear
* Cursor
* modern developer tools

Use a clean premium interface.

Responsive:

* Desktop
* Tablet
* Mobile

Primary navigation:

Sidebar:

* New Task
* Conversations
* Agents
* Projects
* Tasks
* Schedules
* Files
* MCP Tools
* Activity
* Settings

---

# 3. TASK CHAT UI

The main interface should look like an advanced ChatGPT conversation.

User can type:

"Build a landing page for my SaaS."

or:

"Check my server and find why Docker is using too much disk."

or:

"Research today's AI news and create a report."

The message composer should support:

* Text
* File upload
* Images
* Voice input later
* Agent selection
* Project selection
* Model selection
* Tool permissions

Buttons:

Send
Stop
Retry
Continue
Approve
Reject

---

# 4. LIVE AGENT EXECUTION — VERY IMPORTANT

This is one of the most important features.

When an agent is working, I want to **SEE THE AGENT WORKING LIVE**.

Do not hide execution behind a loading spinner.

Create a live execution panel.

Example:

---

🤖 Research Agent
● Working...

Task:
Research the latest AI agent frameworks.

PLAN

✓ Understand task
✓ Search web
● Comparing frameworks
○ Create report
○ Save report

LIVE ACTIVITY

09:32:10
🔎 Searching web...

09:32:12
🌐 Opening website...

09:32:15
📄 Reading documentation...

09:32:18
🧠 Analyzing results...

09:32:21
🔧 Calling MCP tool: filesystem.write

09:32:22
📁 Creating report.md

09:32:24
✓ File created

PROGRESS
████████████████░░░░ 80%

STATUS
Agent is preparing the final report...
--------------------------------------

The user must be able to watch these events appear in real time.

---

# 5. LIVE EXECUTION TIMELINE

Every agent execution should have a timeline.

Events:

TASK_CREATED
AGENT_SELECTED
AGENT_STARTED
PLAN_CREATED
THINKING_STATUS
TOOL_CALL_STARTED
TOOL_CALL_FINISHED
BROWSER_OPENED
PAGE_NAVIGATED
PAGE_READ
FILE_CREATED
FILE_READ
TERMINAL_COMMAND_STARTED
TERMINAL_COMMAND_FINISHED
MCP_TOOL_STARTED
MCP_TOOL_FINISHED
APPROVAL_REQUIRED
APPROVAL_GRANTED
APPROVAL_REJECTED
TASK_PROGRESS
AGENT_MESSAGE
TASK_COMPLETED
TASK_FAILED

Each event should contain:

* timestamp
* agent
* event type
* human-readable description
* tool name
* status
* duration
* metadata where appropriate

---

# 6. LIVE BROWSER VIEW

For browser-based agents, show a live browser preview.

Example layout:

---

Agent: Browser Agent

┌───────────────────────────────────────────────┐
│ Browser                                       │
│                                               │
│ https://example.com                           │
│                                               │
│       LIVE BROWSER VIEW                       │
│                                               │
│       [website screenshot / stream]           │
│                                               │
└───────────────────────────────────────────────┘

Agent activity:

✓ Opened browser
✓ Navigated to website
● Searching...
○ Reading results

Current action:
Clicking "Documentation"
------------------------

The user should be able to see what the browser agent is doing.

Use a browser automation architecture compatible with **Browser Use** or an equivalent browser automation engine.

---

# 7. COMPUTER USE VIEW

Create support for computer-use agents.

The agent should eventually be able to control:

* Desktop applications
* Browser
* File manager
* Terminal
* IDE
* Other GUI applications

Show a live screen/desktop preview.

Example:

---

🖥 Computer Agent

LIVE SCREEN

[desktop screenshot / stream]

Current action:

🖱 Moving mouse
↓
Clicking VS Code
↓
Opening project
↓
Editing file

Activity:
✓ Opened VS Code
✓ Opened project
● Editing app/page.tsx
----------------------

Every computer-use action must be visible.

Dangerous actions must require approval.

---

# 8. TERMINAL LIVE VIEW

For coding/devops agents, show a terminal panel.

Example:

```text
$ docker ps

CONTAINER ID   IMAGE
a82f...        postgres
b17f...        redis

$ docker stats

CPU 12%
MEM 2.4GB

$ df -h

Filesystem      Size   Used
/dev/sda1       200G   164G
```

The output should stream live.

Show:

* command
* stdout
* stderr
* exit code
* duration
* working directory

Buttons:

* Stop
* Copy
* Expand
* Approve

---

# 9. TOOL EXECUTION VISIBILITY

Whenever the agent calls a tool, show it.

Example:

🔧 MCP Tool

Tool:
github.search_repositories

Arguments:
query = "AI agent framework"

Status:
● Running

Then:

✓ Completed in 1.8s

Result:
23 repositories found

Allow the user to expand the tool call to inspect details.

---

# 10. AGENT PLAN VIEW

Before complex tasks, the agent can create a plan.

Example:

TASK

"Create a competitor analysis."

PLAN

1. Search competitors
2. Visit official websites
3. Collect pricing
4. Compare features
5. Analyze differences
6. Create Markdown report
7. Save report
8. Return summary

Show each step with:

✓ Completed
● Running
○ Pending
✕ Failed

The plan should update live.

---

# 11. MULTI-AGENT SYSTEM

Support multiple specialized agents.

Initial agents:

### General Agent

General-purpose tasks.

### Coding Agent

* Write code
* Debug
* Run tests
* Git
* Terminal

### Research Agent

* Web search
* Browse websites
* Analyze information
* Create reports

### Browser Agent

* Navigate websites
* Click
* Type
* Extract information

### Computer Use Agent

* Control GUI
* Desktop applications
* Browser
* IDE

### DevOps Agent

* Docker
* Linux
* Servers
* Logs
* Deployments

### File Agent

* Read files
* Create files
* Edit files
* Organize files

Agents must be configurable.

Each agent has:

* Name
* Description
* System instructions
* Model
* Tools
* Permissions
* Memory
* Max execution time
* Max tool calls
* Temperature
* Context configuration

---

# 12. AGENT ROUTER

Create an Agent Router.

Example:

User:
"Check my Docker server and fix the problem."

Router:

→ DevOps Agent

User:
"Research competitors and make a report."

Router:

→ Research Agent

User:
"Fix this TypeScript error."

Router:

→ Coding Agent

User:
"Open this website and download the report."

Router:

→ Browser Agent

The router should be configurable.

Allow:

Automatic routing

OR

Manual agent selection.

---

# 13. MODEL PROVIDER SYSTEM

Do NOT hard-code the system to one AI model.

Create a provider abstraction.

Example:

ModelProvider

├── GeminiProvider
├── OpenAICompatibleProvider
└── OllamaProvider

Initially prioritize:

**Google Gemini**

because I will use Gemini during development.

But the architecture must allow:

* Gemini
* OpenAI
* Claude
* OpenAI-compatible APIs
* Ollama
* Local models
* Future providers

Agent configuration:

Agent → Model Provider → Model

Example:

Research Agent
→ Gemini
→ Gemini model

Coding Agent
→ Gemini

Local Coding Agent
→ Ollama

---

# 14. MCP FIRST-CLASS SUPPORT

MCP must be a core part of the architecture.

Agents should be able to use MCP servers.

MCP server configuration:

* Name
* Transport
* URL/command
* Authentication
* Environment variables
* Enabled/disabled
* Tools
* Permissions

Example:

GitHub MCP
Filesystem MCP
Docker MCP
Browser MCP

Agents can be assigned individual tools.

Example:

Coding Agent:

✓ filesystem.read
✓ filesystem.write
✓ git.status
✓ git.diff
✓ github.search

✕ docker.delete

---

# 15. UNIFIED TOOL SYSTEM

Create a common Tool interface.

Every tool should expose:

* name
* description
* input schema
* permission level
* execute()
* result
* error
* timeout

Tools can come from:

* Built-in tools
* MCP
* External APIs
* Agent plugins

Initial tool categories:

### Web

* Search
* Browser

### Computer

* Mouse
* Keyboard
* Screenshot

### Development

* Terminal
* Git
* GitHub

### Files

* Read
* Write
* Edit
* Search

### Infrastructure

* Docker
* SSH
* Logs

### MCP

* Any MCP tool

---

# 16. PERMISSION SYSTEM

Security is extremely important.

Agents must NOT have unrestricted access.

Create permissions:

READ
WRITE
EXECUTE
NETWORK
DESTRUCTIVE

Example:

Reading a file:

READ → automatically allowed.

Creating a file:

WRITE → allowed depending on agent.

Running:

rm -rf ...

DESTRUCTIVE → require approval.

Docker container deletion:

DESTRUCTIVE → require approval.

Production deployment:

EXECUTE → require approval.

---

# 17. HUMAN APPROVAL UI

When approval is required, stop execution.

Show:

---

⚠️ Approval Required

DevOps Agent wants to execute:

docker rm production-api

Permission:
DESTRUCTIVE

Reason:
Remove the broken container before redeployment.

[ Reject ]

[ Approve Once ]

[ Approve For This Task ]

---

The agent must remain paused until the user decides.

Never bypass approval.

---

# 18. REAL-TIME ARCHITECTURE

The frontend must receive execution events in real time.

Use:

WebSocket or Server-Sent Events.

Architecture:

Agent Worker
↓
Event Bus
↓
Realtime Server
↓
Web UI

Example:

Agent starts
↓
EVENT: AGENT_STARTED
↓
UI updates

Tool starts
↓
EVENT: TOOL_CALL_STARTED
↓
UI shows tool

Tool finishes
↓
EVENT: TOOL_CALL_FINISHED
↓
UI updates result

Approval required
↓
EVENT: APPROVAL_REQUIRED
↓
UI shows approval dialog

Task completes
↓
EVENT: TASK_COMPLETED
↓
UI shows final result

---

# 19. AGENT RUNTIME

Create a clean AgentRuntime abstraction.

Conceptual API:

AgentRuntime.run({
agentId,
task,
conversationId,
projectId
})

Runtime flow:

1. Load agent configuration.
2. Load model.
3. Load permissions.
4. Load tools.
5. Load memory.
6. Understand task.
7. Create plan.
8. Send task to model.
9. Detect tool calls.
10. Validate permissions.
11. Request approval if necessary.
12. Execute tool.
13. Capture result.
14. Send observation to model.
15. Continue.
16. Update live events.
17. Complete task.
18. Save execution history.

Support:

* cancellation
* retry
* pause
* resume
* timeout
* failure recovery

---

# 20. TASK CONTROL

During execution the user should see:

[ Pause ]

[ Stop ]

[ Resume ]

[ Retry ]

[ Continue ]

If an agent fails, show:

What happened
Why it failed
Which step failed
Tool error
Suggested next action

Allow:

Retry step
Retry entire task
Continue from failure

---

# 21. TASK HISTORY

Every execution must be saved.

Example:

Tasks

✓ Research AI frameworks
✓ Build landing page
✓ Analyze server
✕ Deploy application
✓ Generate SEO report

Each task should contain:

* prompt
* agent
* project
* model
* duration
* tokens
* cost
* tools used
* execution events
* files created
* final response
* errors

---

# 22. CONVERSATIONS

Conversation history should support:

* Search
* Rename
* Delete
* Archive
* Pin
* Project association

Messages should preserve:

* User messages
* Agent responses
* Tool calls
* Tool results
* Execution timeline

---

# 23. PROJECTS

Projects group everything related to a specific goal.

Example:

Project:

"My SaaS"

Agents:

* Coding Agent
* Research Agent
* DevOps Agent

Project contains:

* Conversations
* Tasks
* Files
* Agents
* Memories
* Schedules
* Execution history

---

# 24. FILE SYSTEM

Create a secure file workspace.

Users can:

* Upload files
* View files
* Search files
* Create files
* Download files

Agents can work with project files.

Show live file operations:

📄 Reading package.json
✏️ Editing app/page.tsx
📄 Creating README.md
✓ Saved README.md

---

# 25. MEMORY

Implement:

Conversation Memory
Agent Memory
Project Memory

Do not automatically store every message as permanent memory.

Memory should be structured.

Example:

Project memory:

* Technology: Next.js
* Database: PostgreSQL
* Deployment: Coolify
* Repository: example/project

Allow the user to inspect and manage project memory.

---

# 26. SCHEDULER

Support autonomous scheduled tasks.

Examples:

"Every morning at 8 AM, research AI news."

"Every Monday, check GitHub issues."

"Every night, check server health."

Create:

Schedule
→ Agent
→ Task
→ Trigger
→ Execution

Support:

* Cron
* Daily
* Weekly
* Monthly
* One-time
* Interval

Show execution history.

---

# 27. AUTONOMOUS MODE

Add an optional:

**Autonomous Mode**

In normal mode:

Agent asks for approval for sensitive actions.

In autonomous mode:

User can define trusted tools and permissions.

Example:

Autonomous Coding Agent:

✓ Read files
✓ Edit files
✓ Run tests
✓ Git status

Still require approval for:

✕ Production deployment
✕ Destructive commands
✕ Secret access

---

# 28. AGENT-TO-AGENT COMMUNICATION

Support future multi-agent workflows.

Example:

User
↓
Manager Agent
↓
Research Agent
↓
Coding Agent
↓
Testing Agent
↓
DevOps Agent
↓
Manager Agent
↓
User

Agents should be able to pass structured results to other agents.

Do not implement uncontrolled agent loops.

Add:

* maximum agent depth
* maximum execution time
* maximum tool calls
* budget/token limit

---

# 29. OBSERVABILITY

Create an Activity dashboard.

Show:

* Active agents
* Completed tasks
* Failed tasks
* Tool calls
* Model usage
* Token usage
* Cost
* Average execution time
* Errors

Example:

Active Agents: 2
Tasks Today: 17
Tool Calls: 94
Tokens: 1.2M
Estimated Cost: $X
Success Rate: XX%

---

# 30. DATABASE

Use PostgreSQL.

Use Prisma or Drizzle.

Suggested entities:

User
Agent
AgentTool
ModelProvider
Model
Conversation
Message
Project
ProjectMember
Task
TaskStep
TaskEvent
ToolCall
MCPServer
MCPTool
Permission
ApprovalRequest
File
Memory
Schedule
Execution
UsageLog

Use proper indexes and relations.

---

# 31. REDIS / JOB SYSTEM

Use Redis.

Use BullMQ or equivalent for background execution.

Architecture:

Web App
↓
API
↓
Redis Queue
↓
Agent Worker
↓
Tools
↓
Realtime Events
↓
Web UI

Long-running agents must NOT block normal web requests.

---

# 32. SECURITY

Implement production security.

Requirements:

* Authentication
* Authorization
* RBAC
* Secure sessions
* CSRF protection where applicable
* Rate limiting
* Input validation
* Zod schemas
* Secure headers
* Secret management
* Audit logs
* Tool permission validation
* Command restrictions
* Path traversal protection
* SSRF protection
* Network restrictions
* Agent execution limits
* Tool timeouts

Never expose API keys to the browser.

Never allow arbitrary destructive commands without permission.

---

# 33. TECHNOLOGY STACK

Frontend:

Next.js
TypeScript
Tailwind CSS
shadcn/ui

Backend:

Next.js API/server components where appropriate
Node.js workers

Database:

PostgreSQL
Prisma or Drizzle

Queue:

Redis
BullMQ

Realtime:

WebSocket or SSE

Validation:

Zod

Authentication:

Secure authentication library

Storage:

S3-compatible storage

AI:

Gemini API first
Provider abstraction for other models

Deployment:

Docker
Docker Compose
Coolify compatible

---

# 34. PROJECT STRUCTURE

Use a modular architecture.

Example:

apps/

web/
app/
components/
features/

worker/
agents/
jobs/
tools/

packages/

ai/
agents/
tools/
mcp/
database/
auth/
scheduler/
realtime/
security/
shared/
ui/

Do not create one giant application file.

Keep responsibilities separated.

---

# 35. API DESIGN

Create clean APIs.

Examples:

POST /api/tasks
GET /api/tasks/:id
POST /api/tasks/:id/pause
POST /api/tasks/:id/resume
POST /api/tasks/:id/stop
POST /api/tasks/:id/retry

GET /api/tasks/:id/events

GET /api/agents
POST /api/agents

GET /api/tools
GET /api/mcp

POST /api/approvals/:id/approve
POST /api/approvals/:id/reject

GET /api/projects

GET /api/executions

---

# 36. REAL-TIME EVENT SCHEMA

Create a typed event system.

Example:

type AgentEvent =
| TaskCreatedEvent
| AgentStartedEvent
| PlanCreatedEvent
| ToolCallStartedEvent
| ToolCallFinishedEvent
| ApprovalRequiredEvent
| AgentStatusEvent
| TaskProgressEvent
| TaskCompletedEvent
| TaskFailedEvent;

All events must be strongly typed.

---

# 37. LIVE EXECUTION UI DESIGN

This is a major differentiator.

When the agent runs, the user should be able to switch between:

### Overview

Plan + progress + current status

### Activity

Real-time event timeline

### Browser

Live browser view

### Computer

Live desktop view

### Terminal

Live terminal

### Tools

All MCP/tool calls

### Files

Files being created/modified

### Logs

Detailed execution logs

Example tabs:

[Overview] [Activity] [Browser] [Computer] [Terminal] [Tools] [Files] [Logs]

Only show relevant tabs depending on the task.

---

# 38. AGENT STATUS

Use clear states:

IDLE
QUEUED
PLANNING
RUNNING
WAITING_FOR_TOOL
WAITING_FOR_APPROVAL
PAUSED
COMPLETED
FAILED
CANCELLED

Show these states visually.

---

# 39. MOBILE UI

Mobile is important.

On mobile:

Bottom navigation:

Chat
Tasks
Agents
Activity
Settings

Live execution should still work.

For browser/computer previews:

Allow:

* Full screen
* Zoom
* Collapse
* Activity-only mode

---

# 40. ERROR HANDLING

Never show raw technical errors only.

Instead:

Agent failed

Step:
"Install dependencies"

Error:
npm exited with code 1

Reason:
Package conflict

Possible actions:

[Retry]
[Ask Agent to Fix]
[Stop]

Still allow advanced users to expand the raw error.

---

# 41. COST CONTROL

Every model execution should record:

* Provider
* Model
* Input tokens
* Output tokens
* Total tokens
* Estimated cost
* Duration

Allow per-agent limits.

Example:

Research Agent:
Daily budget = $2

Coding Agent:
Daily budget = $5

Stop execution when budget is exceeded.

---

# 42. NO FAKE FUNCTIONALITY

Do not create fake browser results.

Do not create fake MCP responses.

Do not create fake terminal output.

Do not create fake agent execution.

If a feature cannot yet be implemented, clearly mark it as:

NOT IMPLEMENTED

Do not pretend it works.

---

# 43. DEVELOPMENT STRATEGY

Do NOT build the entire application in one generation.

Build incrementally.

## Phase 1 — Foundation

Implement:

* Next.js
* TypeScript
* UI
* Authentication
* PostgreSQL
* Database schema
* Basic chat
* Gemini integration
* Streaming response

Test everything.

---

## Phase 2 — Agent Runtime

Implement:

* Agent model
* Agent configuration
* Agent Router
* AgentRuntime
* Agent execution
* Task model
* Task state

---

## Phase 3 — Live Execution

Implement:

* Task events
* WebSocket/SSE
* Live activity timeline
* Progress
* Agent status
* Pause
* Stop
* Resume

This phase is extremely important.

---

## Phase 4 — Tools

Implement:

* Tool abstraction
* Terminal
* Files
* Git
* Web search
* Browser

---

## Phase 5 — MCP

Implement:

* MCP server management
* MCP tool discovery
* MCP tool execution
* Tool permissions
* MCP event logging

---

## Phase 6 — Browser Agent

Integrate Browser Use or an equivalent browser automation system.

Implement:

* browser session
* navigation
* clicks
* typing
* screenshots
* live browser preview
* browser events

---

## Phase 7 — Computer Use

Implement computer-use architecture.

Support:

* screenshot
* mouse
* keyboard
* application interaction

Show live screen.

All dangerous actions require approval.

---

## Phase 8 — Human Approval

Implement:

* permission engine
* approval requests
* approve once
* approve for task
* reject
* audit logs

---

## Phase 9 — Projects + Files + Memory

Implement:

* Projects
* Project files
* Project memory
* Agent memory
* File browser

---

## Phase 10 — Scheduler

Implement:

* Scheduled tasks
* Cron
* Recurring agents
* Execution history

---

## Phase 11 — Multi-Agent

Implement:

* Manager Agent
* Agent-to-agent communication
* Delegation
* Execution limits
* Budget limits

---

## Phase 12 — Production

Implement:

* Docker
* Docker Compose
* Redis
* Worker
* Production security
* Logging
* Monitoring
* Backups
* Coolify deployment
* Documentation

---

# 44. TESTING

Every phase must include tests.

Run:

TypeScript type checking
Lint
Unit tests
Integration tests
Build

For agent execution test:

User task
→ Agent
→ Tool
→ Tool result
→ Agent
→ Final response

Also test:

* Tool failure
* Agent failure
* Timeout
* Cancellation
* Approval
* Resume
* Retry
* Permission denial

---

# 45. IMPORTANT DEVELOPMENT RULE

Before implementing each phase:

1. Inspect the current repository.
2. Understand existing architecture.
3. Explain the implementation plan briefly.
4. Show files to create/change.
5. Implement only the current phase.
6. Run type checking.
7. Run tests.
8. Run production build.
9. Fix errors.
10. Verify functionality.
11. Then wait for the next phase.

Do not rewrite working code unnecessarily.

Do not introduce unnecessary dependencies.

Do not create over-engineered abstractions without a reason.

Use clean production-quality TypeScript.

---

# 46. FIRST TASK

Start with **Phase 1 only**.

First inspect the repository.

If the repository is empty:

Initialize the project.

Then build:

* Next.js application
* TypeScript strict mode
* Tailwind
* shadcn/ui
* PostgreSQL connection
* Database schema foundation
* Authentication
* Gemini provider
* Basic ChatGPT-style UI
* Streaming Gemini response
* Responsive design

Do NOT implement Phase 2 yet.

After Phase 1 is complete:

* Run tests
* Run typecheck
* Run lint
* Run production build
* Fix all errors

Then give me:

1. What was built
2. Architecture
3. Files created/changed
4. How to run it
5. Environment variables required
6. Test results
7. Known limitations
8. Recommended next phase

The final product must be a real **self-hosted AI Agent Workspace**, not a mockup.