import { insertTaskEvent, type Database, type TaskEventRow } from "@aiw/database";
import type {
  BrowserFrameDelta,
  ComputerFrameDelta,
  StepOutputDelta,
  TerminalOutputDelta,
  TaskEvent,
  TaskEventDataMap,
  TaskEventStatus,
  TaskEventType,
} from "@aiw/shared";

export type TaskBusMessage =
  | { kind: "event"; event: TaskEvent }
  | { kind: "delta"; delta: StepOutputDelta }
  | { kind: "terminal"; output: TerminalOutputDelta }
  | { kind: "browser"; frame: BrowserFrameDelta }
  | { kind: "computer"; frame: ComputerFrameDelta };

/**
 * Publish/subscribe channel between task runners and realtime streams.
 * Phase 12 adds a Redis-backed implementation for multi-process deployments.
 */
export interface TaskEventBus {
  /** Publishes to the task channel, and to the user feed when a userId is given. */
  publish(message: TaskBusMessage, userId?: string): void;
  subscribe(taskId: string, listener: (message: TaskBusMessage) => void): () => void;
  /**
   * Every recorded event for one user, across all of their tasks, for the
   * Activity feed. Keyed by user rather than filtered after the fact, so one
   * user cannot receive another user's events.
   */
  subscribeUser(userId: string, listener: (event: TaskEvent) => void): () => void;
}

export class InMemoryTaskEventBus implements TaskEventBus {
  private readonly listeners = new Map<string, Set<(message: TaskBusMessage) => void>>();
  private readonly userListeners = new Map<string, Set<(event: TaskEvent) => void>>();

  publish(message: TaskBusMessage, userId?: string): void {
    if (userId && message.kind === "event") {
      for (const listener of this.userListeners.get(userId) ?? []) {
        try {
          listener(message.event);
        } catch (error) {
          console.error("Activity feed listener failed", error);
        }
      }
    }
    const taskId =
      message.kind === "event"
        ? message.event.taskId
        : message.kind === "delta"
          ? message.delta.taskId
          : message.kind === "terminal"
            ? message.output.taskId
            : message.frame.taskId;
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        console.error("Task event listener failed", error);
      }
    }
  }

  subscribe(taskId: string, listener: (message: TaskBusMessage) => void): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  subscribeUser(userId: string, listener: (event: TaskEvent) => void): () => void {
    let set = this.userListeners.get(userId);
    if (!set) {
      set = new Set();
      this.userListeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.userListeners.delete(userId);
    };
  }

  listenerCount(taskId: string): number {
    return this.listeners.get(taskId)?.size ?? 0;
  }
}

export function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type as TaskEventType,
    timestamp: row.createdAt.toISOString(),
    agent: row.agentId && row.agentName ? { id: row.agentId, name: row.agentName } : null,
    stepId: row.stepId,
    description: row.description,
    status: row.status as TaskEventStatus,
    toolName: row.toolName,
    durationMs: row.durationMs,
    data: row.data,
  } as TaskEvent;
}

export interface EventContext {
  taskId: string;
  userId: string;
  agent?: { id: string; name: string } | null;
  stepId?: string | null;
}

export interface EventInput<K extends TaskEventType> {
  description: string;
  status?: TaskEventStatus;
  durationMs?: number | null;
  toolName?: string;
  data: TaskEventDataMap[K];
}

/** Persists typed events and publishes them (plus ephemeral output deltas) on the bus. */
export class TaskEventRecorder {
  constructor(
    private readonly db: Database,
    readonly bus: TaskEventBus,
  ) {}

  async emit<K extends TaskEventType>(context: EventContext, type: K, input: EventInput<K>): Promise<TaskEvent | null> {
    try {
      const row = await insertTaskEvent(this.db, {
        taskId: context.taskId,
        userId: context.userId,
        type,
        agentId: context.agent?.id ?? null,
        agentName: context.agent?.name ?? null,
        stepId: context.stepId ?? null,
        description: input.description,
        status: input.status ?? "info",
        durationMs: input.durationMs ?? null,
        toolName: input.toolName ?? null,
        data: input.data as Record<string, unknown>,
      });
      const event = toTaskEvent(row);
      this.bus.publish({ kind: "event", event }, context.userId);
      return event;
    } catch (error) {
      // A missing timeline entry must never fail the task itself.
      console.error(`Failed to record ${type} for task ${context.taskId}`, error);
      return null;
    }
  }

  browserFrame(frame: BrowserFrameDelta): void {
    this.bus.publish({ kind: "browser", frame });
  }

  computerFrame(frame: ComputerFrameDelta): void {
    this.bus.publish({ kind: "computer", frame });
  }

  terminal(taskId: string, toolCallId: string, stream: "stdout" | "stderr", text: string): void {
    this.bus.publish({ kind: "terminal", output: { taskId, toolCallId, stream, text } });
  }

  delta(taskId: string, stepId: string, text: string, reset = false): void {
    this.bus.publish({ kind: "delta", delta: { taskId, stepId, text, ...(reset ? { reset: true } : {}) } });
  }
}
