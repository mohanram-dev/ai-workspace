import {
  getActivityTotals,
  getDatabase,
  listAgentActivity,
  listDailyTaskCounts,
  listErrorBreakdown,
  listModelUsage,
  listToolUsage,
} from "@aiw/database";
import { activityRangeStart, isActivityRange, type ActivityDto, type ActivityRange } from "@aiw/shared";
import { errorResponse } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** The earliest row anyone could have: "all time" still needs a lower bound for the queries. */
const EPOCH = new Date(0);

/** GET /api/activity?range=24h|7d|30d|all — the observability figures for the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const requested = new URL(request.url).searchParams.get("range") ?? "7d";
    const range: ActivityRange = isActivityRange(requested) ? requested : "7d";
    const start = activityRangeStart(range);
    const since = start ?? EPOCH;

    const db = getDatabase();
    const [totals, agents, models, tools, errors, daily] = await Promise.all([
      getActivityTotals(db, user.id, since),
      listAgentActivity(db, user.id, since),
      listModelUsage(db, user.id, since),
      listToolUsage(db, user.id, since),
      listErrorBreakdown(db, user.id, since),
      listDailyTaskCounts(db, user.id, since),
    ]);

    const body: ActivityDto = {
      range,
      since: start?.toISOString() ?? null,
      totals,
      agents,
      models,
      tools,
      errors: errors.map((e) => ({ ...e, lastAt: new Date(e.lastAt).toISOString() })),
      daily,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
