import { z } from "zod";

export const PLANNING_MODES = ["auto", "always", "never"] as const;
export type PlanningMode = (typeof PLANNING_MODES)[number];

/** Permission levels an agent can be granted. READ is implicit; DESTRUCTIVE always needs approval (Phase 8). */
export const GRANTABLE_PERMISSIONS = ["WRITE", "EXECUTE", "NETWORK"] as const;
export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number];

export const AGENT_LIMITS = {
  maxToolCalls: { min: 0, max: 100 },
  maxSteps: { min: 1, max: 10 },
  maxExecutionSeconds: { min: 10, max: 3600 },
  maxOutputTokens: { min: 256, max: 65_536 },
  maxHistoryMessages: { min: 0, max: 100 },
  temperature: { min: 0, max: 2 },
} as const;

/** Editable agent configuration. */
export const agentConfigSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().max(20_000),
  provider: z.string().min(1).max(50),
  /** null = use the provider's default model. */
  model: z.string().min(1).max(200).nullable(),
  temperature: z.number().min(AGENT_LIMITS.temperature.min).max(AGENT_LIMITS.temperature.max),
  maxOutputTokens: z.number().int().min(AGENT_LIMITS.maxOutputTokens.min).max(AGENT_LIMITS.maxOutputTokens.max),
  planningMode: z.enum(PLANNING_MODES),
  maxSteps: z.number().int().min(AGENT_LIMITS.maxSteps.min).max(AGENT_LIMITS.maxSteps.max),
  maxExecutionSeconds: z
    .number()
    .int()
    .min(AGENT_LIMITS.maxExecutionSeconds.min)
    .max(AGENT_LIMITS.maxExecutionSeconds.max),
  /** null = no daily budget. */
  dailyBudgetUsd: z.number().min(0).max(10_000).nullable(),
  useConversationHistory: z.boolean(),
  maxHistoryMessages: z
    .number()
    .int()
    .min(AGENT_LIMITS.maxHistoryMessages.min)
    .max(AGENT_LIMITS.maxHistoryMessages.max),
  enabled: z.boolean(),
  /** Whether the automatic router may pick this agent. */
  routable: z.boolean(),
  /** Tool names the agent may call. */
  tools: z.array(z.string().min(1).max(200)).max(200),
  permissions: z.array(z.enum(GRANTABLE_PERMISSIONS)).max(GRANTABLE_PERMISSIONS.length),
  /** Maximum tool calls per task. */
  maxToolCalls: z.number().int().min(AGENT_LIMITS.maxToolCalls.min).max(AGENT_LIMITS.maxToolCalls.max),
  /**
   * Autonomous mode (spec §27): the agent runs the destructive tools listed in
   * trustedTools without stopping for approval. NEVER_AUTONOMOUS tools always
   * stop, whatever is listed here.
   */
  autonomousMode: z.boolean(),
  trustedTools: z.array(z.string().min(1).max(200)).max(200),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * Tools autonomous mode can never pre-approve (spec §27): they run arbitrary
 * programs, locally or on another machine, which is how a deployment, a
 * destructive command or a read of a secret would actually happen.
 */
export const NEVER_AUTONOMOUS: readonly string[] = ["terminal.run", "ssh.run"];

export const createAgentSchema = agentConfigSchema;

export const updateAgentSchema = agentConfigSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export interface AgentDto extends AgentConfig {
  id: string;
  /** Live status derived from the agent's tasks (spec §38). */
  status: "idle" | "running" | "paused";
  activeTasks: number;
  slug: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}
