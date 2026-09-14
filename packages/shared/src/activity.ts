/** Windows the Activity dashboard can be read over. */
export const ACTIVITY_RANGES = ["24h", "7d", "30d", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const ACTIVITY_RANGE_LABELS: Record<ActivityRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

export interface ActivityTotalsDto {
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Tasks running right now, regardless of the window. */
  running: number;
  /** Completed ÷ finished, or null when nothing has finished in the window. */
  successRate: number | null;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  failedToolCalls: number;
  activeAgents: number;
}

export interface AgentActivityDto {
  agentId: string;
  agentName: string;
  agentSlug: string;
  tasks: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  avgDurationMs: number | null;
}

export interface ModelUsageDto {
  provider: string;
  model: string;
  /** chat | routing | planning | step | tool */
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ToolUsageDto {
  toolName: string;
  category: string | null;
  calls: number;
  failed: number;
  denied: number;
  avgDurationMs: number | null;
}

export interface ActivityErrorDto {
  title: string;
  count: number;
  lastAt: string;
}

export interface DailyTaskCountDto {
  day: string;
  total: number;
  completed: number;
  failed: number;
}

export interface ActivityDto {
  range: ActivityRange;
  since: string | null;
  totals: ActivityTotalsDto;
  agents: AgentActivityDto[];
  models: ModelUsageDto[];
  tools: ToolUsageDto[];
  errors: ActivityErrorDto[];
  daily: DailyTaskCountDto[];
}

export function isActivityRange(value: string): value is ActivityRange {
  return (ACTIVITY_RANGES as readonly string[]).includes(value);
}

/** The oldest timestamp a range covers; null means everything. */
export function activityRangeStart(range: ActivityRange, now = new Date()): Date | null {
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : range === "30d" ? 24 * 30 : null;
  return hours === null ? null : new Date(now.getTime() - hours * 60 * 60 * 1000);
}
