import type { Metadata } from "next";
import { McpPage } from "@/features/mcp/mcp-page";
import { getMcpCapabilities } from "@/server/mcp";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "MCP Tools" };

export default async function Page() {
  const { user } = await requirePageSession();
  return <McpPage capabilities={getMcpCapabilities(user)} />;
}
