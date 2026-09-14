import { z } from "zod";
import { ToolError, type AnyToolDefinition } from "../types";

export interface GitHubConfig {
  /** Personal access token. Without one the tools still work, but GitHub allows far fewer requests. */
  token?: string | undefined;
  /** Base URL, so GitHub Enterprise works too. */
  apiBaseUrl?: string;
}

const API = "https://api.github.com";
const REPO = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Give the repository as "owner/name"')
  .max(140);

/**
 * GitHub tools (spec §15). Real calls to the GitHub REST API: the token, when
 * set, never leaves the server. Read-only by design — nothing here writes to a
 * repository, so there is no destructive path to approve.
 */
export function createGitHubTools(config: GitHubConfig): AnyToolDefinition[] {
  const base = (config.apiBaseUrl ?? API).replace(/\/$/, "");
  const availability = () => ({ available: true });

  async function api(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-workspace",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
    }).catch((error: unknown) => {
      throw new ToolError("unavailable", `Could not reach GitHub: ${(error as Error).message}`);
    });

    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get("x-ratelimit-reset");
      const when = reset ? ` Try again after ${new Date(Number(reset) * 1000).toISOString()}.` : "";
      throw new ToolError(
        "unavailable",
        `GitHub refused the request (rate limit).${config.token ? "" : " Set GITHUB_TOKEN on the server for a much higher limit."}${when}`,
      );
    }
    if (response.status === 404) throw new ToolError("not_found", "GitHub returned 404: it does not exist, or the token cannot see it.");
    if (!response.ok) throw new ToolError("failed", `GitHub returned ${response.status}.`);
    return response.json();
  }

  const searchInput = z.object({
    query: z.string().trim().min(1).max(256).describe('Search query, e.g. "ai agent framework language:typescript"'),
    limit: z.number().int().min(1).max(20).default(5),
  });
  const issuesInput = z.object({
    repo: REPO.describe('Repository as "owner/name"'),
    state: z.enum(["open", "closed", "all"]).default("open"),
    limit: z.number().int().min(1).max(30).default(10),
  });
  const issueInput = z.object({ repo: REPO, number: z.number().int().min(1).max(1_000_000) });

  return [
    {
      name: "github.search_repositories",
      description: "Search public GitHub repositories by keyword, returning name, description, stars and language.",
      category: "github",
      permission: "NETWORK",
      inputSchema: searchInput,
      timeoutMs: 30_000,
      availability,
      async execute(input: z.infer<typeof searchInput>, context) {
        const data = (await api(`/search/repositories?q=${encodeURIComponent(input.query)}&per_page=${input.limit}`, context.signal)) as {
          total_count: number;
          items: { full_name: string; description: string | null; stargazers_count: number; language: string | null; html_url: string }[];
        };
        const items = (data.items ?? []).map((r) => ({
          repo: r.full_name,
          description: r.description,
          stars: r.stargazers_count,
          language: r.language,
          url: r.html_url,
        }));
        const content = items.length
          ? items.map((r) => `${r.repo} — ★${r.stars}${r.language ? ` · ${r.language}` : ""}\n${r.description ?? "No description"}\n${r.url}`).join("\n\n")
          : "No repositories matched.";
        return { output: { totalCount: data.total_count, items }, summary: `${items.length} repository result(s) for "${input.query}"`, content };
      },
    },
    {
      name: "github.list_issues",
      description: "List issues in a repository, newest first. Pull requests are excluded.",
      category: "github",
      permission: "NETWORK",
      inputSchema: issuesInput,
      timeoutMs: 30_000,
      availability,
      async execute(input: z.infer<typeof issuesInput>, context) {
        const data = (await api(`/repos/${input.repo}/issues?state=${input.state}&per_page=${input.limit}`, context.signal)) as {
          number: number;
          title: string;
          state: string;
          user: { login: string } | null;
          pull_request?: unknown;
          html_url: string;
        }[];
        // GitHub returns pull requests from this endpoint too; the spec asked for issues.
        const issues = (data ?? []).filter((i) => !i.pull_request).map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login ?? null,
          url: i.html_url,
        }));
        const content = issues.length
          ? issues.map((i) => `#${i.number} [${i.state}] ${i.title}${i.author ? ` — @${i.author}` : ""}`).join("\n")
          : `No ${input.state} issues in ${input.repo}.`;
        return { output: { issues }, summary: `${issues.length} issue(s) in ${input.repo}`, content };
      },
    },
    {
      name: "github.read_issue",
      description: "Read one issue or pull request: its title, state, body and comment count.",
      category: "github",
      permission: "NETWORK",
      inputSchema: issueInput,
      timeoutMs: 30_000,
      availability,
      async execute(input: z.infer<typeof issueInput>, context) {
        const issue = (await api(`/repos/${input.repo}/issues/${input.number}`, context.signal)) as {
          title: string;
          state: string;
          body: string | null;
          comments: number;
          user: { login: string } | null;
          html_url: string;
        };
        const content = [
          `${input.repo}#${input.number} — ${issue.title}`,
          `State: ${issue.state}${issue.user ? ` · opened by @${issue.user.login}` : ""} · ${issue.comments} comment(s)`,
          "",
          issue.body?.slice(0, 20_000) || "(no description)",
        ].join("\n");
        return {
          output: { title: issue.title, state: issue.state, comments: issue.comments, url: issue.html_url },
          summary: `Read ${input.repo}#${input.number}`,
          content,
        };
      },
    },
  ];
}
