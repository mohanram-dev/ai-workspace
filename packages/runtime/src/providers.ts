import { GeminiProvider, ProviderRegistry } from "@aiw/ai";
import { getServerEnv } from "./env";

const globalForProviders = globalThis as unknown as { __aiwProviders?: ProviderRegistry };

/**
 * Configured model providers. Gemini is the only implemented provider in
 * Phase 1; OpenAI-compatible and Ollama providers plug into the same registry.
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!globalForProviders.__aiwProviders) {
    const env = getServerEnv();
    globalForProviders.__aiwProviders = new ProviderRegistry(
      [
        new GeminiProvider({
          apiKey: env.GEMINI_API_KEY,
          defaultModel: env.GEMINI_DEFAULT_MODEL,
          allowedModels: env.GEMINI_MODELS,
        }),
      ],
      "gemini",
    );
  }
  return globalForProviders.__aiwProviders;
}
