import { getDatabase, getLastTaskEventId, getTaskForUser, listTaskSteps, listScreenshotsForTask, listToolCallsForTask } from "@aiw/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TaskDetail } from "@/features/tasks/task-detail";
import { toTaskWithStepsDto } from "@/server/agent-dto";
import { isUuid } from "@/server/http";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Task" };

export default async function Page({ params }: PageProps<"/tasks/[taskId]">) {
  const { taskId } = await params;
  if (!isUuid(taskId)) notFound();
  const { user } = await requirePageSession();
  const db = getDatabase();
  const task = await getTaskForUser(db, user.id, taskId);
  if (!task) notFound();
  const [steps, lastEventId, toolCalls, screenshots] = await Promise.all([
    listTaskSteps(db, task.id),
    getLastTaskEventId(db, task.id),
    listToolCallsForTask(db, task.id),
    listScreenshotsForTask(db, task.id),
  ]);
  return <TaskDetail key={task.id} initial={toTaskWithStepsDto(task, steps, lastEventId, toolCalls, screenshots)} />;
}
