"use client";

import type { ApprovalRequestDto, ApprovalScope, TaskEvent } from "@aiw/shared";
import { CheckIcon, Loader2Icon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, errorMessage } from "@/lib/api-client";

/** The approval still waiting for a decision, from the live event stream. */
export function pendingApproval(events: TaskEvent[]): TaskEvent & { type: "APPROVAL_REQUIRED" } | null {
  const decided = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "APPROVAL_GRANTED" || event.type === "APPROVAL_REJECTED") decided.add(event.data.approvalId);
    if (event.type === "APPROVAL_REQUIRED" && !decided.has(event.data.approvalId)) return event as TaskEvent & { type: "APPROVAL_REQUIRED" };
  }
  return null;
}

interface ApprovalPanelProps {
  approval: { id: string; toolName: string; permission: string; action: string; input: unknown; agentName?: string | null };
  onDecided?: () => void;
}

/**
 * Approval prompt (spec §17): what the agent wants to do, the permission level,
 * and Reject / Approve once / Approve for this task. The task stays paused
 * until one is chosen.
 */
export function ApprovalPanel({ approval, onDecided }: ApprovalPanelProps) {
  const [pending, setPending] = useState<"once" | "task" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);

  async function decide(kind: "once" | "task" | "reject") {
    setPending(kind);
    try {
      if (kind === "reject") {
        await apiFetch<ApprovalRequestDto>(`/api/approvals/${approval.id}/reject`, {
          method: "POST",
          body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
        });
        setDone("Rejected");
      } else {
        await apiFetch<ApprovalRequestDto>(`/api/approvals/${approval.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ scope: kind satisfies ApprovalScope }),
        });
        setDone(kind === "task" ? "Approved for this task" : "Approved");
      }
      onDecided?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-xl border border-warning/40 bg-warning/10 p-4" aria-label="Approval required">
      <div className="flex items-start gap-3">
        <ShieldAlertIcon className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Approval required</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {approval.agentName ?? "The agent"} wants to run <span className="font-mono text-xs">{approval.toolName}</span>:
          </p>
          <pre className="scrollbar-thin mt-2 max-h-40 overflow-auto rounded-md bg-background/70 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
            {approval.action}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-destructive/40 font-mono text-[0.6rem] text-destructive">
              {approval.permission}
            </Badge>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Arguments</summary>
              <pre className="scrollbar-thin mt-1 max-h-40 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[0.7rem] whitespace-pre-wrap">
                {JSON.stringify(approval.input, null, 2)}
              </pre>
            </details>
          </div>

          {done ? (
            <p className="mt-3 text-sm font-medium">{done}. The task is continuing.</p>
          ) : (
            <>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional, sent to the agent when rejecting)"
                maxLength={500}
                className="mt-3 bg-background/70"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="destructive" size="sm" disabled={pending !== null} onClick={() => void decide("reject")}>
                  {pending === "reject" ? <Loader2Icon className="animate-spin" /> : <XIcon />} Reject
                </Button>
                <Button size="sm" disabled={pending !== null} onClick={() => void decide("once")}>
                  {pending === "once" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve once
                </Button>
                <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void decide("task")}>
                  {pending === "task" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve for this task
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
