import { isProviderError } from "@aiw/ai";
import type { ModelDto, ModelsResponse } from "@aiw/shared";
import { errorResponse } from "@/server/http";
import { getProviderRegistry } from "@/server/providers";
import { requireApiSession } from "@/server/session";

/** GET /api/models — provider status and the live list of selectable models. */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireApiSession(request);
    const registry = getProviderRegistry();
    const provider = registry.getDefault();

    const body: ModelsResponse = {
      defaultModel: provider.isConfigured() ? provider.defaultModel : null,
      providers: registry.list().map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured() })),
      models: [],
      error: null,
    };

    if (provider.isConfigured()) {
      try {
        body.models = await provider.listModels();
      } catch (error) {
        body.error = isProviderError(error) ? error.message : "Could not load the model list.";
      }
      // The configured default is always selectable, even if the list failed.
      if (!body.models.some((m) => m.id === provider.defaultModel)) {
        const fallback: ModelDto = {
          id: provider.defaultModel,
          label: provider.defaultModel,
          provider: provider.id,
          inputTokenLimit: null,
          outputTokenLimit: null,
        };
        body.models.unshift(fallback);
      }
    }

    return Response.json(body);
  } catch (error) {
    return errorResponse(error);
  }
}
