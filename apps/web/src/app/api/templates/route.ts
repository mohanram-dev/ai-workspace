import { countTemplatesForUser, createTemplate, getDatabase, getTemplateForUser, listTemplatesForUser } from "@aiw/database";
import { createTemplateSchema, MAX_TEMPLATES_PER_USER } from "@aiw/shared";
import { getServerEnv } from "@/server/env";
import { assertSameOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { assertOwnAgentAndProject } from "@/server/ownership";
import { toTemplateDto } from "@/server/templates";

/** GET /api/templates — the user's saved prompts, most recently used first. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const templates = await listTemplatesForUser(getDatabase(), user.id);
    return Response.json({ templates: templates.map(toTemplateDto) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/templates — save a prompt for reuse. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request, getServerEnv().APP_URL);
    const { user } = await requireApiSession(request);
    const input = await readJson(request, createTemplateSchema);
    const db = getDatabase();
    await assertOwnAgentAndProject(db, user.id, input);
    if ((await countTemplatesForUser(db, user.id)) >= MAX_TEMPLATES_PER_USER) {
      throw new HttpError(409, "conflict", `You already have ${MAX_TEMPLATES_PER_USER} templates. Delete one to save another.`);
    }

    const template = await createTemplate(db, {
      userId: user.id,
      name: input.name,
      prompt: input.prompt,
      agentId: input.agentId ?? null,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
    });
    return Response.json(toTemplateDto((await getTemplateForUser(db, user.id, template.id))!), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
