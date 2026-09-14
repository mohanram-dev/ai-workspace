import { getDatabase } from "@aiw/database";
import { getServerEnv } from "../env";
import { getProviderRegistry } from "../providers";
import { FixedWindowRateLimiter } from "../rate-limit";
import type { ChatServiceDeps } from "./chat-service";
import { buildSystemPrompt } from "./system-prompt";

export function getChatServiceDeps(): ChatServiceDeps {
  return {
    db: getDatabase(),
    registry: getProviderRegistry(),
    systemPrompt: buildSystemPrompt(),
  };
}

const globalForLimiter = globalThis as unknown as { __aiwChatLimiter?: FixedWindowRateLimiter };

export function getChatRateLimiter(): FixedWindowRateLimiter {
  globalForLimiter.__aiwChatLimiter ??= new FixedWindowRateLimiter(
    getServerEnv().CHAT_RATE_LIMIT_PER_MINUTE,
    60_000,
  );
  return globalForLimiter.__aiwChatLimiter;
}
