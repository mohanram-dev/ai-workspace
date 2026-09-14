import type { ToolInfoDto } from "@aiw/shared";
import { errorResponse } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { describeMcpToolsForUser } from "@/server/mcp";
import { getToolRegistry } from "@/server/tools";

/** GET /api/tools — built-in tools and the user's MCP tools, and whether each can be used. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireApiSession(request);
    const tools: ToolInfoDto[] = [...getToolRegistry().describe(), ...(await describeMcpToolsForUser(user.id))];
    return Response.json({ tools });
  } catch (error) {
    return errorResponse(error);
  }
}
