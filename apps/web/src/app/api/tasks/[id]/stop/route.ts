import { handleTaskControl } from "@/server/task-control";

/** POST /api/tasks/:id/stop */
export function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/stop">): Promise<Response> {
  return handleTaskControl(request, ctx.params, "stop");
}
