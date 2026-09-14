"use client";

import { isActiveTaskStatus, type TaskEventOf, type TaskWithStepsDto } from "@aiw/shared";
import { ArrowLeftIcon, BrainCircuitIcon, MessagesSquareIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../agents/agent-icon";
import { ActivityTimeline } from "./activity-timeline";
import type { TaskAction } from "./api";
import { StepList, TaskControls, TaskErrorPanel, TaskProgressBar, TaskResult } from "./task-parts";
import { SubTasksView } from "./sub-tasks-view";
import { LiveIndicator } from "./task-reply";
import { TaskStatusBadge } from "./task-status";
import { ApprovalPanel, pendingApproval } from "./approval-panel";
import { BrowserView, currentBrowserAction, isBrowserEvent } from "./browser-view";
import { ComputerView, currentComputerAction, isComputerEvent } from "./computer-view";
import { FilesView, isFileEvent, TerminalView, ToolCallsList } from "./tool-views";
import { useTaskLive } from "./use-task-live";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function TaskDetail({ initial }: { initial: TaskWithStepsDto }) {
  const router = useRouter();
  const live = useTaskLive(initial.id, initial, { loadHistory: true });
  const task = live.task ?? initial;
  const active = isActiveTaskStatus(task.status);
  const executing = active && task.status !== "paused";

  async function onAction(action: TaskAction) {
    const result = await live.run(action);
    if (result && action === "retry") router.push(`/tasks/${result.id}`);
  }

  const terminalCalls = task.toolCalls.filter((c) => c.toolName === "terminal.run");
  const fileEvents = live.events.filter(isFileEvent);
  const usesBrowser = task.screenshots.some((s) => s.source === "browser") || task.toolCalls.some((c) => c.toolName.startsWith("browser.")) || live.events.some(isBrowserEvent);
  const usesComputer = task.screenshots.some((s) => s.source === "computer") || task.toolCalls.some((c) => c.toolName.startsWith("computer.")) || live.events.some(isComputerEvent);
  const approval = pendingApproval(live.events);
  const modelCalls = live.events.filter((e): e is TaskEventOf<"MODEL_CALL_FINISHED"> => e.type === "MODEL_CALL_FINISHED");

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <div>
          <Link
            href={task.parentTaskId ? `/tasks/${task.parentTaskId}` : "/tasks"}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" /> {task.parentTaskId ? "Task that delegated this" : "Tasks"}
          </Link>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight break-words whitespace-pre-wrap">{task.prompt}</h1>
            <div className="flex items-center gap-3">
              {active && <LiveIndicator state={live.streamState} />}
              <TaskStatusBadge status={task.status} className="h-7 px-2.5 text-sm" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <TaskControls
              status={task.status}
              pauseRequested={task.pauseRequested}
              pendingAction={live.pendingAction}
              onAction={(a) => void onAction(a)}
              size="default"
            />
            {task.conversationId && (
              <Button variant="ghost" asChild>
                <Link href={`/c/${task.conversationId}`}>
                  <MessagesSquareIcon /> Open conversation
                </Link>
              </Button>
            )}
          </div>
        </div>

        {executing && (
          <div className="rounded-xl border border-brand/30 bg-brand/5 px-4 py-3">
            <p className={cn("flex items-start gap-2 text-sm", live.statusText?.warning && "text-warning")}>
              <BrainCircuitIcon className="mt-0.5 size-4 shrink-0 animate-pulse text-brand" />
              <span className="min-w-0">
                <span className="font-medium">Status: </span>
                {live.statusText?.text ?? "Waiting for the agent…"}
              </span>
            </p>
            {task.steps.length > 0 && <TaskProgressBar className="mt-3" completed={task.progress.completed} total={task.progress.total} />}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Duration" value={formatDuration(task.durationMs)} />
          <Stat label="Tokens" value={`${formatTokens(task.inputTokens)} in · ${formatTokens(task.outputTokens)} out`} />
          <Stat label="Estimated cost" value={formatCost(task.estimatedCostUsd)} />
          <Stat label="Tool calls" value={String(task.toolCalls.length)} />
        </div>

        {approval && (
          <ApprovalPanel
            approval={{ ...approval.data, id: approval.data.approvalId, agentName: task.agent?.name ?? null }}
            onDecided={() => void live.refresh()}
          />
        )}

        <Tabs defaultValue="overview" className="gap-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">
              Activity <span className="ml-1 text-xs text-muted-foreground tabular-nums">{live.events.length}</span>
            </TabsTrigger>
            {task.toolCalls.length > 0 && (
              <TabsTrigger value="tools">
                Tools <span className="ml-1 text-xs text-muted-foreground tabular-nums">{task.toolCalls.length}</span>
              </TabsTrigger>
            )}
            {usesBrowser && (
              <TabsTrigger value="browser">
                Browser{task.screenshots.length > 0 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">{task.screenshots.length}</span>}
              </TabsTrigger>
            )}
            {usesComputer && <TabsTrigger value="computer">Computer</TabsTrigger>}
            {task.subTasks.length > 0 && (
              <TabsTrigger value="team">
                Team <span className="ml-1 text-xs text-muted-foreground tabular-nums">{task.subTasks.length}</span>
              </TabsTrigger>
            )}
            {terminalCalls.length > 0 && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
            {fileEvents.length > 0 && <TabsTrigger value="files">Files</TabsTrigger>}
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid grid-cols-1 gap-6">
            <Card title="Agent">
              {task.agent ? (
                <div className="flex items-start gap-3">
                  <AgentIcon slug={task.agent.slug} />
                  <div className="min-w-0 flex-1 text-sm">
                    <Link href={`/agents/${task.agent.id}`} className="font-medium hover:underline">
                      {task.agent.name}
                    </Link>
                    <p className="text-muted-foreground">{routingLabel(task)}</p>
                    {task.routing?.mode === "auto" && (
                      <p className="mt-1.5 text-muted-foreground">
                        <span className="text-foreground">Router:</span> {task.routing.reason}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{active ? "Choosing an agent…" : "No agent was assigned."}</p>
              )}
            </Card>

            <Card title={`Plan${task.steps.length ? ` · ${task.progress.completed}/${task.progress.total}` : ""}`}>
              {task.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{active ? "Creating a plan…" : "No plan was created."}</p>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  <TaskProgressBar completed={task.progress.completed} total={task.progress.total} />
                  <StepList steps={task.steps} expandable liveOutput={executing ? live.output : undefined} />
                </div>
              )}
            </Card>

            {task.error && (
              <TaskErrorPanel error={task.error}>
                <TaskControls status={task.status} pauseRequested={false} pendingAction={live.pendingAction} onAction={(a) => void onAction(a)} />
              </TaskErrorPanel>
            )}

            {task.result && (
              <Card title="Result">
                <TaskResult result={task.result} />
              </Card>
            )}
          </TabsContent>

          <TabsContent value="activity">
            <Card title="Execution timeline">
              <ActivityTimeline events={live.events} emptyText={live.streamState === "connecting" ? "Loading activity…" : "No activity recorded."} />
            </Card>
          </TabsContent>

          <TabsContent value="tools">
            <Card title="Tool calls">
              <ToolCallsList toolCalls={task.toolCalls} />
            </Card>
          </TabsContent>

          <TabsContent value="browser">
            <BrowserView taskId={task.id} live={live.browser} screenshots={task.screenshots} currentAction={executing ? currentBrowserAction(live.events) : null} executing={executing} />
          </TabsContent>

          <TabsContent value="computer">
            <ComputerView taskId={task.id} live={live.computer} screenshots={task.screenshots} currentAction={executing ? currentComputerAction(live.events) : null} executing={executing} />
          </TabsContent>

          <TabsContent value="team">
            <Card title="Delegated work">
              <SubTasksView subTasks={task.subTasks} />
            </Card>
          </TabsContent>

          <TabsContent value="terminal">
            <TerminalView toolCalls={task.toolCalls} live={live.terminal} />
          </TabsContent>

          <TabsContent value="files">
            <Card title="File operations">
              <FilesView events={live.events} />
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="grid grid-cols-1 gap-6">
            <Card title={`Model calls · ${modelCalls.length}`}>
              {modelCalls.length === 0 ? (
                <p className="text-sm text-muted-foreground">No model calls recorded.</p>
              ) : (
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-left text-xs tabular-nums">
                    <thead className="text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3 font-medium">Time</th>
                        <th className="py-2 pr-3 font-medium">Purpose</th>
                        <th className="py-2 pr-3 font-medium">Model</th>
                        <th className="py-2 pr-3 font-medium">Status</th>
                        <th className="py-2 pr-3 text-right font-medium">Tokens in/out</th>
                        <th className="py-2 pr-3 text-right font-medium">Duration</th>
                        <th className="py-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelCalls.map((call) => (
                        <tr key={call.id} className="border-b last:border-0">
                          <td className="py-2 pr-3">{timeFormatter.format(new Date(call.timestamp))}</td>
                          <td className="py-2 pr-3 capitalize">
                            {call.data.purpose}
                            {call.data.attempt > 1 ? ` (attempt ${call.data.attempt})` : ""}
                          </td>
                          <td className="py-2 pr-3 font-mono">{call.data.model}</td>
                          <td className={cn("py-2 pr-3", call.data.status === "failed" && "text-destructive")}>
                            {call.data.status}
                            {call.data.errorCode ? ` · ${call.data.errorCode}` : ""}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            {formatTokens(call.data.inputTokens)} / {formatTokens(call.data.outputTokens)}
                          </td>
                          <td className="py-2 pr-3 text-right">{formatDuration(call.durationMs)}</td>
                          <td className="py-2 text-right">{formatCost(call.data.estimatedCostUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Raw events">
              {live.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events recorded.</p>
              ) : (
                <ol className="grid grid-cols-1 gap-1">
                  {live.events.map((event) => (
                    <li key={event.id} className="min-w-0">
                      <details className="group rounded-md hover:bg-muted/40 [&[open]]:bg-muted/40">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 font-mono text-xs [&::-webkit-details-marker]:hidden">
                          <span className="text-muted-foreground tabular-nums">#{event.id}</span>
                          <span className="font-medium">{event.type}</span>
                          <span className="min-w-0 truncate text-muted-foreground">{event.description}</span>
                        </summary>
                        <pre className="scrollbar-thin overflow-x-auto px-2 pb-2 font-mono text-[0.7rem] leading-5">
                          {JSON.stringify(event, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </TabsContent>
        </Tabs>

        <dl className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-[8rem_1fr]">
          <dt>Created</dt>
          <dd>{dateFormatter.format(new Date(task.createdAt))}</dd>
          {task.startedAt && (
            <>
              <dt>Started</dt>
              <dd>{dateFormatter.format(new Date(task.startedAt))}</dd>
            </>
          )}
          {task.completedAt && (
            <>
              <dt>Finished</dt>
              <dd>{dateFormatter.format(new Date(task.completedAt))}</dd>
            </>
          )}
          {task.retryOfTaskId && (
            <>
              <dt>Retry of</dt>
              <dd>
                <Link href={`/tasks/${task.retryOfTaskId}`} className="underline hover:text-foreground">
                  previous attempt
                </Link>
              </dd>
            </>
          )}
          <dt>Attempt</dt>
          <dd>{task.attempt}</dd>
          <dt>Task ID</dt>
          <dd className="font-mono break-all">{task.id}</dd>
        </dl>
      </div>
    </div>
  );
}

function routingLabel(task: TaskWithStepsDto): string {
  const routing =
    task.routing?.mode === "manual"
      ? "Selected manually"
      : task.routing?.method === "llm"
        ? `Auto-routed${task.routing.confidence !== null ? ` · ${Math.round(task.routing.confidence * 100)}% confidence` : ""}`
        : task.routing?.method === "single"
          ? "Auto-routed · only available agent"
          : task.routing?.method === "fallback"
            ? "Auto-routed · fallback"
            : null;
  return [routing, task.model && `${task.provider} · ${task.model}`, task.modelOverride && "model override"].filter(Boolean).join(" · ");
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card">
      <h2 className="border-b px-4 py-3 text-sm font-semibold sm:px-5">{title}</h2>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}
