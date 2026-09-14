import { getDatabase, listTasksForUser, listTaskStepsForTasks } from "@aiw/database";
import { createTaskSchema, listTasksQuerySchema, type CreateTaskResponse, type TaskStatus } from "@aiw/shared";
import { toTaskDto } from "@/server/agent-dto";
import { getAgentServices } from "@/server/agents";
import { getChatRateLimiter } from "@/server/chat/deps";
import { toConversationDto, toMessageDto } from "@/server/dto";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

const STATUS_FILTERS: Record<string, TaskStatus[] | undefined> = {
  all: undefined,
  active: ["queued", "planning", "running", "waiting_for_tool", "waiting_for_approval", "paused"],
  completed: ["completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

/** GET /api/tasks?status=all|active|completed|failed|cancelled&limit= */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const query = listTasksQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, "bad_request", "Invalid query parameters.");

    const db = getDatabase();
    const tasks = await listTasksForUser(db, user.id, { statuses: STATUS_FILTERS[query.data.status], limit: query.data.limit });
    const steps = await listTaskStepsForTasks(db, tasks.map((t) => t.id));
    return Response.json({ tasks: tasks.map((t) => toTaskDto(t, steps.filter((s) => s.taskId === t.id))) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/tasks — create an agent task (auto-routed unless agentId is given). Runs in the background. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);

    const limit = getChatRateLimiter().check(user.id);
    if (!limit.allowed) {
      throw new HttpError(429, "rate_limited", "Too many requests. Please wait a moment.", undefined, {
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }

    const input = await readJson(request, createTaskSchema);
    const created = await getAgentServices().tasks.createTask(user.id, input);
    const body: CreateTaskResponse = {
      task: toTaskDto(created.task, []),
      conversationId: created.conversation.id,
      conversationTitle: toConversationDto(created.conversation).title,
      userMessage: toMessageDto(created.userMessage),
      assistantMessage: toMessageDto(created.assistantMessage),
    };
    return Response.json(body, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
