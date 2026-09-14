import { createDockerTools, type DockerConfig } from "./builtin/docker";
import { createFileTools } from "./builtin/files";
import { createGitHubTools, type GitHubConfig } from "./builtin/github";
import { createGitTools } from "./builtin/git";
import { createSshTools, parseSshHosts, type SshConfig, type SshHost } from "./builtin/ssh";
import { createTerminalTool, type TerminalConfig } from "./builtin/terminal";
import { createWebTools, type WebToolsConfig } from "./builtin/web";
import { ToolRegistry } from "./registry";

export { classifyCommand, type TerminalConfig } from "./builtin/terminal";
export type { DockerConfig } from "./builtin/docker";
export type { GitHubConfig } from "./builtin/github";
export { createSshTools, parseSshHosts, type SshConfig, type SshHost } from "./builtin/ssh";
export { createDockerTools } from "./builtin/docker";
export { createGitHubTools } from "./builtin/github";
export type { WebToolsConfig } from "./builtin/web";
export { extractReadableText, type ExtractedPage } from "./html";
export { createGuardedFetch, createSafeLookup, isPrivateAddress, safeFetch, type FetchResult, type GuardedFetch } from "./net";
export { canBeTrusted, decidePermission, NEVER_AUTONOMOUS, type AutonomousSettings, type PermissionDecision } from "./permissions";
export { runProcess, safeProcessEnv, type ProcessResult } from "./process";
export { toolParameters, ToolRegistry, type ToolInfo } from "./registry";
export { SearxngSearchService, type WebSearchHit, type WebSearchResponse, type WebSearchService } from "./search";
export * from "./types";
export { Workspace } from "./workspace";

export interface BuiltinToolsConfig {
  terminal: TerminalConfig;
  web: WebToolsConfig;
  /** Infrastructure tools (spec §15). Omit and they are registered but unavailable. */
  docker?: DockerConfig;
  ssh?: SshConfig;
  github?: GitHubConfig;
}

/** Registry with every built-in tool: files, git, terminal and web. */
export function createBuiltinToolRegistry(config: BuiltinToolsConfig): ToolRegistry {
  return new ToolRegistry([
    ...createFileTools(),
    ...createGitTools(),
    createTerminalTool(config.terminal),
    ...createWebTools(config.web),
    ...createDockerTools(config.docker ?? { enabled: false, timeoutMs: 60_000 }),
    ...createSshTools(config.ssh ?? { enabled: false, hosts: [], timeoutMs: 60_000 }),
    ...createGitHubTools(config.github ?? {}),
  ]);
}

/** Built-in tool names, grouped for agent defaults. */
export const BUILTIN_TOOL_NAMES = {
  filesRead: ["files.list", "files.read", "files.search"],
  filesWrite: ["files.write", "files.edit"],
  filesDelete: ["files.delete"],
  gitRead: ["git.status", "git.diff", "git.log"],
  gitWrite: ["git.init", "git.add", "git.commit"],
  terminal: ["terminal.run"],
  web: ["web.search", "web.fetch"],
  docker: ["docker.ps", "docker.logs", "docker.stats", "docker.inspect", "docker.restart", "docker.stop", "docker.remove"],
  ssh: ["ssh.run"],
  github: ["github.search_repositories", "github.list_issues", "github.read_issue"],
} as const;
