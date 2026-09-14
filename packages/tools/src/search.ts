import type { ToolAvailability, ToolResult } from "./types";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string | null;
}

export interface WebSearchResponse {
  /** Synthesised answer, when the backend provides one (e.g. grounded search). */
  answer: string | null;
  results: WebSearchHit[];
  usage?: ToolResult["usage"];
}

/** A search backend. Gemini grounding is wired in the app; SearXNG is built in. */
export interface WebSearchService {
  readonly name: string;
  availability(): ToolAvailability;
  search(query: string, signal: AbortSignal): Promise<WebSearchResponse>;
}

/** Self-hosted SearXNG instance (JSON output must be enabled in its settings). */
export class SearxngSearchService implements WebSearchService {
  readonly name = "SearXNG";

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  availability(): ToolAvailability {
    return this.baseUrl ? { available: true } : { available: false, reason: "SEARXNG_URL is not set." };
  }

  async search(query: string, signal: AbortSignal): Promise<WebSearchResponse> {
    const url = new URL("search", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await this.fetchImpl(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[]; answers?: unknown[] };
    const results = (body.results ?? [])
      .filter((r): r is { title?: string; url: string; content?: string } => typeof r.url === "string")
      .slice(0, 10)
      .map((r) => ({ title: r.title?.trim() || r.url, url: r.url, snippet: r.content?.trim() || null }));
    const answer = (body.answers ?? []).find((a): a is string => typeof a === "string") ?? null;
    return { answer, results };
  }
}
