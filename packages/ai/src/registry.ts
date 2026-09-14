import { ProviderError } from "./errors";
import type { ModelProvider } from "./types";

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
}

/**
 * Holds the configured model providers. Agents (Phase 2) will reference a
 * provider id + model; Phase 1 chat uses the default provider.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly defaultProviderId: string;

  constructor(providers: ModelProvider[], defaultProviderId: string) {
    for (const provider of providers) this.providers.set(provider.id, provider);
    if (!this.providers.has(defaultProviderId)) {
      throw new Error(`Default provider "${defaultProviderId}" is not registered`);
    }
    this.defaultProviderId = defaultProviderId;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  getDefault(): ModelProvider {
    return this.providers.get(this.defaultProviderId)!;
  }

  /**
   * Resolves a requested model against the provider's live model list so
   * clients cannot submit arbitrary model identifiers.
   */
  async resolveModel(requestedModel: string | undefined, providerId?: string): Promise<ResolvedModel> {
    const provider = providerId ? this.providers.get(providerId) : this.getDefault();
    if (!provider) {
      throw new ProviderError("invalid_request", `Unknown provider "${providerId}".`, {
        provider: providerId ?? "unknown",
      });
    }
    if (!provider.isConfigured()) {
      throw new ProviderError("not_configured", `${provider.name} is not configured.`, {
        provider: provider.id,
      });
    }

    const model = requestedModel ?? provider.defaultModel;
    if (model === provider.defaultModel) return { provider, model };

    const available = await provider.listModels();
    if (!available.some((m) => m.id === model)) {
      throw new ProviderError("model_not_found", `Model "${model}" is not available.`, {
        provider: provider.id,
      });
    }
    return { provider, model };
  }
}
