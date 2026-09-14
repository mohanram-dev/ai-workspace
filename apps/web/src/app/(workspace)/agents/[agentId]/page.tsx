import { getAgentForUser, getDatabase } from "@aiw/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgentForm } from "@/features/agents/agent-form";
import { toAgentDto } from "@/server/agent-dto";
import { isUuid } from "@/server/http";
import { getModelOptions } from "@/server/model-options";
import { requirePageSession } from "@/server/session";
import { describeMcpToolsForUser } from "@/server/mcp";
import { getToolRegistry } from "@/server/tools";

export const metadata: Metadata = { title: "Edit agent" };

export default async function Page({ params }: PageProps<"/agents/[agentId]">) {
  const { agentId } = await params;
  if (!isUuid(agentId)) notFound();
  const { user } = await requirePageSession();
  const agent = await getAgentForUser(getDatabase(), user.id, agentId);
  if (!agent) notFound();
  const { providers, models } = await getModelOptions();
  return <AgentForm key={agent.id} agent={toAgentDto(agent)} providers={providers} models={models} tools={[...getToolRegistry().describe(), ...(await describeMcpToolsForUser(user.id))]} />;
}
