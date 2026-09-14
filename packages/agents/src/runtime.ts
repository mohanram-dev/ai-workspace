import {
  estimateCostUsd,
  isProviderError,
  type ChatMessage,
  type ChatRequest,
  type CompletedResponse,
  type FinishReason,
  type ModelProvider,
  type ProviderRegistry,
  type TokenUsage,
  type ImageAttachment,
  type ToolCallRequest,
  type ToolDeclaration,
} from "@aiw/ai";
import {
  addTaskUsage,
  claimQueuedTask,
  countToolCallsForTask,
  listMemoriesForTask,
  listToolCallsForTask,
  insertToolCall,
  insertScreenshot,
  pruneScreenshotsForTask,
  updateToolCall,
  getAgentForUser,
  getTask,
  insertTaskSteps,
  insertUsageLog,
  isTaskPauseRequested,
  writeAuditLog,
  listAgentsForUser,
  listMessages,
  listTaskSteps,
  sumAgentCostSince,
  updateMessagesForTask,
  updateTask,
  updateTaskStep,
  type Agent,
  type Database,
  type Task,
  type TaskStep,
} from "@aiw/database";
import type { TaskError, TaskEventType, TaskStatus } from "@aiw/shared";
import {
  decidePermission,
  isToolError,
  toolParameters,
  Workspace,
  type AnyToolDefinition,
  type BrowserActionKind,
  type ComputerActionKind,
  type PermissionLevel,
  type ToolActivity,
  type ToolContext,
  type ToolRegistry,
  type ToolSource,
} from "@aiw/tools";
import type { ApprovalService } from "./approvals";
import { createDelegationTools, type DelegationLimits } from "./delegation";
import { buildMemoryNotice, projectWorkspace } from "./memory-tools";
import { TaskFailure, toTaskError } from "./errors";
import type { EventContext, TaskEventRecorder } from "./events";
import { planTask } from "./planner";
import { buildAgentSystemPrompt, buildStepPrompt } from "./prompts";
import { routeTask } from "./router";

export interface AgentRuntimeOptions {
  db: Database;
  registry: ProviderRegistry;
  events: TaskEventRecorder;
  /** Built-in tools; agents only receive the tools assigned to them. */
  tools?: ToolRegistry;
  /** Per-user tool sources (MCP servers), resolved when a task starts. */
  toolSources?: ToolSource[];
  /** Human approval for DESTRUCTIVE tool calls. Without it those calls are refused. */
  approvals?: ApprovalService;
  /** Limits on agent-to-agent delegation (spec §28). Pass false to switch delegation off. */
  delegation?: Partial<DelegationLimits> | false;
  /** Called when a task ends, so per-task resources (browser sessions) are released. */
  onTaskEnd?: (taskId: string) => Promise<void> | void;
  /** Base directory for per-user tool workspaces. Required when tools are used. */
  workspaceRoot?: string;
  /** Model used for automatic routing. Defaults to the default provider's default model. */
  routerModel?: string | undefined;
  /** Upper bound for the routing call, before the agent's own time limit applies. */
  routingTimeoutMs?: number;
  /** Backoff delays for retrying rate-limited or unavailable provider calls. */
  retryDelaysMs?: number[];
  now?: () => Date;
}

type UsagePurpose = "routing" | "planning" | "step" | "tool";
type StepKind = "only" | "intermediate" | "synthesis";

interface ModelTarget {
  provider: ModelProvider;
  model: string;
}

interface RunState {
  task: Task;
  agent: Agent | null;
  signal: AbortSignal;
  step: TaskStep | null;
  toolCallsUsed: number;
}

class CancelledError extends Error {
  constructor() {
    super("Task cancelled");
    this.name = "CancelledError";
  }
}

/** Thrown at a step boundary when the user asked to pause. */
class PauseError extends Error {
  constructor() {
    super("Task paused");
    this.name = "PauseError";
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
/** Blank line between system-prompt sections. */
const SECTION_BREAK = String.fromCharCode(10, 10);
/** Characters of tool output sent back to the model per call. */
const MAX_TOOL_CONTENT_CHARS = 30_000;
/** Images returned to the model per tool call (e.g. one screenshot). */
const MAX_IMAGES_PER_CALL = 2;
/** Length of the final answer copied onto the timeline; the full text is on the task. */
const MAX_AGENT_MESSAGE_CHARS = 2_000;
/** Size of the tool output JSON stored with the tool call record. */
const MAX_STORED_OUTPUT_CHARS = 100_000;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} characters truncated)` : text;
}

/** One line describing what the agent wants to do, for the approval prompt. */
function describeAction(tool: AnyToolDefinition, toolName: string, input: unknown): string {
  const values = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (toolName === "terminal.run") {
    const args = Array.isArray(values.args) ? values.args.map(String) : [];
    return `${String(values.program ?? "")} ${args.join(" ")}`.trim();
  }
  const primary = ["path", "url", "command", "name", "query", "text"].find((key) => typeof values[key] === "string");
  const detail = primary ? `: ${String(values[primary]).slice(0, 200)}` : "";
  return `${toolName}${detail}` || tool.name;
}

function storedOutput(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  return json.length > MAX_STORED_OUTPUT_CHARS ? { truncated: true, preview: json.slice(0, MAX_STORED_OUTPUT_CHARS) } : output;
}

const ACTIVITY_DESCRIPTIONS: { [K in ToolActivity["type"]]: (a: Extract<ToolActivity, { type: K }>) => string } = {
  FILE_READ: (a) => `Read ${a.path}`,
  FILE_CREATED: (a) => `Created ${a.path}`,
  FILE_UPDATED: (a) => `Updated ${a.path}`,
  TERMINAL_COMMAND_STARTED: (a) => `$ ${a.command}`,
  TERMINAL_COMMAND_FINISHED: (a) => (a.timedOut ? `Command timed out: ${a.command}` : `Command finished (exit ${a.exitCode}): ${a.command}`),
  PAGE_READ: (a) => `Read page: ${a.title ?? a.url}`,
  MCP_TOOL_STARTED: (a) => `Calling MCP tool ${a.tool} on ${a.serverName}`,
  MCP_TOOL_FINISHED: (a) => (a.isError ? `MCP tool ${a.tool} on ${a.serverName} reported an error` : `MCP tool ${a.tool} on ${a.serverName} finished`),
  BROWSER_OPENED: () => "Opened the browser",
  PAGE_NAVIGATED: (a) => `Navigated to ${a.title || a.url}`,
  BROWSER_ACTION: (a) => BROWSER_ACTION_TEXT[a.action](a.target),
  BROWSER_SCREENSHOT: (a) => `Screenshot of ${a.title || a.url}`,
  BROWSER_CLOSED: () => "Closed the browser",
  COMPUTER_STARTED: (a) => `Started controlling the ${a.platform} desktop (${a.screenWidth}×${a.screenHeight})`,
  COMPUTER_ACTION: (a) => COMPUTER_ACTION_TEXT[a.action](a.target),
  COMPUTER_SCREENSHOT: () => "Screenshot of the desktop",
  COMPUTER_STOPPED: () => "Stopped controlling the desktop",
  TASK_DELEGATED: (a) => `Delegated to the ${a.agentName}: ${a.instruction.slice(0, 120)}`,
  SUBTASK_FINISHED: (a) => `The ${a.agentName} ${a.status === "completed" ? "finished" : a.status}`,
};
const COMPUTER_ACTION_TEXT: Record<ComputerActionKind, (target: string) => string> = {
  move: (t) => `Moving the mouse to ${t}`,
  click: (t) => `Clicking at ${t}`,
  double_click: (t) => `Double-clicking at ${t}`,
  right_click: (t) => `Right-clicking at ${t}`,
  drag: (t) => `Dragging ${t}`,
  scroll: (t) => `Scrolling at ${t}`,
  type: (t) => `Typing (${t})`,
  key: (t) => `Pressing ${t}`,
  wait: (t) => `Waiting ${t}`,
};
const BROWSER_ACTION_TEXT: Record<BrowserActionKind, (target: string) => string> = {
  click: (t) => `Clicking ${t}`,
  type: (t) => `Typing into ${t}`,
  select: (t) => `Selecting an option in ${t}`,
  press: (t) => `Pressing ${t}`,
  scroll: (t) => `Scrolling ${t}`,
  back: () => "Going back",
};
/** Screenshots kept per task (oldest are pruned). */
const MAX_SCREENSHOTS_PER_TASK = 60;

function activityStatus(activity: ToolActivity): "running" | "success" | "warning" | "info" {
  switch (activity.type) {
    case "TERMINAL_COMMAND_STARTED":
    case "MCP_TOOL_STARTED":
    case "BROWSER_ACTION":
    case "COMPUTER_ACTION":
      return "running";
    case "BROWSER_SCREENSHOT":
    case "COMPUTER_SCREENSHOT":
      return "info";
    case "TERMINAL_COMMAND_FINISHED":
      return activity.timedOut || activity.exitCode !== 0 ? "warning" : "success";
    case "MCP_TOOL_FINISHED":
      return activity.isError ? "warning" : "success";
    default:
      return "success";
  }
}
const DEFAULT_RETRY_DELAYS_MS = [3000, 10_000, 30_000];
/** Longest wait honoured from a provider's retry hint. */
const MAX_RETRY_AFTER_MS = 60_000;

function isTransient(error: unknown): boolean {
  return isProviderError(error) && (error.code === "rate_limited" || error.code === "unavailable");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stepKind(steps: TaskStep[], step: TaskStep): StepKind {
  return steps.length === 1 ? "only" : step.index === steps.length - 1 ? "synthesis" : "intermediate";
}

function progressOf(steps: TaskStep[]) {
  const completed = steps.filter((s) => s.status === "completed").length;
  return { completed, total: steps.length, percent: steps.length ? Math.round((completed / steps.length) * 100) : 0 };
}

/**
 * Executes agent tasks: route → resolve model → plan → run steps → finish.
 * Every transition is persisted and emitted as a typed event; step output is
 * streamed as ephemeral deltas. Pause requests take effect at step boundaries.
 *
 * Phase 4 extends step execution with tool calls.
 */
export class AgentRuntime {
  private readonly now: () => Date;

  /** The agent-to-agent delegation tools this runtime provides, for registration in a tool listing. */
  readonly delegationTools: AnyToolDefinition[];

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.delegationTools =
      options.delegation === false
        ? []
        : createDelegationTools({
            db: options.db,
            ...(options.delegation ? { limits: options.delegation } : {}),
            // A sub-task runs through this same runtime, so it gets the same
            // permissions, approvals, limits and event stream as any other task.
            run: (taskId, signal) => this.execute(taskId, signal),
          });
  }

  private get events(): TaskEventRecorder {
    return this.options.events;
  }

  private context(state: RunState, step: TaskStep | null = state.step): EventContext {
    return {
      taskId: state.task.id,
      userId: state.task.userId,
      agent: state.agent ? { id: state.agent.id, name: state.agent.name } : null,
      stepId: step?.id ?? null,
    };
  }

  private status(state: RunState, text: string, status: "running" | "warning" = "running"): Promise<unknown> {
    return this.events.emit(this.context(state), "THINKING_STATUS", { description: text, status, data: { text } });
  }

  /** Runs a queued task until it completes, fails, is cancelled or pauses. Returns null if not claimable. */
  async execute(taskId: string, userSignal: AbortSignal): Promise<TaskStatus | null> {
    const { db } = this.options;
    const claimed = await claimQueuedTask(db, taskId);
    if (!claimed) return null;

    const startedAt = claimed.startedAt ?? this.now();
    const state: RunState = { task: claimed, agent: null, signal: userSignal, step: null, toolCallsUsed: 0 };
    let timeoutSignal: AbortSignal | null = null;

    try {
      await updateMessagesForTask(db, taskId, { status: "streaming", content: "", error: null, completedAt: null });
      throwIfCancelled(userSignal);

      const agent = await this.resolveAgent(state);
      state.agent = agent;

      const target = await this.options.registry.resolveModel(
        claimed.modelOverride ?? agent.model ?? undefined,
        agent.provider,
      );
      await updateTask(db, taskId, { provider: target.provider.id, model: target.model });
      await this.events.emit(this.context(state), "AGENT_STARTED", {
        description: `${agent.name} started with ${target.model}`,
        status: "running",
        data: { agentName: agent.name, provider: target.provider.id, model: target.model, attempt: claimed.attempt },
      });

      timeoutSignal = AbortSignal.timeout(agent.maxExecutionSeconds * 1000);
      state.signal = AbortSignal.any([userSignal, timeoutSignal]);
      const tools = await this.resolveTools(claimed.userId, agent.tools);
      const declarations: ToolDeclaration[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: toolParameters(t) }));
      const workspace = tools.length > 0 ? this.workspaceFor(claimed.userId, claimed.projectId) : null;
      state.toolCallsUsed = tools.length > 0 ? await countToolCallsForTask(db, taskId) : 0;
      const memories = await listMemoriesForTask(db, claimed.userId, {
        agentId: agent.id,
        projectId: claimed.projectId,
        conversationId: claimed.conversationId,
      });
      const system = [buildAgentSystemPrompt(agent, this.now(), tools), buildMemoryNotice(memories)].filter(Boolean).join(SECTION_BREAK);

      let steps = await listTaskSteps(db, taskId);
      if (steps.length === 0) {
        throwIfCancelled(state.signal);
        await this.status(state, "Creating a plan…");
        const plan = await planTask(
          { prompt: claimed.prompt, system, planningMode: agent.planningMode, maxSteps: agent.maxSteps, toolNames: tools.map((t) => t.name) },
          (request) => this.callModel(state, target, "planning", request),
        );
        steps = await insertTaskSteps(
          db,
          plan.steps.map((step, index) => ({ taskId, index, title: step.title, instruction: step.instruction })),
        );
        await this.events.emit(this.context(state), "PLAN_CREATED", {
          description: steps.length === 1 ? "Planned a single step" : `Plan created with ${steps.length} steps`,
          status: "success",
          data: { steps: steps.map((s) => ({ id: s.id, index: s.index, title: s.title })), planned: plan.planned },
        });
        await this.emitProgress(state, steps);
      }

      await updateTask(db, taskId, { status: "running" });
      const history = await this.loadHistory(claimed, agent);

      for (const step of steps) {
        if (step.status === "completed") continue;
        throwIfCancelled(state.signal);
        if (await isTaskPauseRequested(db, taskId)) throw new PauseError();
        state.step = step;

        const kind = stepKind(steps, step);
        const stepStartedAt = this.now();
        // A step that failed before carries its error into this attempt's prompt.
        const previousError = step.error;
        await updateTaskStep(db, step.id, { status: "running", startedAt: stepStartedAt, error: null });
        step.status = "running";
        step.startedAt = stepStartedAt;
        await this.events.emit(this.context(state), "STEP_STARTED", {
          description: `Started: ${step.title}`,
          status: "running",
          data: { index: step.index, total: steps.length, title: step.title, kind },
        });
        await this.status(
          state,
          kind === "synthesis" ? "Writing the final response…" : `Working on step ${step.index + 1} of ${steps.length}: ${step.title}`,
        );

        const response = await this.runStep(state, target, step, {
          system,
          messages: [
            ...history,
            { role: "user", content: this.stepPrompt(claimed.prompt, steps, step, kind, tools.length ? await this.completedActions(taskId) : [], previousError) },
          ],
          temperature: agent.temperature,
          maxOutputTokens: agent.maxOutputTokens,
          tools,
          declarations,
          workspace,
        });
        if (!response.text.trim()) throw new TaskFailure("empty_response");

        const completedAt = this.now();
        const durationMs = completedAt.getTime() - stepStartedAt.getTime();
        await updateTaskStep(db, step.id, {
          status: "completed",
          output: response.text,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          completedAt,
          durationMs,
        });
        step.status = "completed";
        step.output = response.text;
        await this.events.emit(this.context(state), "STEP_COMPLETED", {
          description: `Completed: ${step.title}`,
          status: "success",
          durationMs,
          data: {
            index: step.index,
            title: step.title,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            outputLength: response.text.length,
          },
        });
        await this.emitProgress(state, steps);
      }
      state.step = null;

      const result = steps.at(-1)?.output ?? "";
      if (result) {
        // The answer itself belongs on the timeline, not only in the task row.
        const truncated = result.length > MAX_AGENT_MESSAGE_CHARS;
        await this.events.emit(this.context(state), "AGENT_MESSAGE", {
          description: truncated ? `${result.slice(0, MAX_AGENT_MESSAGE_CHARS)}…` : result,
          status: "success",
          data: { text: truncated ? result.slice(0, MAX_AGENT_MESSAGE_CHARS) : result, truncated },
        });
      }
      return await this.finish(state, startedAt, { status: "completed", result, error: null });
    } catch (error) {
      if (error instanceof PauseError) return await this.pause(state, startedAt);
      if (userSignal.aborted) {
        return await this.finish(state, startedAt, { status: "cancelled", result: null, error: null });
      }

      let taskError: TaskError;
      // Any abort without a user stop means a time limit fired (agent or routing).
      const aborted = error instanceof CancelledError || (isProviderError(error) && error.code === "aborted");
      if (timeoutSignal?.aborted || aborted) {
        const seconds = state.agent?.maxExecutionSeconds;
        taskError = toTaskError(
          new TaskFailure("timeout", seconds ? `The task exceeded the agent's ${seconds}-second limit.` : undefined),
          state.step,
        );
      } else {
        if (!isProviderError(error) && !(error instanceof TaskFailure)) console.error("Agent task failed unexpectedly", error);
        taskError = toTaskError(error, state.step);
      }
      return await this.finish(state, startedAt, { status: "failed", result: null, error: taskError });
    }
  }

  /** Assigned, currently usable tools: built-ins first, then per-user sources. Names are unique. */
  private async resolveTools(userId: string, assigned: readonly string[]): Promise<AnyToolDefinition[]> {
    if (assigned.length === 0) return [];
    const wanted = new Set(assigned);
    const tools = this.options.tools?.resolve(assigned) ?? [];
    const names = new Set(tools.map((t) => t.name));
    for (const tool of this.delegationTools) {
      if (!wanted.has(tool.name) || names.has(tool.name)) continue;
      names.add(tool.name);
      tools.push(tool);
    }
    for (const source of this.options.toolSources ?? []) {
      for (const tool of await source.toolsForUser(userId)) {
        if (!wanted.has(tool.name) || names.has(tool.name) || !tool.availability().available) continue;
        names.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /**
   * Tool actions from earlier steps, so later steps neither repeat successful
   * work nor retry calls that were denied (a denial will not change mid-task).
   */
  private async completedActions(taskId: string): Promise<string[]> {
    const calls = await listToolCallsForTask(this.options.db, taskId);
    const seenDenials = new Set<string>();
    const actions: string[] = [];
    for (const call of calls) {
      if (call.status === "completed" && call.summary) actions.push(`${call.toolName}: ${call.summary}`);
      if (call.status === "denied") {
        const key = `${call.toolName}:${call.errorCode}`;
        if (seenDenials.has(key)) continue;
        seenDenials.add(key);
        actions.push(`${call.toolName}: DENIED (${call.errorCode}). ${call.error ?? ""}`.trim());
      }
    }
    return actions;
  }

  /**
   * A task in a project works inside that project's directory, so its files
   * stay together; otherwise it uses the user's personal workspace.
   */
  private workspaceFor(userId: string, projectId: string | null): Workspace {
    if (!this.options.workspaceRoot) throw new Error("AgentRuntime requires workspaceRoot when tools are configured");
    return projectWorkspace(this.options.workspaceRoot, userId, projectId);
  }

  /**
   * One plan step: the model may call tools repeatedly; each result is fed back
   * until it answers with text. After the agent's tool-call limit, tools stay
   * declared but calls are disabled so the model must finish.
   */
  private async runStep(
    state: RunState,
    target: ModelTarget,
    step: TaskStep,
    input: {
      system: string;
      messages: ChatMessage[];
      temperature: number;
      maxOutputTokens: number;
      tools: AnyToolDefinition[];
      declarations: ToolDeclaration[];
      workspace: Workspace | null;
    },
  ): Promise<CompletedResponse> {
    const agent = state.agent!;
    const messages = [...input.messages];
    let usage = ZERO_USAGE;

    for (;;) {
      const limitReached = state.toolCallsUsed >= agent.maxToolCalls;
      const response = await this.callModel(
        state,
        target,
        "step",
        {
          system: input.system,
          messages,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
          ...(input.declarations.length > 0 ? { tools: input.declarations, toolChoice: limitReached ? "none" : "auto" } : {}),
        },
        step,
      );
      usage = addUsage(usage, response.usage);
      if (response.toolCalls.length === 0 || input.declarations.length === 0) return { ...response, usage };

      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        const outcome = await this.executeToolCall(state, step, call, input.tools, input.workspace!);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: outcome.content, ...(outcome.images ? { images: outcome.images } : {}) });
      }
      if (state.toolCallsUsed >= agent.maxToolCalls) {
        messages.push({
          role: "user",
          content: `The limit of ${agent.maxToolCalls} tool calls for this task has been reached. Tools are now disabled: complete this step with the information you already have and state what could not be done.`,
        });
      }
    }
  }

  /** Validates, authorises and runs one tool call, recording it and its activity. Returns the content for the model. */
  private async executeToolCall(
    state: RunState,
    step: TaskStep,
    call: ToolCallRequest,
    tools: AnyToolDefinition[],
    workspace: Workspace,
  ): Promise<{ content: string; images?: ImageAttachment[] }> {
    const { db } = this.options;
    const agent = state.agent!;
    state.toolCallsUsed++;
    const tool = tools.find((t) => t.name === call.name);
    const started = performance.now();
    const record = await insertToolCall(db, {
      taskId: state.task.id,
      stepId: step.id,
      userId: state.task.userId,
      agentId: agent.id,
      providerCallId: call.id,
      toolName: call.name,
      category: tool?.category ?? null,
      input: call.arguments,
      status: "running",
    });
    const context = { ...this.context(state, step) };
    const eventBase = { toolName: call.name };

    const finish = async (
      status: "completed" | "failed" | "denied" | "cancelled",
      details: { summary?: string | null; error?: string | null; errorCode?: string | null; output?: unknown },
    ) => {
      const durationMs = Math.round(performance.now() - started);
      await updateToolCall(db, record.id, {
        status,
        summary: details.summary ?? null,
        error: details.error ?? null,
        errorCode: details.errorCode ?? null,
        output: details.output === undefined ? null : storedOutput(details.output),
        durationMs,
        completedAt: new Date(),
      });
      await this.events.emit(context, "TOOL_CALL_FINISHED", {
        ...eventBase,
        description:
          status === "completed"
            ? (details.summary ?? `${call.name} completed`)
            : status === "denied"
              ? `Blocked ${call.name}: ${details.error}`
              : status === "cancelled"
                ? `${call.name} was stopped`
                : `${call.name} failed: ${details.error}`,
        status: status === "completed" ? "success" : status === "failed" ? "error" : "warning",
        durationMs,
        data: {
          toolCallId: record.id,
          toolName: call.name,
          status,
          summary: details.summary ?? null,
          error: details.error ?? null,
          errorCode: details.errorCode ?? null,
        },
      });
    };
    const errorContent = (code: string, message: string) => JSON.stringify({ error: { code, message } });

    if (!tool) {
      const message = `The tool "${call.name}" is not available to this agent.`;
      await finish("denied", { error: message, errorCode: "not_found" });
      return { content: errorContent("not_available", message) };
    }

    const parsed = tool.inputSchema.safeParse(call.arguments);
    let permission: PermissionLevel | null = null;
    if (parsed.success) {
      permission = typeof tool.permission === "function" ? tool.permission(parsed.data) : tool.permission;
      await updateToolCall(db, record.id, { permission });
    }
    await this.events.emit(context, "TOOL_CALL_STARTED", {
      ...eventBase,
      description: `Calling ${call.name}`,
      status: "running",
      data: { toolCallId: record.id, toolName: call.name, category: tool.category, permission: permission ?? "unknown", input: call.arguments },
    });

    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      await finish("failed", { error: `Invalid arguments: ${message}`, errorCode: "invalid_input" });
      return { content: errorContent("invalid_input", `Invalid arguments: ${message}`) };
    }

    const approvals = this.options.approvals;
    const approvedForTask = approvals ? await approvals.approvedTools(state.task.id) : [];
    const decision = decidePermission(permission!, agent.permissions, {
      toolName: call.name,
      approvedForTask,
      autonomous: { enabled: agent.autonomousMode, trustedTools: agent.trustedTools },
    });
    if (decision.outcome === "denied") {
      await finish("denied", { error: decision.message, errorCode: decision.reason });
      return { content: errorContent(decision.reason, decision.message) };
    }
    if (decision.outcome === "allowed" && decision.autonomous) {
      // An unattended destructive action must still leave a trail (spec §27).
      const autonomousAction = describeAction(tool, call.name, parsed.data);
      await this.events.emit(this.context(state, step), "AUTONOMOUS_ACTION", {
        description: `Ran without asking (autonomous mode): ${autonomousAction}`,
        status: "warning",
        toolName: call.name,
        data: { toolCallId: record.id, toolName: call.name, permission: permission!, action: autonomousAction },
      });
      await writeAuditLog(db, {
        userId: state.task.userId,
        action: "agent.autonomous_action",
        resourceType: "tool_call",
        resourceId: record.id,
        metadata: { taskId: state.task.id, agentId: agent.id, toolName: call.name, permission },
      });
    }
    if (decision.outcome === "needs_approval") {
      if (!approvals) {
        const message = "This action needs human approval, which is not configured on this server.";
        await finish("denied", { error: message, errorCode: "requires_approval" });
        return { content: errorContent("requires_approval", message) };
      }
      const verdict = await this.requestApproval(state, step, call, record.id, permission!, tool, parsed.data, context, eventBase);
      if (verdict.status !== "approved") {
        await finish("denied", { error: verdict.message, errorCode: verdict.errorCode });
        return { content: errorContent(verdict.errorCode, verdict.message) };
      }
    }

    const toolTimeout = AbortSignal.timeout(tool.timeoutMs);
    const signal = AbortSignal.any([state.signal, toolTimeout]);
    let activityChain = Promise.resolve();
    const toolContext: ToolContext = {
      taskId: state.task.id,
      userId: state.task.userId,
      workspace,
      signal,
      report: (activity) => {
        activityChain = activityChain.then(async () => {
          const { type, ...rest } = activity;
          const describe = ACTIVITY_DESCRIPTIONS[type] as (a: ToolActivity) => string;
          const durationMs = "durationMs" in activity ? activity.durationMs : null;
          const data = { toolCallId: record.id, ...rest } as Record<string, unknown>;
          delete data.durationMs;
          if (activity.type === "BROWSER_SCREENSHOT" || activity.type === "COMPUTER_SCREENSHOT") {
            // Store the image; the event carries only its id and metadata.
            const image = Buffer.from(activity.image);
            const saved = await insertScreenshot(db, {
              taskId: state.task.id,
              userId: state.task.userId,
              toolCallId: record.id,
              url: activity.type === "BROWSER_SCREENSHOT" ? activity.url : "",
              title: activity.type === "BROWSER_SCREENSHOT" ? activity.title : null,
              width: activity.width,
              height: activity.height,
              mimeType: activity.mimeType,
              bytes: image.length,
              reason: activity.reason,
              source: activity.type === "COMPUTER_SCREENSHOT" ? "computer" : "browser",
              image,
            });
            await pruneScreenshotsForTask(db, state.task.id, MAX_SCREENSHOTS_PER_TASK);
            delete data.image;
            delete data.mimeType;
            data.screenshotId = saved.id;
          }
          await this.events.emit(context, type as TaskEventType & ToolActivity["type"], {
            ...eventBase,
            description: describe(activity),
            status: activityStatus(activity),
            durationMs,
            data: data as never,
          });
        });
      },
      output: (stream, text) => this.events.terminal(state.task.id, record.id, stream, text),
    };

    try {
      await workspace.ensure();
      const result = await tool.execute(parsed.data, toolContext);
      await activityChain;
      if (result.usage) await this.recordToolUsage(state, result.usage);
      await finish("completed", { summary: result.summary, output: result.output });
      const images = result.images?.slice(0, MAX_IMAGES_PER_CALL).map((image) => ({ mimeType: image.mimeType, data: image.data.toString("base64") }));
      return { content: clip(result.content ?? JSON.stringify(result.output), MAX_TOOL_CONTENT_CHARS), ...(images?.length ? { images } : {}) };
    } catch (error) {
      await activityChain;
      if (state.signal.aborted) {
        await finish("cancelled", { error: "Stopped with the task.", errorCode: "cancelled" });
        throw error instanceof CancelledError ? error : new CancelledError();
      }
      if (toolTimeout.aborted) {
        const message = `${call.name} exceeded its ${Math.round(tool.timeoutMs / 1000)}-second time limit.`;
        await finish("failed", { error: message, errorCode: "timeout" });
        return { content: errorContent("timeout", message) };
      }
      if (isToolError(error)) {
        await finish("failed", { error: error.message, errorCode: error.code });
        return { content: errorContent(error.code, error.message) };
      }
      console.error(`Tool ${call.name} failed unexpectedly`, error);
      const message = `${call.name} failed unexpectedly.`;
      await finish("failed", { error: message, errorCode: "internal" });
      return { content: errorContent("internal", message) };
    }
  }

  /**
   * Pauses the task on a DESTRUCTIVE tool call until the user approves or
   * rejects it (spec §17). The task keeps its worker but reports
   * "waiting_for_approval" so the UI can show the prompt.
   */
  private async requestApproval(
    state: RunState,
    step: TaskStep,
    call: ToolCallRequest,
    toolCallId: string,
    permission: PermissionLevel,
    tool: AnyToolDefinition,
    input: unknown,
    context: EventContext,
    eventBase: { toolName: string },
  ): Promise<{ status: "approved" } | { status: "denied"; message: string; errorCode: string }> {
    const { db } = this.options;
    const approvals = this.options.approvals!;
    const action = describeAction(tool, call.name, input);
    // The task is marked as waiting before the request exists, so nothing can
    // read a pending approval while the task still claims to be running.
    await updateToolCall(db, toolCallId, { status: "awaiting_approval" });
    await updateTask(db, state.task.id, { status: "waiting_for_approval" });
    const request = await approvals.create({
      taskId: state.task.id,
      userId: state.task.userId,
      agentId: state.agent?.id ?? null,
      stepId: step.id,
      toolCallId,
      toolName: call.name,
      permission,
      action,
      input,
    });
    await this.events.emit(context, "APPROVAL_REQUIRED", {
      ...eventBase,
      description: `Waiting for your approval: ${action}`,
      status: "warning",
      data: { approvalId: request.id, toolCallId, toolName: call.name, permission, action, input },
    });

    const decision = await approvals.waitForDecision(request, state.signal);
    await updateTask(db, state.task.id, { status: "running" });

    if (decision.status === "approved") {
      await updateToolCall(db, toolCallId, { status: "running" });
      await this.events.emit(context, "APPROVAL_GRANTED", {
        ...eventBase,
        description: decision.scope === "task" ? `Approved for this task: ${action}` : `Approved: ${action}`,
        status: "success",
        data: { approvalId: request.id, toolCallId, toolName: call.name, scope: decision.scope ?? "once", decidedBy: decision.decidedBy },
      });
      return { status: "approved" };
    }

    const expired = decision.status === "expired";
    const message =
      decision.status === "rejected"
        ? `The user rejected this action.${decision.reason ? ` Reason: ${decision.reason}` : ""}`
        : expired
          ? "Nobody approved this action in time, so it was not run."
          : "The approval request was cancelled, so the action was not run.";
    await this.events.emit(context, "APPROVAL_REJECTED", {
      ...eventBase,
      description: expired ? `Approval expired: ${action}` : `Rejected: ${action}`,
      status: "warning",
      data: { approvalId: request.id, toolCallId, toolName: call.name, reason: decision.reason, expired },
    });
    return { status: "denied", message, errorCode: expired ? "approval_expired" : decision.status === "rejected" ? "rejected" : "cancelled" };
  }

  private async recordToolUsage(state: RunState, usage: NonNullable<Awaited<ReturnType<AnyToolDefinition["execute"]>>["usage"]>) {
    const { db } = this.options;
    const costUsd = usage.totalTokens > 0 ? estimateCostUsd(usage.provider, usage.model, usage) : null;
    await insertUsageLog(db, {
      userId: state.task.userId,
      conversationId: state.task.conversationId,
      taskId: state.task.id,
      agentId: state.agent?.id ?? null,
      purpose: "tool",
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: costUsd,
      durationMs: 0,
      status: "completed",
    });
    if (usage.totalTokens > 0) await addTaskUsage(db, state.task.id, { ...usage, costUsd });
  }

  private async emitProgress(state: RunState, steps: TaskStep[]): Promise<void> {
    const progress = progressOf(steps);
    await this.events.emit(this.context(state, null), "TASK_PROGRESS", {
      description: `${progress.completed} of ${progress.total} steps complete`,
      data: progress,
    });
  }

  private async resolveAgent(state: RunState): Promise<Agent> {
    const { db } = this.options;
    const { task } = state;

    if (task.agentId) {
      const agent = await getAgentForUser(db, task.userId, task.agentId);
      if (!agent || !agent.enabled) throw new TaskFailure("agent_unavailable");
      if (!task.routing) {
        const routing = { mode: "manual", method: "manual", reason: "Selected by the user.", confidence: null } as const;
        await updateTask(db, task.id, { routing });
        await this.events.emit(
          { taskId: task.id, userId: task.userId, agent: { id: agent.id, name: agent.name } },
          "AGENT_SELECTED",
          { description: `${agent.name} selected`, status: "success", data: { agentName: agent.name, agentSlug: agent.slug, routing } },
        );
      }
      return agent;
    }

    const candidates = (await listAgentsForUser(db, task.userId)).filter((a) => a.enabled && a.routable);
    if (candidates.length === 0) throw new TaskFailure("no_agents");

    await this.status(state, "Choosing the best agent…");
    const target = await this.options.registry.resolveModel(this.options.routerModel ?? task.modelOverride ?? undefined);
    const routingSignal = AbortSignal.any([state.signal, AbortSignal.timeout(this.options.routingTimeoutMs ?? 60_000)]);
    const decision = await routeTask(task.prompt, candidates, (request) =>
      this.callModel({ ...state, signal: routingSignal }, target, "routing", request),
    );
    await updateTask(db, task.id, { agentId: decision.agent.id, routing: decision.routing });
    const { agent } = decision;
    await this.events.emit({ taskId: task.id, userId: task.userId, agent: { id: agent.id, name: agent.name } }, "AGENT_SELECTED", {
      description: `Routed to ${agent.name}`,
      status: "success",
      data: { agentName: agent.name, agentSlug: agent.slug, routing: decision.routing },
    });
    return agent;
  }

  /** Prior conversation turns, excluding this task's own prompt and reply. */
  private async loadHistory(task: Task, agent: Agent): Promise<ChatMessage[]> {
    if (!agent.useConversationHistory || !task.conversationId || agent.maxHistoryMessages === 0) return [];
    // A delegated task only knows the instruction it was given.
    if (task.parentTaskId) return [];

    const messages = await listMessages(this.options.db, task.conversationId);
    const ownIndex = messages.findIndex((m) => m.taskId === task.id);
    const cutoff = ownIndex === -1 ? messages.length : messages[ownIndex - 1]?.role === "user" ? ownIndex - 1 : ownIndex;

    return messages
      .slice(0, cutoff)
      .filter((m): m is typeof m & { role: "user" | "assistant" } => m.role !== "system")
      .filter((m) => m.content.length > 0 && (m.role === "user" || m.status === "completed" || m.status === "cancelled"))
      .slice(-agent.maxHistoryMessages)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private stepPrompt(prompt: string, steps: TaskStep[], current: TaskStep, kind: StepKind, actions: string[] = [], previousError: string | null = null): string {
    return buildStepPrompt({
      actions,
      prompt,
      kind,
      steps: steps.map((s) => ({
        title: s.title,
        status: s.status === "completed" ? "done" : s.id === current.id ? "current" : "pending",
      })),
      completed: steps.filter((s) => s.status === "completed" && s.output).map((s) => ({ title: s.title, output: s.output! })),
      current: { index: current.index, total: steps.length, title: current.title, instruction: current.instruction, previousError },
    });
  }

  /** A model call with budget checks, usage accounting and retries for transient provider errors. */
  private async callModel(
    state: RunState,
    target: ModelTarget,
    purpose: UsagePurpose,
    request: Omit<ChatRequest, "model" | "signal">,
    streamStep: TaskStep | null = null,
  ): Promise<CompletedResponse> {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt > 0 && streamStep) this.events.delta(state.task.id, streamStep.id, "", true);
        return await this.callModelOnce(state, target, purpose, request, attempt + 1, streamStep);
      } catch (error) {
        const scheduled = delays[attempt];
        if (!isTransient(error) || scheduled === undefined || state.signal.aborted) throw error;
        // Prefer the provider's own hint (e.g. per-minute quotas), within a sane cap.
        const hinted = isProviderError(error) ? error.retryAfterMs : undefined;
        const delay = hinted !== undefined ? Math.min(Math.max(hinted, scheduled), MAX_RETRY_AFTER_MS) : scheduled;
        const reason = isProviderError(error) && error.code === "rate_limited" ? "is rate limiting requests" : "is temporarily unavailable";
        await this.status(
          state,
          `${target.provider.name} ${reason}. Retrying in ${Math.round(delay / 1000)} s (attempt ${attempt + 2} of ${delays.length + 1})…`,
          "warning",
        );
        await sleep(delay, state.signal);
      }
    }
  }

  private async callModelOnce(
    state: RunState,
    target: ModelTarget,
    purpose: UsagePurpose,
    request: Omit<ChatRequest, "model" | "signal">,
    attempt: number,
    streamStep: TaskStep | null,
  ): Promise<CompletedResponse> {
    const { db } = this.options;
    if (state.agent) await this.assertBudget(state.agent);
    throwIfCancelled(state.signal);

    const started = performance.now();
    let usage = ZERO_USAGE;
    let status: "completed" | "failed" | "cancelled" = "failed";
    let errorCode: string | null = null;
    try {
      let text = "";
      const toolCalls: ToolCallRequest[] = [];
      let finishReason: FinishReason = "stop";
      for await (const chunk of target.provider.streamChat({ ...request, model: target.model, signal: state.signal })) {
        if (chunk.type === "text-delta") {
          text += chunk.text;
          if (streamStep) this.events.delta(state.task.id, streamStep.id, chunk.text);
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk.call);
        } else {
          usage = chunk.usage;
          finishReason = chunk.finishReason;
        }
      }
      status = "completed";
      return { text, toolCalls, usage, finishReason };
    } catch (error) {
      if (state.signal.aborted) status = "cancelled";
      errorCode = isProviderError(error) ? error.code : "unknown";
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - started);
      const costUsd = usage.totalTokens > 0 ? estimateCostUsd(target.provider.id, target.model, usage) : null;
      await insertUsageLog(db, {
        userId: state.task.userId,
        conversationId: state.task.conversationId,
        taskId: state.task.id,
        agentId: state.agent?.id ?? null,
        purpose,
        provider: target.provider.id,
        model: target.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUsd: costUsd,
        durationMs,
        status,
      });
      if (usage.totalTokens > 0) {
        await addTaskUsage(db, state.task.id, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd });
      }
      await this.events.emit(this.context(state, streamStep), "MODEL_CALL_FINISHED", {
        description:
          status === "completed"
            ? `${purpose[0]!.toUpperCase()}${purpose.slice(1)} call to ${target.model} (${usage.totalTokens} tokens)`
            : `${purpose[0]!.toUpperCase()}${purpose.slice(1)} call to ${target.model} ${status}${errorCode && status === "failed" ? `: ${errorCode}` : ""}`,
        status: status === "completed" ? "success" : status === "cancelled" ? "warning" : "error",
        durationMs,
        data: {
          purpose,
          provider: target.provider.id,
          model: target.model,
          status,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostUsd: costUsd,
          attempt,
          errorCode,
        },
      });
    }
  }

  private async assertBudget(agent: Agent): Promise<void> {
    if (agent.dailyBudgetUsd === null) return;
    const spent = await sumAgentCostSince(this.options.db, agent.id, startOfUtcDay(this.now()));
    if (spent >= agent.dailyBudgetUsd) {
      throw new TaskFailure(
        "budget_exceeded",
        `${agent.name} has used $${spent.toFixed(4)} of its $${agent.dailyBudgetUsd.toFixed(2)} daily budget.`,
      );
    }
  }

  private async releaseTaskResources(taskId: string): Promise<void> {
    try {
      await this.options.onTaskEnd?.(taskId);
    } catch (error) {
      console.error(`Failed to release resources of task ${taskId}`, error);
    }
  }

  private async pause(state: RunState, startedAt: Date): Promise<TaskStatus> {
    const { db } = this.options;
    await this.releaseTaskResources(state.task.id);
    try {
      const steps = await listTaskSteps(db, state.task.id);
      await updateTask(db, state.task.id, {
        status: "paused",
        pauseRequestedAt: null,
        durationMs: this.now().getTime() - startedAt.getTime(),
      });
      const progress = progressOf(steps);
      await this.events.emit(this.context(state, null), "TASK_PAUSED", {
        description: `Paused after ${progress.completed} of ${progress.total} steps`,
        status: "warning",
        data: { completedSteps: progress.completed, totalSteps: progress.total },
      });
    } catch (error) {
      console.error(`Failed to record the pause of task ${state.task.id}`, error);
    }
    return "paused";
  }

  private async finish(
    state: RunState,
    startedAt: Date,
    outcome: { status: "completed" | "failed" | "cancelled"; result: string | null; error: TaskError | null },
  ): Promise<TaskStatus> {
    const { db } = this.options;
    const completedAt = this.now();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    try {
      if (state.step && outcome.status !== "completed") {
        const stepStatus = outcome.status === "cancelled" ? "cancelled" : "failed";
        await updateTaskStep(db, state.step.id, {
          status: stepStatus,
          error: outcome.error?.message ?? null,
          completedAt,
          durationMs: state.step.startedAt ? completedAt.getTime() - state.step.startedAt.getTime() : null,
        });
        await this.events.emit(this.context(state), "STEP_FAILED", {
          description: `${stepStatus === "cancelled" ? "Stopped" : "Failed"}: ${state.step.title}`,
          status: stepStatus === "cancelled" ? "warning" : "error",
          data: { index: state.step.index, title: state.step.title, status: stepStatus, error: outcome.error?.message ?? null },
        });
      }
      await updateTask(db, state.task.id, {
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        completedAt,
        durationMs,
        pauseRequestedAt: null,
      });

      const totals = await getTask(db, state.task.id);
      await updateMessagesForTask(db, state.task.id, {
        status: outcome.status,
        content: outcome.result ?? "",
        error: outcome.error ? `${outcome.error.title}: ${outcome.error.message}` : null,
        provider: totals?.provider ?? null,
        model: totals?.model ?? null,
        inputTokens: totals?.inputTokens || null,
        outputTokens: totals?.outputTokens || null,
        completedAt,
      });

      const context = this.context(state, null);
      await this.releaseTaskResources(state.task.id);
      if (outcome.status === "completed") {
        await this.events.emit(context, "TASK_COMPLETED", {
          description: "Task completed",
          status: "success",
          durationMs,
          data: {
            inputTokens: totals?.inputTokens ?? 0,
            outputTokens: totals?.outputTokens ?? 0,
            estimatedCostUsd: totals?.estimatedCostUsd ?? null,
            resultLength: outcome.result?.length ?? 0,
          },
        });
      } else if (outcome.status === "failed" && outcome.error) {
        await this.events.emit(context, "TASK_FAILED", {
          description: `${outcome.error.title}: ${outcome.error.message}`,
          status: "error",
          durationMs,
          data: { error: outcome.error },
        });
      } else {
        await this.events.emit(context, "TASK_CANCELLED", { description: "Task stopped", status: "warning", durationMs, data: {} });
      }
    } catch (error) {
      console.error(`Failed to record the outcome of task ${state.task.id}`, error);
    }
    return outcome.status;
  }
}
