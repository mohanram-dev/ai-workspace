import type { Metadata } from "next";
import { AgentForm } from "@/features/agents/agent-form";
import { getModelOptions } from "@/server/model-options";
import { requirePageSession } from "@/server/session";
import { describeMcpToolsForUser } from "@/server/mcp";
import { getToolRegistry } from "@/server/tools";

export const metadata: Metadata = { title: "New agent" };

export default async function Page() {
  const { user } = await requirePageSession();
  const { providers, models } = await getModelOptions();
  return <AgentForm agent={null} providers={providers} models={models} tools={[...getToolRegistry().describe(), ...(await describeMcpToolsForUser(user.id))]} />;
}
