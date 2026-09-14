import { createProject, getDatabase, listProjectsForUser, writeAuditLog } from "@aiw/database";
import { createProjectSchema } from "@aiw/shared";
import { toProjectDto } from "@/server/project-dto";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";

/** GET /api/projects?archived=true — the user's projects with their item counts. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const archived = new URL(request.url).searchParams.get("archived") === "true";
    const projects = await listProjectsForUser(getDatabase(), user.id, { archived });
    return Response.json({ projects: projects.map(toProjectDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/projects — create a project. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createProjectSchema);
    const db = getDatabase();
    const project = await createProject(db, { ownerId: user.id, name: input.name, description: input.description });
    await writeAuditLog(db, { userId: user.id, action: "project.created", resourceType: "project", resourceId: project.id, metadata: { name: project.name } });
    return Response.json(toProjectDto({ ...project, conversationCount: 0, taskCount: 0, memoryCount: 0 }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
