import { handleTaskControl } from "@/server/task-control";

/** POST /api/tasks/:id/resume */
export function POST(request: Request, ctx: RouteContext<"/api/tasks/[id]/resume">): Promise<Response> {
  return handleTaskControl(request, ctx.params, "resume");
}
