import { isProviderError, type ProviderErrorCode } from "@aiw/ai";
import type { TaskError } from "@aiw/shared";

export type TaskFailureCode =
  | "agent_unavailable"
  | "no_agents"
  | "budget_exceeded"
  | "timeout"
  | "empty_response"
  | "interrupted"
  | "internal"
  | `provider_${ProviderErrorCode}`;

/** A failure raised deliberately by the runtime with a user-facing explanation. */
export class TaskFailure extends Error {
  constructor(
    readonly code: TaskFailureCode,
    message?: string,
    readonly detail: string | null = null,
  ) {
    super(message ?? CATALOG[code]?.message ?? "The task failed.");
    this.name = "TaskFailure";
  }
}

interface CatalogEntry {
  title: string;
  message: string;
  suggestedAction: string;
  retryable: boolean;
}

const CATALOG: Partial<Record<TaskFailureCode, CatalogEntry>> = {
  agent_unavailable: {
    title: "Agent unavailable",
    message: "The selected agent no longer exists or is disabled.",
    suggestedAction: "Enable the agent or choose another one, then retry the task.",
    retryable: false,
  },
  no_agents: {
    title: "No agents available",
    message: "Automatic routing found no enabled agents that allow routing.",
    suggestedAction: "Enable at least one agent with routing allowed, then retry.",
    retryable: false,
  },
  budget_exceeded: {
    title: "Daily budget reached",
    message: "This agent has used its daily budget.",
    suggestedAction: "Raise the agent's daily budget or wait until tomorrow (UTC), then continue.",
    retryable: true,
  },
  timeout: {
    title: "Time limit reached",
    message: "The task exceeded the agent's maximum execution time.",
    suggestedAction: "Increase the agent's maximum execution time, then continue from the failed step.",
    retryable: true,
  },
  empty_response: {
    title: "Empty response",
    message: "The model returned no content for this step.",
    suggestedAction: "Continue to retry the step, or rephrase the task.",
    retryable: true,
  },
  interrupted: {
    title: "Task interrupted",
    message: "The server stopped while this task was running.",
    suggestedAction: "Continue the task to resume from the step that was interrupted.",
    retryable: true,
  },
  internal: {
    title: "Unexpected error",
    message: "Something went wrong while running the task.",
    suggestedAction: "Retry the task. If it keeps failing, check the server logs.",
    retryable: true,
  },
};

const PROVIDER_ACTIONS: Partial<Record<ProviderErrorCode, string>> = {
  not_configured: "Set GEMINI_API_KEY on the server and restart, then continue.",
  authentication: "Check that GEMINI_API_KEY is valid, then continue.",
  rate_limited: "Wait a minute for the provider's rate limit to reset, then continue.",
  unavailable: "The provider is temporarily unavailable. Continue in a moment.",
  model_not_found: "Choose a different model for the agent, then retry.",
  content_blocked: "The provider's safety filter blocked this content. Rephrase the task and retry.",
  invalid_request: "Try a different model or rephrase the task, then retry.",
};

export function toTaskError(
  error: unknown,
  step: { index: number; title: string } | null,
): TaskError {
  const location = { stepIndex: step?.index ?? null, stepTitle: step?.title ?? null };

  if (isProviderError(error)) {
    return {
      code: `provider_${error.code}`,
      title: "Model request failed",
      message: error.message,
      ...location,
      retryable: error.retryable || error.code === "not_configured" || error.code === "authentication",
      suggestedAction: PROVIDER_ACTIONS[error.code] ?? "Continue to try the step again.",
      detail: `${error.provider} error: ${error.code}${error.status ? ` (HTTP ${error.status})` : ""}`,
    };
  }

  const failure = error instanceof TaskFailure ? error : new TaskFailure("internal");
  const entry = CATALOG[failure.code] ?? CATALOG.internal!;
  return {
    code: failure.code,
    title: entry.title,
    message: failure.message,
    ...location,
    retryable: entry.retryable,
    suggestedAction: entry.suggestedAction,
    detail: failure.detail,
  };
}
