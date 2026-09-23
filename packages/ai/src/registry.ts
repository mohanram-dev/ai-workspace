import { ProviderError } from "./errors";
import { costFromPrice, estimateCostUsd, hasListPrice } from "./pricing";
import type { ModelPrice, ModelProvider, TokenUsage } from "./types";

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
}

export interface ProviderRegistryOptions {
  /** Prices the operator configured (MODEL_PRICES), by model id. They win over every other source. */
  prices?: Record<string, ModelPrice>;
}

/**
 * Holds the configured model providers. Agents (Phase 2) will reference a
 * provider id + model; Phase 1 chat uses the default provider.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly defaultProviderId: string;
  private readonly prices: Map<string, ModelPrice>;

  constructor(providers: ModelProvider[], defaultProviderId: string, options: ProviderRegistryOptions = {}) {
    for (const provider of providers) this.providers.set(provider.id, provider);
    if (!this.providers.has(defaultProviderId)) {
      throw new Error(`Default provider "${defaultProviderId}" is not registered`);
    }
    this.defaultProviderId = defaultProviderId;
    this.prices = new Map(Object.entries(options.prices ?? {}));
  }

  /**
   * Estimated cost of one call (spec §41), from the first source that knows
   * the model: a price the operator configured, the built-in list prices, then
   * the price the provider publishes with its model list (OpenRouter does).
   * A model none of them knows costs null — unknown, never a guess and never
   * zero, because a daily budget can only count what it can price.
   */
  async estimateCostUsd(providerId: string, model: string, usage: TokenUsage): Promise<number | null> {
    if (usage.totalTokens <= 0) return null;
    const configured = this.prices.get(model);
    if (configured) return costFromPrice(configured, usage);
    const listed = estimateCostUsd(providerId, model, usage);
    if (listed !== null) return listed;
    const published = await this.publishedPrice(providerId, model);
    return published ? costFromPrice(published, usage) : null;
  }

  /** Whether calls to this model can be priced, so a budget can count them. */
  async hasPrice(providerId: string, model: string): Promise<boolean> {
    return this.prices.has(model) || hasListPrice(providerId, model) || (await this.publishedPrice(providerId, model)) !== null;
  }

  private async publishedPrice(providerId: string, model: string): Promise<ModelPrice | null> {
    const provider = this.providers.get(providerId);
    if (!provider?.isConfigured()) return null;
    // Model lists are cached by the providers. A list that cannot be read
    // leaves the cost unknown; it must never fail the call being priced.
    const models = await provider.listModels().catch(() => []);
    return models.find((m) => m.id === model)?.price ?? null;
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

    // Not caught: if this provider cannot be reached or rejects the key, that
    // is the error worth reporting, not "model not available".
    const available = await provider.listModels();
    if (available.some((m) => m.id === model)) return { provider, model };

    // The model was named explicitly — by the person in the model picker, or by
    // an agent's own setting — while `providerId` here is only where we looked
    // first (usually the agent's provider). With several providers registered
    // the model may simply belong to another one, so the agent's provider is a
    // starting point, not a veto: without this, choosing an OpenRouter model
    // for an agent pinned to Gemini fails every task with model_not_found.
    const elsewhere = await this.findProviderOffering(model, provider.id);
    if (elsewhere) return { provider: elsewhere, model };

    throw new ProviderError("model_not_found", `Model "${model}" is not available.`, {
      provider: provider.id,
    });
  }

  /**
   * The configured provider that offers `model`, preferring the default one so
   * the choice is deterministic. A provider whose model list cannot be read is
   * skipped rather than allowed to break resolution for the others.
   */
  private async findProviderOffering(model: string, exceptId: string): Promise<ModelProvider | undefined> {
    const others = this.list().filter((p) => p.id !== exceptId && p.isConfigured());
    const ordered = [...others].sort((a, b) => Number(b.id === this.defaultProviderId) - Number(a.id === this.defaultProviderId));
    for (const candidate of ordered) {
      if (model === candidate.defaultModel) return candidate;
      const models = await candidate.listModels().catch(() => []);
      if (models.some((m) => m.id === model)) return candidate;
    }
    return undefined;
  }
}
