import { isProviderError, type ModelProvider } from "@aiw/ai";
import type { ModelDto, ModelsResponse } from "@aiw/shared";
import { errorResponse } from "@/server/http";
import { getProviderRegistry } from "@/server/providers";
import { requireApiSession } from "@/server/session";

/**
 * GET /api/models — provider status and the live model list.
 *
 * Every configured provider contributes, not just the default one, so one
 * picker can offer a Gemini model and an OpenRouter model side by side and the
 * choice can be made per task. `ProviderRegistry.resolveModel` finds whichever
 * provider owns the chosen id, so an agent pinned to one provider can still run
 * a model from another (see CLAUDE.md §21).
 *
 * The default provider is listed first; within a provider the order is its own.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiSession(request);
    const registry = getProviderRegistry();
    const defaultProvider = registry.getDefault();

    // Default provider first, so its models head the list and its default model
    // is the one a fresh picker lands on.
    const configured = registry
      .list()
      .filter((provider) => provider.isConfigured())
      .sort((a, b) => Number(b.id === defaultProvider.id) - Number(a.id === defaultProvider.id));

    const body: ModelsResponse = {
      defaultModel: defaultProvider.isConfigured() ? defaultProvider.defaultModel : null,
      providers: registry.list().map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured() })),
      models: [],
      error: null,
    };

    const failures: string[] = [];
    for (const provider of configured) {
      body.models.push(...(await modelsFor(provider, failures)));
    }

    // One unreachable provider must not hide the models of the others.
    if (failures.length > 0) body.error = failures.join(" ");

    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}

/** One provider's selectable models; its default is always included. */
async function modelsFor(provider: ModelProvider, failures: string[]): Promise<ModelDto[]> {
  let models: ModelDto[] = [];
  try {
    models = await provider.listModels();
  } catch (error) {
    failures.push(isProviderError(error) ? error.message : `Could not load models from ${provider.name}.`);
  }
  if (!models.some((m) => m.id === provider.defaultModel)) {
    models.unshift({
      id: provider.defaultModel,
      label: provider.defaultModel,
      provider: provider.id,
      inputTokenLimit: null,
      outputTokenLimit: null,
    });
  }
  return models;
}
