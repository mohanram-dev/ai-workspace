import { isProviderError, type ProviderErrorCode } from "@aiw/ai";
import { isAppError, type ApiErrorBody, type ApiErrorCode } from "@aiw/shared";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(
  status: number,
  code: ApiErrorCode,
  message: string,
  options: { details?: unknown; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(options.details !== undefined ? { details: options.details } : {}) },
  };
  return Response.json(body, { status, headers: options.headers });
}

const PROVIDER_STATUS: Record<ProviderErrorCode, [number, ApiErrorCode]> = {
  not_configured: [503, "provider_not_configured"],
  model_not_found: [400, "bad_request"],
  invalid_request: [400, "bad_request"],
  authentication: [502, "provider_error"],
  rate_limited: [503, "provider_error"],
  content_blocked: [422, "provider_error"],
  unavailable: [503, "provider_error"],
  aborted: [499, "provider_error"],
  unknown: [502, "provider_error"],
};

/** Converts any thrown value into a JSON error response without leaking internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message, {
      details: error.details,
      ...(error.headers ? { headers: error.headers } : {}),
    });
  }
  if (isAppError(error)) {
    return jsonError(error.status, error.code, error.message);
  }
  if (isProviderError(error)) {
    const [status, code] = PROVIDER_STATUS[error.code];
    return jsonError(status, code, error.message);
  }
  console.error("Unhandled API error", error);
  return jsonError(500, "internal_error", "Something went wrong. Please try again.");
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence for cookie-authenticated routes. Browsers always send `Origin`
 * on cross-site fetch/form POSTs, so a mismatch is rejected. Requests without
 * browser fetch metadata (e.g. CLI tools) carry no ambient cookies to abuse.
 */
export function assertSameOrigin(request: Request, appUrl: string): void {
  if (!MUTATING_METHODS.has(request.method)) return;

  const origin = request.headers.get("origin");
  if (origin) {
    if (origin !== new URL(appUrl).origin) {
      throw new HttpError(403, "forbidden", "Cross-origin request rejected.");
    }
    return;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "forbidden", "Cross-origin request rejected.");
  }
}

const MAX_JSON_BYTES = 256 * 1024;

export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "bad_request", "Request body is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new HttpError(413, "bad_request", "Request body is too large.");
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.");
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "bad_request", "Invalid request.", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
