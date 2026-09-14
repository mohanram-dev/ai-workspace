import { BrowserManager, createBrowserTools } from "@aiw/browser";
import type { AnyToolDefinition } from "@aiw/tools";
import { getAgentServices } from "./agents";
import { publishFrame } from "./frames";
import { getServerEnv } from "./env";

const globalForBrowser = globalThis as unknown as { __aiwBrowser?: BrowserManager };

/** Process-wide browser manager: one Chromium, one isolated context per task. Live frames go to the task event bus. */
export function getBrowserManager(): BrowserManager {
  if (!globalForBrowser.__aiwBrowser) {
    const env = getServerEnv();
    globalForBrowser.__aiwBrowser = new BrowserManager({
      enabled: env.BROWSER_ENABLED,
      channel: env.BROWSER_CHANNEL === "chromium" ? undefined : env.BROWSER_CHANNEL,
      executablePath: env.BROWSER_EXECUTABLE_PATH,
      maxSessions: env.BROWSER_MAX_SESSIONS,
      allowPrivateNetwork: env.BROWSER_ALLOW_PRIVATE_NETWORK,
      // Frames only arrive while a task runs, by which time the agent services exist.
      onFrame: (frame) => {
        getAgentServices().events.browserFrame(frame);
        publishFrame("browser", frame.taskId, globalForBrowser.__aiwBrowser?.latestFrame(frame.taskId) ?? null);
      },
    });
  }
  return globalForBrowser.__aiwBrowser;
}

export function getBrowserTools(): AnyToolDefinition[] {
  return createBrowserTools(getBrowserManager());
}
