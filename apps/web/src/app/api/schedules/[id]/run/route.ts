import { getDatabase, getScheduleForUser, insertScheduleRun, updateScheduleForUser, writeAuditLog } from "@aiw/database";
import { startScheduleTask } from "@aiw/scheduler";
import { getAgentServices } from "@/server/agents";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid } from "@/server/http";
import { toScheduleRunDto } from "@/server/schedules";
import { requireApiSession } from "@/server/session";

/** POST /api/schedules/:id/run — start the schedule's task now, without changing when it next runs. */
export async function POST(request: Request, ctx: RouteContext<"/api/schedules/[id]/run">): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const { id } = await ctx.params;
    if (!isUuid(id)) throw new HttpError(404, "not_found", "Schedule not found.");
    const db = getDatabase();
    const schedule = await getScheduleForUser(db, user.id, id);
    if (!schedule) throw new HttpError(404, "not_found", "Schedule not found.");

    const now = new Date();
    // The same start as the ticker: into the schedule's own conversation.
    const created = await startScheduleTask(db, getAgentServices().tasks, schedule);
    // runCount covers every run in the history, manual ones included — the
    // list said "0 run(s)" beside a history holding several.
    await updateScheduleForUser(db, user.id, id, {
      lastRunAt: now,
      lastTaskId: created.taskId,
      runCount: schedule.runCount + 1,
    });
    const run = await insertScheduleRun(db, {
      scheduleId: id,
      userId: user.id,
      taskId: created.taskId,
      status: "started",
      detail: "Run now",
      scheduledFor: now,
    });
    await writeAuditLog(db, { userId: user.id, action: "schedule.ran", resourceType: "schedule", resourceId: id, metadata: { taskId: created.taskId } });
    return Response.json({ run: toScheduleRunDto(run), taskId: created.taskId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
