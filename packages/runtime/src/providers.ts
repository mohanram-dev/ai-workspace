import { GeminiProvider, OpenAICompatibleProvider, ProviderRegistry } from "@aiw/ai";
import { getServerEnv } from "./env";

const globalForProviders = globalThis as unknown as { __aiwProviders?: ProviderRegistry };

/**
 * The configured model providers. Both are always registered; each reports
 * whether it is configured, so the UI can show one as unavailable rather than
 * hiding it. `DEFAULT_PROVIDER` decides which one an agent uses by default.
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
        new OpenAICompatibleProvider({
          baseUrl: env.OPENAI_BASE_URL,
          apiKey: env.OPENAI_API_KEY,
          // Without an explicit default the first allowlisted model is used, so
          // the provider is usable after setting just a URL and a model list.
          defaultModel: env.OPENAI_DEFAULT_MODEL ?? env.OPENAI_MODELS[0] ?? "",
          name: env.OPENAI_PROVIDER_NAME,
          allowedModels: env.OPENAI_MODELS,
        }),
      ],
      env.DEFAULT_PROVIDER,
    );
  }
  return globalForProviders.__aiwProviders;
}
