import type { ModelDto } from "@aiw/shared";
import { getProviderRegistry } from "./providers";

/** Providers and selectable models for server-rendered forms. Never exposes credentials. */
export async function getModelOptions(): Promise<{
  providers: { id: string; name: string; configured: boolean; defaultModel: string }[];
  models: ModelDto[];
}> {
  const registry = getProviderRegistry();
  const providers = registry.list();
  const models: ModelDto[] = [];
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    try {
      models.push(...(await provider.listModels()));
    } catch {
      // Listing failed; the provider default is still offered by the form.
    }
  }
  return {
    providers: providers.map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured(), defaultModel: p.defaultModel })),
    models,
  };
}
