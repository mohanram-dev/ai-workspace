import { handleTaskControl } from "@/server/task-control";

/** POST /api/tasks/:id/continue */
export function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/continue">): Promise<Response> {
  return handleTaskControl(request, ctx.params, "continue");
}
