import { ComputerManager, createComputerTools } from "@aiw/computer";
import type { AnyToolDefinition } from "@aiw/tools";
import { getAgentServices } from "./agents";
import { publishFrame } from "./frames";
import { getServerEnv } from "./env";

const globalForComputer = globalThis as unknown as { __aiwComputer?: ComputerManager };

/** Process-wide computer-use manager. One task controls the server's desktop at a time. */
export function getComputerManager(): ComputerManager {
  if (!globalForComputer.__aiwComputer) {
    const env = getServerEnv();
    globalForComputer.__aiwComputer = new ComputerManager({
      enabled: env.COMPUTER_USE_ENABLED,
      maxWidth: env.COMPUTER_MAX_WIDTH,
      onFrame: (frame) => {
        getAgentServices().events.computerFrame(frame);
        publishFrame("computer", frame.taskId, globalForComputer.__aiwComputer?.latestFrame(frame.taskId) ?? null);
      },
    });
  }
  return globalForComputer.__aiwComputer;
}

export function getComputerTools(): AnyToolDefinition[] {
  return createComputerTools(getComputerManager());
}
