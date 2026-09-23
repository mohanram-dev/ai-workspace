import { getAgentForUser, getProjectForUser, type Database } from "@aiw/database";
import { HttpError } from "./http";

/** Anything that names an agent or a project may only name the user's own. */
export async function assertOwnAgentAndProject(db: Database, userId: string, input: { agentId?: string | null; projectId?: string | null }): Promise<void> {
  if (input.agentId && !(await getAgentForUser(db, userId, input.agentId))) throw new HttpError(404, "not_found", "Agent not found.");
  if (input.projectId && !(await getProjectForUser(db, userId, input.projectId))) throw new HttpError(404, "not_found", "Project not found.");
}
