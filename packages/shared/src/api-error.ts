export const API_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_not_configured",
  "provider_error",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** JSON body returned by every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

/** Error with an HTTP status, thrown by shared services and mapped by API routes. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * True for AppError instances, including ones created by another copy of this
 * module (bundlers can load a workspace package more than once across chunks).
 */
export function isAppError(error: unknown): error is AppError {
  if (error instanceof AppError) return true;
  return (
    error instanceof Error &&
    error.name === "AppError" &&
    typeof (error as Partial<AppError>).status === "number" &&
    typeof (error as Partial<AppError>).code === "string"
  );
}
