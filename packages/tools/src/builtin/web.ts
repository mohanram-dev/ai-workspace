import { z } from "zod";
import { extractReadableText } from "../html";
import { safeFetch } from "../net";
import type { WebSearchService } from "../search";
import { ToolError, type AnyToolDefinition } from "../types";

export interface WebToolsConfig {
  allowPrivateNetwork: boolean;
  search: WebSearchService | null;
}

const fetchInput = z.object({
  url: z.string().trim().min(1).max(2048).describe("Absolute http(s) URL"),
  maxChars: z.number().int().min(500).max(100_000).default(20_000).describe("Maximum characters of page text to return"),
});

export function createWebTools(config: WebToolsConfig): AnyToolDefinition[] {
  const fetchTool = {
    name: "web.fetch",
    description:
      "Fetch a public web page or text/JSON URL and return its readable text, title and links. Does not run JavaScript or click; interactive browsing is not available.",
    category: "web",
    permission: "NETWORK",
    timeoutMs: 30_000,
    inputSchema: fetchInput,
    availability: () => ({ available: true }),
    async execute(input, context) {
      const page = await safeFetch(input.url, {
        signal: context.signal,
        timeoutMs: 25_000,
        maxBytes: 3 * 1024 * 1024,
        allowPrivateNetwork: config.allowPrivateNetwork,
      });
      const type = page.contentType.split(";")[0]!.trim().toLowerCase();
      let title: string | null = null;
      let text: string;
      let links: { text: string; url: string }[] = [];
      if (type === "text/html" || type === "application/xhtml+xml" || (!type && /<html/i.test(page.body))) {
        const extracted = extractReadableText(page.body, page.url);
        ({ title, text, links } = extracted);
      } else if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml") {
        text = page.body;
      } else {
        throw new ToolError("invalid_input", `Unsupported content type "${type || "unknown"}". Only HTML, text and JSON can be read.`);
      }

      const truncated = text.length > input.maxChars;
      const clipped = truncated ? `${text.slice(0, input.maxChars)}\n… (truncated)` : text;
      context.report({ type: "PAGE_READ", url: page.url, title, status: page.status, bytes: page.bytes });

      return {
        output: { url: page.url, status: page.status, contentType: type, title, bytes: page.bytes, truncated, text: clipped, links },
        summary: `Read ${title ? `"${title.slice(0, 80)}"` : page.url} (HTTP ${page.status})`,
        content: [
          `URL: ${page.url}`,
          `HTTP ${page.status}${title ? ` · Title: ${title}` : ""}`,
          "",
          clipped || "(no readable text)",
          links.length ? `\nLinks:\n${links.map((l) => `- ${l.text}: ${l.url}`).join("\n")}` : "",
        ].join("\n"),
      };
    },
  } satisfies AnyToolDefinition;

  const searchTool = {
    name: "web.search",
    description: "Search the web for current information. Returns an answer when available plus source links.",
    category: "web",
    permission: "NETWORK",
    timeoutMs: 45_000,
    inputSchema: z.object({ query: z.string().trim().min(2).max(400) }),
    availability: () =>
      config.search ? config.search.availability() : { available: false, reason: "No web search provider is configured (WEB_SEARCH_PROVIDER)." },
    async execute(input, context) {
      if (!config.search) throw new ToolError("unavailable", "No web search provider is configured.");
      let response;
      try {
        response = await config.search.search(input.query, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw new ToolError("cancelled", "The search was stopped.");
        const message = error instanceof Error ? error.message : "unknown error";
        throw new ToolError("failed", `Web search via ${config.search.name} failed: ${message}`);
      }
      const lines = response.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
      return {
        output: { query: input.query, provider: config.search.name, ...response },
        summary: `Searched "${input.query}" via ${config.search.name}: ${response.results.length} source${response.results.length === 1 ? "" : "s"}`,
        content: [response.answer ? `Answer (from search):\n${response.answer}\n` : "", "Sources:", lines.length ? lines.join("\n") : "(none)"]
          .filter(Boolean)
          .join("\n"),
        ...(response.usage ? { usage: response.usage } : {}),
      };
    },
  } satisfies AnyToolDefinition;

  return [searchTool, fetchTool];
}
