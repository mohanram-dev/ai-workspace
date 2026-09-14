import type { ProviderRegistry } from "@aiw/ai";
import {
  cancelPendingApprovalsForTasks,
  createConversation,
  createTask,
  getAgentForUser,
  getConversationForUser,
  getTaskForUser,
  insertMessage,
  listMessages,
  countRunningTasksForUser,
  requestTaskPause,
  resetUnfinishedSteps,
  touchConversation,
  updateMessagesForTask,
  updateTask,
  type Conversation,
  type Database,
  type Message,
  type TaskWithAgent,
} from "@aiw/database";
import {
  AppError,
  deriveConversationTitle,
  isActiveTaskStatus,
  STALE_STREAM_MS,
  type CreateTaskInput,
} from "@aiw/shared";
import { ensureBuiltinAgents } from "./builtin";
import type { TaskEventRecorder } from "./events";
import type { TaskExecutor } from "./executor";

export interface TaskServiceOptions {
  db: Database;
  registry: ProviderRegistry;
  executor: TaskExecutor;
  events: TaskEventRecorder;
  maxRunningTasksPerUser: number;
}

export interface CreatedTask {
  task: TaskWithAgent;
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
}

/**
 * Throws 409 if the conversation already has a reply in progress (a streaming
 * chat reply or an active agent task).
 */
export async function assertConversationIdle(db: Database, userId: string, messages: Message[]): Promise<void> {
  const last = messages.at(-1);
  if (last?.status !== "streaming") return;
  if (last.taskId) {
    const task = await getTaskForUser(db, userId, last.taskId);
    if (task && isActiveTaskStatus(task.status)) {
      throw new AppError(409, "conflict", "An agent is still working in this conversation.");
    }
    return;
  }
  if (Date.now() - last.createdAt.getTime() < STALE_STREAM_MS) {
    throw new AppError(409, "conflict", "A response is already being generated in this conversation.");
  }
}

/** Creates, continues, retries and stops agent tasks for a user. */
export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  async createTask(userId: string, input: CreateTaskInput): Promise<CreatedTask> {
    const { db, registry } = this.options;
    await ensureBuiltinAgents(db, userId);

    let agentProvider: string | undefined;
    if (input.agentId) {
      const agent = await getAgentForUser(db, userId, input.agentId);
      if (!agent) throw new AppError(404, "not_found", "Agent not found.");
      if (!agent.enabled) throw new AppError(400, "bad_request", `${agent.name} is disabled.`);
      agentProvider = agent.provider;
    }
    // Validates configuration and the override model before anything is written.
    await registry.resolveModel(input.model, agentProvider);

    await this.assertCapacity(userId);

    let conversation: Conversation;
    if (input.conversationId) {
      const existing = await getConversationForUser(db, userId, input.conversationId);
      if (!existing) throw new AppError(404, "not_found", "Conversation not found.");
      await assertConversationIdle(db, userId, await listMessages(db, existing.id));
      conversation = existing;
    } else {
      // A new conversation inherits the project the task was started in.
      conversation = await createConversation(db, {
        userId,
        title: deriveConversationTitle(input.prompt),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
    }
    if (input.projectId && conversation.projectId !== input.projectId) {
      throw new AppError(400, "bad_request", "That conversation belongs to a different project.");
    }

    const task = await createTask(db, {
      userId,
      agentId: input.agentId ?? null,
      conversationId: conversation.id,
      projectId: conversation.projectId,
      prompt: input.prompt,
      modelOverride: input.model ?? null,
      status: "queued",
    });
    const userMessage = await insertMessage(db, {
      conversationId: conversation.id,
      role: "user",
      content: input.prompt,
      status: "completed",
    });
    const assistantMessage = await insertMessage(db, {
      conversationId: conversation.id,
      taskId: task.id,
      role: "assistant",
      content: "",
      status: "streaming",
    });
    await touchConversation(db, conversation.id);
    await this.options.events.emit({ taskId: task.id, userId }, "TASK_CREATED", {
      description: input.agentId ? "Task created" : "Task created for automatic routing",
      data: { prompt: input.prompt, mode: input.agentId ? "manual" : "auto", retryOfTaskId: null },
    });

    this.options.executor.start(task.id);
    return { task: (await getTaskForUser(db, userId, task.id))!, conversation, userMessage, assistantMessage };
  }

  /** Resumes a failed or cancelled task from its first unfinished step. */
  async continueTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const { db } = this.options;
    const task = await this.getOwnedTask(userId, taskId);
    if (task.status !== "failed" && task.status !== "cancelled") {
      throw new AppError(409, "conflict", "Only failed or cancelled tasks can be continued.");
    }
    await this.assertCapacity(userId);

    await resetUnfinishedSteps(db, task.id);
    await updateTask(db, task.id, {
      status: "queued",
      error: null,
      result: null,
      completedAt: null,
      durationMs: null,
      pauseRequestedAt: null,
      attempt: task.attempt + 1,
    });
    await updateMessagesForTask(db, task.id, { status: "streaming", content: "", error: null, completedAt: null });
    if (task.conversationId) await touchConversation(db, task.conversationId);
    await this.options.events.emit(this.eventContext(task), "TASK_RESUMED", {
      description: "Continuing from the first unfinished step",
      status: "running",
      data: { reason: "continue", attempt: task.attempt + 1 },
    });

    this.options.executor.start(task.id);
    return (await getTaskForUser(db, userId, task.id))!;
  }

  /** Asks a running task to pause after its current step. */
  async pauseTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const { db } = this.options;
    const task = await this.getOwnedTask(userId, taskId);
    if (task.pauseRequestedAt) return task;
    if (!(await requestTaskPause(db, task.id))) {
      throw new AppError(409, "conflict", "Only a running task can be paused.");
    }
    await this.options.events.emit(this.eventContext(task), "TASK_PAUSE_REQUESTED", {
      description: "Pause requested; the agent will pause after the current step",
      status: "warning",
      data: {},
    });
    return (await getTaskForUser(db, userId, task.id))!;
  }

  /** Resumes a paused task from its next step. */
  async resumeTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const { db } = this.options;
    const task = await this.getOwnedTask(userId, taskId);
    if (task.status !== "paused") throw new AppError(409, "conflict", "Only a paused task can be resumed.");
    await this.assertCapacity(userId);

    await updateTask(db, task.id, { status: "queued", pauseRequestedAt: null });
    await this.options.events.emit(this.eventContext(task), "TASK_RESUMED", {
      description: "Task resumed",
      status: "running",
      data: { reason: "resume", attempt: task.attempt },
    });
    this.options.executor.start(task.id);
    return (await getTaskForUser(db, userId, task.id))!;
  }

  /** Runs the same prompt again as a new task; the conversation reply moves to the new task. */
  async retryTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const { db, registry } = this.options;
    const original = await this.getOwnedTask(userId, taskId);
    if (isActiveTaskStatus(original.status)) {
      throw new AppError(409, "conflict", "Stop the task before retrying it.");
    }
    await registry.resolveModel(original.modelOverride ?? undefined);
    await this.assertCapacity(userId);

    const manual = original.routing?.mode === "manual";
    const retry = await createTask(db, {
      userId,
      agentId: manual ? original.agentId : null,
      conversationId: original.conversationId,
      projectId: original.projectId,
      retryOfTaskId: original.id,
      attempt: original.attempt + 1,
      prompt: original.prompt,
      modelOverride: original.modelOverride,
      status: "queued",
    });
    await updateMessagesForTask(db, original.id, {
      taskId: retry.id,
      status: "streaming",
      content: "",
      error: null,
      completedAt: null,
    });
    if (original.conversationId) await touchConversation(db, original.conversationId);
    await this.options.events.emit({ taskId: retry.id, userId }, "TASK_CREATED", {
      description: `Retry of a previous attempt (attempt ${retry.attempt})`,
      data: { prompt: retry.prompt, mode: manual ? "manual" : "auto", retryOfTaskId: original.id },
    });

    this.options.executor.start(retry.id);
    return (await getTaskForUser(db, userId, retry.id))!;
  }

  async stopTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const { db } = this.options;
    const task = await this.getOwnedTask(userId, taskId);
    if (!isActiveTaskStatus(task.status)) throw new AppError(409, "conflict", "The task is not running.");

    if (!(await this.options.executor.stop(task.id))) {
      // Paused, or not running in this process (e.g. orphaned): record the cancellation directly.
      const now = new Date();
      await updateTask(db, task.id, { status: "cancelled", completedAt: now, pauseRequestedAt: null });
      await cancelPendingApprovalsForTasks(db, [task.id], "The task was stopped.");
      await updateMessagesForTask(db, task.id, { status: "cancelled", completedAt: now });
      await this.options.events.emit(this.eventContext(task), "TASK_CANCELLED", {
        description: "Task stopped",
        status: "warning",
        data: {},
      });
    }
    return (await getTaskForUser(db, userId, task.id)) ?? task;
  }

  private eventContext(task: TaskWithAgent) {
    return { taskId: task.id, userId: task.userId, agent: task.agent ? { id: task.agent.id, name: task.agent.name } : null };
  }

  private async getOwnedTask(userId: string, taskId: string): Promise<TaskWithAgent> {
    const task = await getTaskForUser(this.options.db, userId, taskId);
    if (!task) throw new AppError(404, "not_found", "Task not found.");
    return task;
  }

  private async assertCapacity(userId: string): Promise<void> {
    const running = await countRunningTasksForUser(this.options.db, userId);
    if (running >= this.options.maxRunningTasksPerUser) {
      throw new AppError(
        429,
        "rate_limited",
        `You already have ${running} running task${running === 1 ? "" : "s"}. Wait for one to finish or stop it.`,
      );
    }
  }
}

