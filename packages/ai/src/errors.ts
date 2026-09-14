export type ProviderErrorCode =
  | "not_configured"
  | "authentication"
  | "rate_limited"
  | "invalid_request"
  | "model_not_found"
  | "content_blocked"
  | "unavailable"
  | "aborted"
  | "unknown";

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limited", "unavailable", "unknown"]);

/** Normalised provider failure with a message that is safe to show to users. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status: number | undefined;
  /** Server-suggested wait before retrying (e.g. from a 429 RetryInfo), when provided. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { provider: string; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Also matches ProviderErrors from another copy of this module (duplicated bundler chunks). */
export function isProviderError(error: unknown): error is ProviderError {
  if (error instanceof ProviderError) return true;
  return (
    error instanceof Error &&
    error.name === "ProviderError" &&
    typeof (error as Partial<ProviderError>).code === "string" &&
    typeof (error as Partial<ProviderError>).provider === "string"
  );
}
