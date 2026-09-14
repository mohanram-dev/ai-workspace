"use client";

import type { ComputerFrameDelta, ScreenshotDto, TaskEvent } from "@aiw/shared";
import { ChevronDownIcon, ChevronUpIcon, Maximize2Icon, Minimize2Icon, MonitorIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ComputerLiveState {
  frame: ComputerFrameDelta | null;
  open: boolean;
}

export function isComputerEvent(event: TaskEvent): boolean {
  return ["COMPUTER_STARTED", "COMPUTER_ACTION", "COMPUTER_SCREENSHOT", "COMPUTER_STOPPED"].includes(event.type);
}

export function currentComputerAction(events: TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "COMPUTER_ACTION") return event.description;
    if (event.type === "COMPUTER_STOPPED" || event.type === "TOOL_CALL_FINISHED" || event.type === "STEP_COMPLETED") return null;
  }
  return null;
}

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2];

interface ComputerViewProps {
  taskId: string;
  live: ComputerLiveState;
  screenshots: ScreenshotDto[];
  currentAction: string | null;
  executing: boolean;
  compact?: boolean;
}

/**
 * Live desktop preview (spec §7): the newest screen frame while the task
 * controls the computer, otherwise the last stored desktop screenshot, with
 * the current action, full screen, zoom, collapse and an activity-only mode.
 */
export function ComputerView({ taskId, live, screenshots, currentAction, executing, compact = false }: ComputerViewProps) {
  const shots = screenshots.filter((s) => s.source === "computer");
  const [collapsed, setCollapsed] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [fullscreen, setFullscreen] = useState(false);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const objectUrl = useRef<string | null>(null);

  const latestShot = shots.at(-1) ?? null;
  const showingLive = executing && live.open && live.frame !== null;

  useEffect(() => {
    if (!live.frame || live.frame.seq <= lastSeq.current) return;
    lastSeq.current = live.frame.seq;
    let cancelled = false;
    void fetch(`/api/tasks/${taskId}/computer/frame`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || res.status === 204 || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = url;
        setFrameSrc(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [live.frame, taskId]);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const selectedShot = selected ? shots.find((s) => s.id === selected) : null;
  const image = selectedShot
    ? { src: `/api/tasks/${taskId}/screenshots/${selectedShot.id}`, width: selectedShot.width, height: selectedShot.height, label: "Screenshot" }
    : showingLive && frameSrc
      ? { src: frameSrc, width: live.frame!.width, height: live.frame!.height, label: "Live" }
      : latestShot
        ? { src: `/api/tasks/${taskId}/screenshots/${latestShot.id}`, width: latestShot.width, height: latestShot.height, label: "Last screenshot" }
        : null;

  const zoom = ZOOM_LEVELS[zoomIndex]!;

  const pane = (
    <div className={cn("flex min-h-0 flex-col rounded-xl border bg-card", fullscreen && "h-full rounded-none border-0")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Desktop{image ? ` · ${image.width}×${image.height}` : ""}</span>
        {image && (
          <Badge variant="outline" className={cn("text-[0.6rem]", image.label === "Live" && "border-brand/40 bg-brand/10 text-brand")}>
            {image.label === "Live" && <span aria-hidden className="mr-1 size-1.5 animate-pulse rounded-full bg-brand" />}
            {image.label}
          </Badge>
        )}
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="Zoom out" disabled={zoomIndex === 0} onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}>
            <ZoomOutIcon />
          </Button>
          <span className="w-9 text-center text-[0.65rem] text-muted-foreground tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon-xs" aria-label="Zoom in" disabled={zoomIndex === ZOOM_LEVELS.length - 1} onClick={() => setZoomIndex((i) => Math.min(ZOOM_LEVELS.length - 1, i + 1))}>
            <ZoomInIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen((f) => !f)}>
            {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          {!fullscreen && (
            <Button variant="ghost" size="icon-xs" aria-label={collapsed ? "Show desktop view" : "Activity only (hide desktop view)"} onClick={() => setCollapsed((c) => !c)}>
              {collapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className={cn("scrollbar-thin overflow-auto bg-muted/40", fullscreen ? "flex-1" : compact ? "max-h-72" : "max-h-[32rem]")}>
          {image ? (
            <div style={{ width: `${zoom * 100}%` }} className="mx-auto min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- dynamic, authenticated image */}
              <img src={image.src} alt="Desktop screenshot" width={image.width} height={image.height} className="block h-auto w-full" draggable={false} />
            </div>
          ) : (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <MonitorIcon className="size-6" />
              {executing ? "Waiting for the desktop…" : "No desktop screenshots were captured."}
            </div>
          )}
        </div>
      )}

      {(currentAction || (executing && live.open)) && !collapsed && (
        <p className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Current action:</span>
          <span className="min-w-0 truncate">{currentAction ?? "Waiting for the agent…"}</span>
        </p>
      )}

      {!compact && !collapsed && shots.length > 0 && (
        <div className="scrollbar-thin flex gap-2 overflow-x-auto border-t px-3 py-2">
          {executing && live.open && (
            <button type="button" onClick={() => setSelected(null)} className={cn("shrink-0 rounded-md border px-2 text-xs", selected === null ? "border-brand bg-brand/10" : "hover:bg-muted")}>
              Live
            </button>
          )}
          {shots.map((shot, index) => (
            <button
              key={shot.id}
              type="button"
              onClick={() => setSelected(shot.id === selected ? null : shot.id)}
              title={shot.reason}
              className={cn("relative shrink-0 overflow-hidden rounded-md border", selected === shot.id ? "border-brand ring-2 ring-brand/30" : "hover:border-ring/60")}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- dynamic, authenticated image */}
              <img src={`/api/tasks/${taskId}/screenshots/${shot.id}`} alt="Desktop screenshot" width={112} height={70} loading="lazy" className="h-[70px] w-28 object-cover object-top" />
              <span className="absolute right-1 bottom-1 rounded bg-background/80 px-1 text-[0.6rem] tabular-nums">{index + 1}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-background p-2 sm:p-4" role="dialog" aria-label="Desktop view">
        <div className="h-full">{pane}</div>
      </div>
    );
  }
  return pane;
}
