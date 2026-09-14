import type { TaskBusMessage, TaskEventBus } from "@aiw/agents";
import type { TaskEvent } from "@aiw/shared";
import type { Redis } from "ioredis";
import { KEY_PREFIX } from "./connection";

type Listener = (message: TaskBusMessage) => void;

function channel(taskId: string): string {
  return `${KEY_PREFIX}:task:${taskId}`;
}

/** One channel per user carries their Activity feed, so no filtering is needed on receipt. */
function userChannel(userId: string): string {
  return `${KEY_PREFIX}:user:${userId}`;
}

function taskIdOf(message: TaskBusMessage): string {
  switch (message.kind) {
    case "event":
      return message.event.taskId;
    case "delta":
      return message.delta.taskId;
    case "terminal":
      return message.output.taskId;
    default:
      return message.frame.taskId;
  }
}

/**
 * Task events across processes (spec §44). The worker publishes; every web
 * process holding an SSE stream for that task receives it. One subscriber
 * connection is shared by all listeners in this process, because a subscribed
 * Redis connection cannot be used for anything else.
 */
export class RedisTaskEventBus implements TaskEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly userListeners = new Map<string, Set<(event: TaskEvent) => void>>();
  private subscribed = false;

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {}

  private ensureHandler(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.subscriber.on("message", (name: string, payload: string) => {
      if (name.startsWith(`${KEY_PREFIX}:user:`)) {
        this.deliverToUser(name.slice(`${KEY_PREFIX}:user:`.length), payload);
        return;
      }
      const taskId = name.slice(`${KEY_PREFIX}:task:`.length);
      const set = this.listeners.get(taskId);
      if (!set?.size) return;
      let message: TaskBusMessage;
      try {
        message = JSON.parse(payload) as TaskBusMessage;
      } catch (error) {
        console.error("Dropped an unreadable task bus message", error);
        return;
      }
      for (const listener of set) {
        try {
          listener(message);
        } catch (error) {
          console.error("Task event listener failed", error);
        }
      }
    });
  }

  private deliverToUser(userId: string, payload: string): void {
    const set = this.userListeners.get(userId);
    if (!set?.size) return;
    let event: TaskEvent;
    try {
      event = JSON.parse(payload) as TaskEvent;
    } catch (error) {
      console.error("Dropped an unreadable activity event", error);
      return;
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch (error) {
        console.error("Activity feed listener failed", error);
      }
    }
  }

  publish(message: TaskBusMessage, userId?: string): void {
    // Fire and forget: a dropped live update must never fail the task, and every
    // event is already persisted in task_event before it is published.
    const payload = JSON.stringify(message);
    void this.publisher.publish(channel(taskIdOf(message)), payload).catch((error: unknown) => {
      console.error("Could not publish a task event", error);
    });
    // Only recorded events belong in the Activity feed; output deltas and
    // preview frames are high volume and meaningless there.
    if (userId && message.kind === "event") {
      void this.publisher.publish(userChannel(userId), JSON.stringify(message.event)).catch((error: unknown) => {
        console.error("Could not publish an activity event", error);
      });
    }
  }

  subscribeUser(userId: string, listener: (event: TaskEvent) => void): () => void {
    this.ensureHandler();
    let set = this.userListeners.get(userId);
    if (!set) {
      set = new Set();
      this.userListeners.set(userId, set);
      void this.subscriber.subscribe(userChannel(userId)).catch((error: unknown) => {
        console.error(`Could not subscribe to the activity feed for ${userId}`, error);
      });
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.userListeners.delete(userId);
        void this.subscriber.unsubscribe(userChannel(userId)).catch(() => {});
      }
    };
  }

  subscribe(taskId: string, listener: Listener): () => void {
    this.ensureHandler();
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
      void this.subscriber.subscribe(channel(taskId)).catch((error: unknown) => {
        console.error(`Could not subscribe to task ${taskId}`, error);
      });
    }
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(taskId);
        void this.subscriber.unsubscribe(channel(taskId)).catch(() => {});
      }
    };
  }
}
