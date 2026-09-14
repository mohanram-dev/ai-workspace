import {
  getDatabase,
  getProjectForUser,
  listConversations,
  listMemories,
  listTasksForUser,
} from "@aiw/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectDetail } from "@/features/projects/project-detail";
import { toTaskDto } from "@/server/agent-dto";
import { toConversationDto } from "@/server/dto";
import { isUuid } from "@/server/http";
import { toMemoryDto, toProjectDto } from "@/server/project-dto";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Project" };

export default async function Page({ params }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const { user } = await requirePageSession();
  const db = getDatabase();
  const project = await getProjectForUser(db, user.id, projectId);
  if (!project) notFound();

  const [conversations, tasks, memories] = await Promise.all([
    listConversations(db, user.id, { archived: false, limit: 100 }),
    listTasksForUser(db, user.id, { limit: 50 }),
    listMemories(db, user.id, { scope: "project", projectId }),
  ]);

  return (
    <ProjectDetail
      project={toProjectDto(project)}
      conversations={conversations.filter((row) => row.projectId === projectId).map(toConversationDto)}
      tasks={tasks.filter((row) => row.projectId === projectId).map((row) => toTaskDto(row, []))}
      memories={memories.map((row) => toMemoryDto(row))}
    />
  );
}
