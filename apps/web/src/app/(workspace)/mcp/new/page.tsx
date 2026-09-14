import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { McpServerForm } from "@/features/mcp/mcp-server-form";
import { getMcpCapabilities } from "@/server/mcp";
import { requirePageSession } from "@/server/session";

export const metadata: Metadata = { title: "Add MCP server" };

export default async function Page() {
  const { user } = await requirePageSession();
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <Link href="/mcp" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-4" /> MCP Tools
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Add MCP server</h1>
          <p className="mt-1 text-sm text-muted-foreground">The connection is tested and the server&apos;s tools are discovered when you add it.</p>
        </div>
        <McpServerForm server={null} capabilities={getMcpCapabilities(user)} />
      </div>
    </div>
  );
}
