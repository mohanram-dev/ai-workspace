import type { ApiErrorBody } from "@aiw/shared";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Builds a user-facing error from a non-OK API response. */
export async function toApiClientError(response: Response): Promise<ApiClientError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error?.message) {
      return new ApiClientError(response.status, body.error.code, withIssues(body.error.message, body.error.details));
    }
  } catch {
    // Non-JSON error body (e.g. proxy error page).
  }
  if (response.status === 401) {
    return new ApiClientError(401, "unauthorized", "Your session has expired. Sign in again.");
  }
  return new ApiClientError(response.status, "unknown", `Request failed (${response.status}).`);
}

/** Appends the first validation issues ("slug: This name is reserved…") to a generic message. */
function withIssues(message: string, details: unknown): string {
  const issues = (details as { issues?: { path?: string; message?: string }[] } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return message;
  const text = issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  return `${message} ${text}`;
}

export async function apiFetch<T>(input: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw await toApiClientError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
