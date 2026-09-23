import { getAgentForUser, getProjectForUser, type Database, type PromptTemplateWithNames } from "@aiw/database";
import { templateVariables, type TemplateDto } from "@aiw/shared";
import { HttpError } from "./http";

export function toTemplateDto(row: PromptTemplateWithNames): TemplateDto {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    agent: row.agentId ? { id: row.agentId, name: row.agentName ?? "Agent" } : null,
    project: row.projectId ? { id: row.projectId, name: row.projectName ?? "Project" } : null,
    model: row.model,
    variables: templateVariables(row.prompt),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A template may only point at the user's own agent and project. */
export async function assertTemplateTargets(db: Database, userId: string, input: { agentId?: string | null; projectId?: string | null }): Promise<void> {
  if (input.agentId && !(await getAgentForUser(db, userId, input.agentId))) throw new HttpError(404, "not_found", "Agent not found.");
  if (input.projectId && !(await getProjectForUser(db, userId, input.projectId))) throw new HttpError(404, "not_found", "Project not found.");
}
