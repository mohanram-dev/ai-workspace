import { deleteScheduleForUser, getAgentForUser, getDatabase, getProjectForUser, getScheduleForUser, listScheduleRuns, updateScheduleForUser, writeAuditLog } from "@aiw/database";
import { updateScheduleSchema, type ScheduleWithRunsDto } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "@/server/http";
import { computeNextRun, toScheduleDto, toScheduleRunDto } from "@/server/schedules";
import { requireApiSession } from "@/server/session";

type Context = RouteContext<"/api/schedules/[id]">;

async function scheduleId(ctx: Context): Promise<string> {
  const { id } = await ctx.params;
  if (!isUuid(id)) throw new HttpError(404, "not_found", "Schedule not found.");
  return id;
}

/** GET /api/schedules/:id — schedule with its recent runs. */
export async function GET(request: Request, ctx: Context): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const db = getDatabase();
    const id = await scheduleId(ctx);
    const schedule = await getScheduleForUser(db, user.id, id);
    if (!schedule) throw new HttpError(404, "not_found", "Schedule not found.");
    const runs = await listScheduleRuns(db, id);
    const body: ScheduleWithRunsDto = { ...toScheduleDto(schedule), runs: runs.map(toScheduleRunDto) };
    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH /api/schedules/:id — any trigger change recomputes the next run. */
export async function PATCH(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await scheduleId(ctx);
    const changes = await readJson(request, updateScheduleSchema);
    const db = getDatabase();
    const existing = await getScheduleForUser(db, user.id, id);
    if (!existing) throw new HttpError(404, "not_found", "Schedule not found.");
    if (changes.agentId && !(await getAgentForUser(db, user.id, changes.agentId))) throw new HttpError(404, "not_found", "Agent not found.");
    if (changes.projectId && !(await getProjectForUser(db, user.id, changes.projectId))) throw new HttpError(404, "not_found", "Project not found.");

    const merged = {
      trigger: changes.trigger ?? existing.trigger,
      timezone: changes.timezone ?? existing.timezone,
      cron: changes.cron !== undefined ? changes.cron : existing.cron,
      intervalMinutes: changes.intervalMinutes !== undefined ? changes.intervalMinutes : existing.intervalMinutes,
      timeOfDay: changes.timeOfDay !== undefined ? changes.timeOfDay : existing.timeOfDay,
      weekday: changes.weekday !== undefined ? changes.weekday : existing.weekday,
      dayOfMonth: changes.dayOfMonth !== undefined ? changes.dayOfMonth : existing.dayOfMonth,
      runAt: changes.runAt !== undefined ? (changes.runAt ? new Date(changes.runAt) : null) : existing.runAt,
    };
    const enabled = changes.enabled ?? existing.enabled;
    const next = enabled ? computeNextRun(merged) : null;

    const updated = await updateScheduleForUser(db, user.id, id, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.prompt !== undefined ? { prompt: changes.prompt } : {}),
      ...(changes.agentId !== undefined ? { agentId: changes.agentId ?? null } : {}),
      ...(changes.projectId !== undefined ? { projectId: changes.projectId ?? null } : {}),
      ...(changes.model !== undefined ? { model: changes.model ?? null } : {}),
      ...merged,
      enabled,
      nextRunAt: next,
    });
    if (!updated) throw new HttpError(404, "not_found", "Schedule not found.");
    await writeAuditLog(db, { userId: user.id, action: "schedule.updated", resourceType: "schedule", resourceId: id, metadata: { fields: Object.keys(changes) } });
    return Response.json(toScheduleDto((await getScheduleForUser(db, user.id, id))!));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, ctx: Context): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const id = await scheduleId(ctx);
    const db = getDatabase();
    if (!(await deleteScheduleForUser(db, user.id, id))) throw new HttpError(404, "not_found", "Schedule not found.");
    await writeAuditLog(db, { userId: user.id, action: "schedule.deleted", resourceType: "schedule", resourceId: id });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
