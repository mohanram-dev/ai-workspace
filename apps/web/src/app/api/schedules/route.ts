import { createSchedule, getAgentForUser, getDatabase, getProjectForUser, getScheduleForUser, listSchedulesForUser, writeAuditLog } from "@aiw/database";
import { createScheduleSchema } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { computeNextRun, toScheduleDto } from "@/server/schedules";
import { requireApiSession } from "@/server/session";

/** GET /api/schedules — the user's schedules with their next run. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const schedules = await listSchedulesForUser(getDatabase(), user.id);
    return Response.json({ schedules: schedules.map(toScheduleDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/schedules — create a schedule and work out when it first runs. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createScheduleSchema);
    const db = getDatabase();

    if (input.agentId && !(await getAgentForUser(db, user.id, input.agentId))) throw new HttpError(404, "not_found", "Agent not found.");
    if (input.projectId && !(await getProjectForUser(db, user.id, input.projectId))) throw new HttpError(404, "not_found", "Project not found.");

    const runAt = input.runAt ? new Date(input.runAt) : null;
    const settings = { ...input, runAt };
    const next = input.enabled ? computeNextRun(settings) : null;
    if (input.enabled && input.trigger === "once" && !next) throw new HttpError(400, "bad_request", "That time is in the past.");

    const schedule = await createSchedule(db, {
      userId: user.id,
      name: input.name,
      prompt: input.prompt,
      agentId: input.agentId ?? null,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
      timezone: input.timezone,
      enabled: input.enabled,
      trigger: input.trigger,
      cron: input.cron ?? null,
      intervalMinutes: input.intervalMinutes ?? null,
      timeOfDay: input.timeOfDay ?? null,
      weekday: input.weekday ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      runAt,
      nextRunAt: next,
    });
    await writeAuditLog(db, { userId: user.id, action: "schedule.created", resourceType: "schedule", resourceId: schedule.id, metadata: { name: schedule.name, trigger: schedule.trigger } });
    const withNames = await getScheduleForUser(db, user.id, schedule.id);
    return Response.json(toScheduleDto(withNames!), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
