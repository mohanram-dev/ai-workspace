import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { McpServerDetail } from "@/features/mcp/mcp-server-detail";
import { isUuid } from "@/server/http";
import { getMcpCapabilities, loadMcpServerWithTools } from "@/server/mcp";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "MCP server" };

export default async function Page({ params }: PageProps<"/mcp/[serverId]">) {
  const { serverId } = await params;
  if (!isUuid(serverId)) notFound();
  const { user } = await requirePageSession();
  const server = await loadMcpServerWithTools(user.id, serverId);
  if (!server) notFound();
  return <McpServerDetail key={server.id} initial={server} capabilities={getMcpCapabilities(user)} />;
}
