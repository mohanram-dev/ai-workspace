import {
  decideApproval,
  getApprovalRequest,
  insertApprovalRequest,
  listTaskApprovedTools,
  type ApprovalRequest,
  type Database,
} from "@aiw/database";

export interface ApprovalDecision {
  status: "approved" | "rejected" | "expired" | "cancelled";
  scope: "once" | "task" | null;
  reason: string | null;
  decidedBy: string | null;
}

export interface ApprovalServiceOptions {
  db: Database;
  /** How long a request stays open before it expires. */
  timeoutMs?: number;
  /** How often the database is checked while waiting (a decision also wakes the wait directly). */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 2000;

/**
 * Human approval for tool calls (spec §17). A waiting task blocks on
 * `waitForDecision` until the user decides, the request expires, or the task
 * is stopped. Decisions made through the API notify the waiter directly;
 * polling covers decisions made elsewhere.
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Set<(decision: ApprovalDecision) => void>>();
  readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly options: ApprovalServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  async create(values: {
    taskId: string;
    userId: string;
    agentId: string | null;
    stepId: string | null;
    toolCallId: string;
    toolName: string;
    permission: string;
    action: string;
    input: unknown;
  }): Promise<ApprovalRequest> {
    return insertApprovalRequest(this.options.db, { ...values, expiresAt: new Date(Date.now() + this.timeoutMs) });
  }

  /** Tool names already approved for the whole task. */
  approvedTools(taskId: string): Promise<string[]> {
    return listTaskApprovedTools(this.options.db, taskId);
  }

  /** Records a decision and wakes the waiting task. Returns null if it was already decided. */
  async decide(
    id: string,
    decision: { status: "approved" | "rejected" | "cancelled"; scope?: "once" | "task"; reason?: string | null; decidedBy?: string | null },
  ): Promise<ApprovalRequest | null> {
    const row = await decideApproval(this.options.db, id, decision);
    if (row) this.notify(row);
    return row;
  }

  /** Waits for the decision. An aborted signal cancels the request so the task can stop. */
  async waitForDecision(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const settled = toDecision(request);
    if (settled) return settled;
    // The task may have been stopped between creating the request and waiting
    // for it; an already-aborted signal never fires its listener.
    if (signal.aborted) {
      const reason = "The task was stopped before a decision.";
      await this.decide(request.id, { status: "cancelled", reason });
      return { status: "cancelled", scope: null, reason, decidedBy: null };
    }

    return new Promise<ApprovalDecision>((resolve) => {
      let done = false;
      const finish = (decision: ApprovalDecision) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        const set = this.waiters.get(request.id);
        set?.delete(finish);
        if (set && set.size === 0) this.waiters.delete(request.id);
        resolve(decision);
      };

      const onAbort = () => {
        void this.decide(request.id, { status: "cancelled", reason: "The task was stopped before a decision." }).finally(() =>
          finish({ status: "cancelled", scope: null, reason: "The task was stopped before a decision.", decidedBy: null }),
        );
      };

      const poll = setInterval(() => {
        void getApprovalRequest(this.options.db, request.id)
          .then((latest) => {
            const decision = latest && toDecision(latest);
            if (decision) finish(decision);
          })
          .catch(() => {});
      }, this.pollMs);

      const remaining = Math.max(0, request.expiresAt.getTime() - Date.now());
      const deadline = setTimeout(() => {
        void this.expire(request.id).finally(() =>
          finish({ status: "expired", scope: null, reason: `No decision within ${Math.round(this.timeoutMs / 60_000)} minutes.`, decidedBy: null }),
        );
      }, remaining);

      let waiters = this.waiters.get(request.id);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(request.id, waiters);
      }
      waiters.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async expire(id: string): Promise<void> {
    const row = await decideApproval(this.options.db, id, { status: "expired", reason: "The approval request expired." });
    if (row) this.notify(row);
  }

  private notify(row: ApprovalRequest): void {
    const decision = toDecision(row);
    if (!decision) return;
    for (const waiter of [...(this.waiters.get(row.id) ?? [])]) waiter(decision);
  }
}

function toDecision(row: ApprovalRequest): ApprovalDecision | null {
  if (row.status === "pending") return null;
  return { status: row.status, scope: row.scope, reason: row.reason, decidedBy: row.decidedBy };
}
