import { handleTaskControl } from "@/server/task-control";

/** POST /api/tasks/:id/retry */
export function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/retry">): Promise<Response> {
  return handleTaskControl(request, ctx.params, "retry");
}
