import { z } from "zod";
import {
  createTask,
  getTask,
  listAgentsForUser,
  listSubTasks,
  type Agent,
  type Database,
} from "@aiw/database";
import type { TaskStatus } from "@aiw/shared";
import { ToolError, type AnyToolDefinition, type ToolContext } from "@aiw/tools";

export interface DelegationLimits {
  /** How many levels of delegation are allowed. 1 = a manager may delegate, its helpers may not. */
  maxDepth: number;
  /** How many sub-tasks one task may start. */
  maxDelegationsPerTask: number;
  /** Ceiling for one sub-task, whatever the sub-agent's own limit says. */
  maxSubTaskSeconds: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
  maxDepth: 1,
  maxDelegationsPerTask: 5,
  maxSubTaskSeconds: 600,
};

export interface DelegationDeps {
  db: Database;
  limits?: Partial<DelegationLimits>;
  /** Runs the sub-task to completion. Provided lazily because the runtime owns this tool. */
  run: (taskId: string, signal: AbortSignal) => Promise<TaskStatus | null>;
}

const MAX_RESULT_CHARS = 12_000;

/**
 * Agent-to-agent delegation (spec §28). A manager agent hands one piece of work
 * to a specialist: the sub-task is a real task with its own agent, tools,
 * permissions, timeline and cost, linked to its parent. Limits on depth, count
 * and time keep delegation from running away.
 */
export function createDelegationTools(deps: DelegationDeps): AnyToolDefinition[] {
  const limits = { ...DEFAULT_DELEGATION_LIMITS, ...deps.limits };

  const tool: AnyToolDefinition = {
    name: "agent.delegate",
    description:
      "Hand one self-contained piece of work to another agent and wait for its result. Give the agent's slug and a complete instruction: it cannot see this conversation, so include everything it needs. Use it for work that needs a specialist's tools, not for things you can do yourself.",
    category: "agent",
    inputSchema: z.object({
      agent: z.string().trim().min(1).max(60).describe("The slug of the agent to delegate to, e.g. research"),
      task: z.string().trim().min(1).max(4000).describe("A complete, self-contained instruction"),
      context: z.string().trim().max(4000).optional().describe("Facts the agent needs that it cannot look up"),
    }),
    permission: "EXECUTE",
    timeoutMs: limits.maxSubTaskSeconds * 1000,
    availability: () => ({ available: true }),
    execute: async (input: { agent: string; task: string; context?: string }, context: ToolContext) => {
      const { db } = deps;
      const parent = await getTask(db, context.taskId);
      if (!parent) throw new ToolError("unavailable", "This task no longer exists.");

      if (parent.depth >= limits.maxDepth) {
        throw new ToolError(
          "permission_denied",
          `Delegation is only allowed ${limits.maxDepth} level(s) deep, and this task is already at level ${parent.depth}. Do this work yourself.`,
        );
      }
      const existing = await listSubTasks(db, parent.id);
      if (existing.length >= limits.maxDelegationsPerTask) {
        throw new ToolError(
          "permission_denied",
          `This task has already delegated ${existing.length} times, which is the limit. Finish with what you have.`,
        );
      }

      const agent = await findAgent(db, parent.userId, input.agent);
      if (!agent) {
        const available = (await listAgentsForUser(db, parent.userId)).filter((a) => a.enabled && a.id !== parent.agentId);
        throw new ToolError("not_found", `There is no enabled agent called "${input.agent}". Available: ${available.map((a) => a.slug).join(", ") || "none"}.`);
      }
      if (agent.id === parent.agentId) throw new ToolError("invalid_input", "An agent cannot delegate to itself.");

      const prompt = input.context ? `${input.task}\n\nContext from the agent that asked:\n${input.context}` : input.task;
      const subTask = await createTask(db, {
        userId: parent.userId,
        agentId: agent.id,
        conversationId: parent.conversationId,
        projectId: parent.projectId,
        parentTaskId: parent.id,
        depth: parent.depth + 1,
        prompt,
        status: "queued",
      });
      context.report({ type: "TASK_DELEGATED", taskId: subTask.id, agentId: agent.id, agentName: agent.name, instruction: input.task });

      // The sub-task shares the parent's stop signal and is bounded by the tool timeout.
      const status = await deps.run(subTask.id, context.signal).catch(() => null);
      const finished = await getTask(db, subTask.id);
      const outcome = finished?.status ?? status ?? "failed";
      context.report({
        type: "SUBTASK_FINISHED",
        taskId: subTask.id,
        agentName: agent.name,
        status: outcome,
        inputTokens: finished?.inputTokens ?? 0,
        outputTokens: finished?.outputTokens ?? 0,
      });

      if (outcome !== "completed") {
        // Leave the sub-task visible with its own error; tell the manager plainly.
        const reason = finished?.error?.message ?? "The sub-task did not finish.";
        return {
          output: { taskId: subTask.id, agent: agent.slug, status: outcome, error: reason },
          summary: `${agent.name} did not finish: ${reason.slice(0, 80)}`,
          content: `The ${agent.name} did not complete the work (${outcome}). ${reason} Decide whether to do it yourself, try a different agent, or report the problem.`,
        };
      }

      const result = finished?.result ?? "";
      return {
        output: {
          taskId: subTask.id,
          agent: agent.slug,
          status: outcome,
          inputTokens: finished?.inputTokens ?? 0,
          outputTokens: finished?.outputTokens ?? 0,
          estimatedCostUsd: finished?.estimatedCostUsd ?? null,
        },
        summary: `${agent.name} finished: ${firstLine(result)}`,
        content: [`Result from the ${agent.name}:`, "", clip(result, MAX_RESULT_CHARS)].join("\n"),
      };
    },
  };
  return [tool];
}

async function findAgent(db: Database, userId: string, nameOrSlug: string): Promise<Agent | null> {
  const agents = await listAgentsForUser(db, userId);
  const wanted = nameOrSlug.trim().toLowerCase();
  return agents.find((a) => a.enabled && (a.slug.toLowerCase() === wanted || a.name.toLowerCase() === wanted || a.id === nameOrSlug)) ?? null;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "no result";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

export const DELEGATION_TOOL_NAMES = ["agent.delegate"] as const;
