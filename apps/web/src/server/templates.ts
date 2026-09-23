import type { PromptTemplateWithNames } from "@aiw/database";
import { templateVariables, type TemplateDto } from "@aiw/shared";

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
