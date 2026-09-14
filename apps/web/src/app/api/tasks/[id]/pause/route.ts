import { handleTaskControl } from "@/server/task-control";

/** POST /api/tasks/:id/pause */
export function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/pause">): Promise<Response> {
  return handleTaskControl(request, ctx.params, "pause");
}
