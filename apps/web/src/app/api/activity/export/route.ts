import { getDatabase, listTasksForUser, listUsageLogsForUser } from "@aiw/database";
import { activityRangeStart, isActivityRange, type ActivityRange } from "@aiw/shared";
import { downloadHeaders, MAX_CSV_ROWS, toCsv } from "@/server/export";
import { errorResponse, HttpError } from "@/server/http";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/activity/export?kind=tasks|usage&range=24h|7d|30d|all — the
 * Activity figures' raw rows as CSV: one row per task, or one per model call.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind") ?? "tasks";
    if (kind !== "tasks" && kind !== "usage") throw new HttpError(400, "bad_request", 'kind must be "tasks" or "usage".');
    const requested = params.get("range") ?? "7d";
    const range: ActivityRange = isActivityRange(requested) ? requested : "7d";
    const since = activityRangeStart(range) ?? new Date(0);
    const db = getDatabase();
    const filename = `ai-workspace-${kind}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;

    if (kind === "tasks") {
      const tasks = await listTasksForUser(db, user.id, { since, limit: MAX_CSV_ROWS });
      const csv = toCsv(
        ["created_at", "task_id", "status", "agent", "project", "provider", "model", "input_tokens", "output_tokens", "estimated_cost_usd", "duration_ms", "attempt", "prompt"],
        tasks.map((t) => [t.createdAt.toISOString(), t.id, t.status, t.agent?.name, t.projectName, t.provider, t.model, t.inputTokens, t.outputTokens, t.estimatedCostUsd, t.durationMs, t.attempt, t.prompt]),
      );
      return new Response(csv, { headers: downloadHeaders(filename, "text/csv; charset=utf-8") });
    }

    const usage = await listUsageLogsForUser(db, user.id, since, MAX_CSV_ROWS);
    const csv = toCsv(
      ["created_at", "purpose", "provider", "model", "input_tokens", "output_tokens", "total_tokens", "estimated_cost_usd", "duration_ms", "status", "task_id", "conversation_id"],
      usage.map((u) => [u.createdAt.toISOString(), u.purpose, u.provider, u.model, u.inputTokens, u.outputTokens, u.totalTokens, u.estimatedCostUsd, u.durationMs, u.status, u.taskId, u.conversationId]),
    );
    return new Response(csv, { headers: downloadHeaders(filename, "text/csv; charset=utf-8") });
  } catch (error) {
    return errorResponse(error);
  }
}
