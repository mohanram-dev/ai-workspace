import {
  AgentRuntime,
  ApprovalService,
  InMemoryTaskEventBus,
  InProcessTaskExecutor,
  TaskEventRecorder,
  TaskService,
  type TaskEventBus,
  type TaskExecutor,
} from "@aiw/agents";
import { getDatabase } from "@aiw/database";
import { getBrowserManager } from "./browser";
import { getComputerManager } from "./computer";
import { getServerEnv } from "./env";
import { getProviderRegistry } from "./providers";
import { getMcpServices } from "./mcp";
import { getQueueRuntime } from "./queue";
import { getToolRegistry, getWorkspaceRoot } from "./tools";

export interface AgentServices {
  approvals: ApprovalService;
  bus: TaskEventBus;
  events: TaskEventRecorder;
  runtime: AgentRuntime;
  executor: TaskExecutor;
  tasks: TaskService;
  /** True when tasks run in a separate worker process (REDIS_URL is set). */
  queued: boolean;
}

const globalForAgents = globalThis as unknown as { __aiwAgents?: AgentServices };

/**
 * Event bus, agent runtime, executor and task service, shared by the web server
 * and the worker so both build agents the same way.
 *
 * Without REDIS_URL everything runs in this process (in-memory bus, in-process
 * executor). With it, events go over Redis and execution is handed to the
 * worker tier over BullMQ; the code that creates and runs a task is identical
 * either way.
 */
export function getAgentServices(): AgentServices {
  if (!globalForAgents.__aiwAgents) {
    const env = getServerEnv();
    const db = getDatabase();
    const registry = getProviderRegistry();
    const queue = getQueueRuntime();
    const bus: TaskEventBus = queue ? queue.bus : new InMemoryTaskEventBus();
    const approvals = new ApprovalService({ db, timeoutMs: env.APPROVAL_TIMEOUT_MINUTES * 60_000 });
    const events = new TaskEventRecorder(db, bus);
    const runtime = new AgentRuntime({
      db,
      registry,
      events,
      tools: getToolRegistry(),
      approvals,
      toolSources: [getMcpServices().source],
      delegation: env.DELEGATION_ENABLED
        ? {
            maxDepth: env.MAX_DELEGATION_DEPTH,
            maxDelegationsPerTask: env.MAX_DELEGATIONS_PER_TASK,
            maxSubTaskSeconds: env.MAX_SUBTASK_SECONDS,
          }
        : false,
      onTaskEnd: async (taskId) => {
        await Promise.all([getBrowserManager().close(taskId), getComputerManager().close(taskId)]);
      },
      workspaceRoot: getWorkspaceRoot(),
      routerModel: env.ROUTER_MODEL,
      modelFallbacks: env.MODEL_FALLBACKS,
    });
    // The delegation tool is owned by the runtime (it starts sub-tasks through it);
    // registering it here is what makes it appear when assigning tools to an agent.
    for (const tool of runtime.delegationTools) getToolRegistry().register(tool);
    const executor: TaskExecutor = queue ? queue.executor : new InProcessTaskExecutor(runtime);
    const tasks = new TaskService({
      db,
      registry,
      executor,
      events,
      maxRunningTasksPerUser: env.MAX_RUNNING_TASKS_PER_USER,
    });
    globalForAgents.__aiwAgents = { approvals, bus, events, runtime, executor, tasks, queued: queue !== null };
  }
  return globalForAgents.__aiwAgents;
}
