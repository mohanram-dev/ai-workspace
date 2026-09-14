import type { Agent, ApprovalRequest, ScreenshotMeta, TaskStep, TaskWithAgent, ToolCall } from "@aiw/database";
import type {
  AgentDto,
  ApprovalRequestDto,
  ApprovalScope,
  GrantablePermission,
  ScreenshotDto,
  SubTaskDto,
  TaskDto,
  TaskStepDto,
  TaskWithStepsDto,
  ToolCallDto,
  ToolPermissionLevel,
} from "@aiw/shared";

export type AgentActivity = { running: number; paused: number };

export function toAgentDto(row: Agent, activity: AgentActivity = { running: 0, paused: 0 }): AgentDto {
  return {
    id: row.id,
    status: activity.running > 0 ? "running" : activity.paused > 0 ? "paused" : "idle",
    activeTasks: activity.running + activity.paused,
    slug: row.slug,
    builtin: row.builtin,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    provider: row.provider,
    model: row.model,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    planningMode: row.planningMode,
    maxSteps: row.maxSteps,
    maxExecutionSeconds: row.maxExecutionSeconds,
    dailyBudgetUsd: row.dailyBudgetUsd,
    useConversationHistory: row.useConversationHistory,
    maxHistoryMessages: row.maxHistoryMessages,
    enabled: row.enabled,
    routable: row.routable,
    tools: row.tools,
    permissions: row.permissions as GrantablePermission[],
    maxToolCalls: row.maxToolCalls,
    autonomousMode: row.autonomousMode,
    trustedTools: row.trustedTools,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTaskStepDto(row: TaskStep): TaskStepDto {
  return {
    id: row.id,
    index: row.index,
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    output: row.output,
    error: row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
  };
}

export function toTaskDto(row: TaskWithAgent, steps: TaskStep[], lastEventId = 0): TaskDto {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    agent: row.agent,
    routing: row.routing,
    conversationId: row.conversationId,
    projectId: row.projectId,
    projectName: row.projectName,
    parentTaskId: row.parentTaskId,
    depth: row.depth,
    provider: row.provider,
    model: row.model,
    modelOverride: row.modelOverride,
    result: row.result,
    error: row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    attempt: row.attempt,
    retryOfTaskId: row.retryOfTaskId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    progress: { completed: steps.filter((s) => s.status === "completed").length, total: steps.length },
    pauseRequested: row.pauseRequestedAt !== null,
    lastEventId,
  };
}

export function toToolCallDto(row: ToolCall): ToolCallDto {
  return {
    id: row.id,
    stepId: row.stepId,
    toolName: row.toolName,
    category: row.category,
    permission: row.permission,
    status: row.status,
    input: row.input,
    output: row.output,
    summary: row.summary,
    error: row.error,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export function toTaskWithStepsDto(
  row: TaskWithAgent,
  steps: TaskStep[],
  lastEventId = 0,
  toolCalls: ToolCall[] = [],
  screenshots: ScreenshotMeta[] = [],
  subTasks: TaskWithAgent[] = [],
): TaskWithStepsDto {
  return {
    ...toTaskDto(row, steps, lastEventId),
    steps: steps.map(toTaskStepDto),
    toolCalls: toolCalls.map(toToolCallDto),
    screenshots: screenshots.map(toScreenshotDto),
    subTasks: subTasks.map(toSubTaskDto),
  };
}

/** A task this one delegated to another agent (spec §28). */
export function toSubTaskDto(row: TaskWithAgent): SubTaskDto {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    agent: row.agent,
    result: row.result,
    error: row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCostUsd: row.estimatedCostUsd,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toScreenshotDto(row: ScreenshotMeta): ScreenshotDto {
  return {
    id: row.id,
    toolCallId: row.toolCallId,
    url: row.url,
    title: row.title,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    reason: row.reason,
    source: row.source === "computer" ? "computer" : "browser",
    createdAt: row.createdAt.toISOString(),
  };
}

export function toApprovalDto(row: ApprovalRequest, context: { agentName?: string | null; taskPrompt?: string } = {}): ApprovalRequestDto {
  return {
    id: row.id,
    taskId: row.taskId,
    toolCallId: row.toolCallId,
    agent: row.agentId ? { id: row.agentId, name: context.agentName ?? "Agent" } : null,
    toolName: row.toolName,
    permission: row.permission as ToolPermissionLevel,
    action: row.action,
    input: row.input,
    status: row.status,
    scope: (row.scope as ApprovalScope | null) ?? null,
    reason: row.reason,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(context.taskPrompt ? { taskPrompt: context.taskPrompt } : {}),
  };
}
