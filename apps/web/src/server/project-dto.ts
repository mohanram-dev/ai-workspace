import type { Memory, ProjectWithCounts } from "@aiw/database";
import type { MemoryDto, ProjectDto } from "@aiw/shared";

export function toProjectDto(row: ProjectWithCounts): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archivedAt !== null,
    conversationCount: row.conversationCount,
    taskCount: row.taskCount,
    memoryCount: row.memoryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMemoryDto(row: Memory, scopeName?: string | null): MemoryDto {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    agentId: row.agentId,
    conversationId: row.conversationId,
    key: row.key,
    value: row.value,
    source: row.source,
    taskId: row.taskId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(scopeName !== undefined ? { scopeName } : {}),
  };
}
