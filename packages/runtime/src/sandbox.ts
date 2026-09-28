import { SandboxManager } from "@aiw/tools";
import { getServerEnv } from "./env";
import { getWorkspaceRoot } from "./tools";

const globalForSandbox = globalThis as unknown as { __aiwSandbox?: SandboxManager };

/** The code sandbox: one throwaway container per task that uses sandbox.run. */
export function getSandboxManager(): SandboxManager {
  if (!globalForSandbox.__aiwSandbox) {
    const env = getServerEnv();
    globalForSandbox.__aiwSandbox = new SandboxManager({
      enabled: env.SANDBOX_ENABLED,
      image: env.SANDBOX_IMAGE,
      network: env.SANDBOX_NETWORK,
      memory: env.SANDBOX_MEMORY,
      cpus: env.SANDBOX_CPUS,
      timeoutMs: env.SANDBOX_TIMEOUT_SECONDS * 1000,
      workspaceRoot: getWorkspaceRoot(),
      hostWorkspaceRoot: env.SANDBOX_HOST_WORKSPACE_ROOT,
    });
  }
  return globalForSandbox.__aiwSandbox;
}
