"use client";

import type { FileContentDto, FileEntryDto, FileListDto } from "@aiw/shared";
import { ChevronRightIcon, DownloadIcon, FileIcon, FilePlusIcon, FolderIcon, Loader2Icon, RefreshCwIcon, SearchIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FileBrowserProps {
  /** Null browses the user's personal workspace. */
  projectId?: string | null;
  compact?: boolean;
}

/** Browse, search, preview, create, upload, download and delete files in a workspace (spec §24). */
export function FileBrowser({ projectId = null, compact = false }: FileBrowserProps) {
  const [listing, setListing] = useState<FileListDto | null>(null);
  const [path, setPath] = useState(".");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileContentDto | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ query: string; entries: FileEntryDto[]; truncated: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const query = projectId ? `&projectId=${projectId}` : "";

  const load = useCallback(
    async (next: string) => {
      setError(null);
      try {
        const result = await apiFetch<FileListDto>(`/api/files?path=${encodeURIComponent(next)}${query}`);
        setListing(result);
        setPath(result.path);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [query],
  );

  useEffect(() => {
    // The listing arrives after the fetch, so no state is set during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(".");
  }, [load]);

  useEffect(() => {
    const term = search.trim();
    if (!term) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      apiFetch<{ query: string; entries: FileEntryDto[]; truncated: boolean }>(`/api/files/search?query=${encodeURIComponent(term)}${query}`)
        .then((r) => active && setResults(r))
        .catch((e: unknown) => active && toast.error(errorMessage(e)));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, query]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    const target = path === "." ? name : `${path}/${name}`;
    try {
      const entry = await apiFetch<FileEntryDto>("/api/files/create", {
        method: "POST",
        body: JSON.stringify({ path: target, content: "", ...(projectId ? { projectId } : {}) }),
      });
      toast.success(`Created ${entry.name}`);
      setCreating(false);
      setNewName("");
      await load(path);
      await open(entry);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function open(entry: FileEntryDto) {
    if (entry.kind === "directory") {
      setSelected(null);
      await load(entry.path);
      return;
    }
    setLoadingFile(true);
    try {
      setSelected(await apiFetch<FileContentDto>(`/api/files/content?path=${encodeURIComponent(entry.path)}${query}`));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingFile(false);
    }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("directory", path);
      if (projectId) form.set("projectId", projectId);
      const response = await fetch("/api/files/upload", { method: "POST", body: form });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "Upload failed.");
      toast.success(`Uploaded ${file.name}`);
      await load(path);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(entry: FileEntryDto) {
    try {
      await apiFetch(`/api/files/delete?path=${encodeURIComponent(entry.path)}${query}`, { method: "POST" });
      if (selected?.path === entry.path) setSelected(null);
      await load(path);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const crumbs = path === "." ? [] : path.split("/");

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm" aria-label="Folder path">
          <button type="button" className="rounded px-1 hover:bg-muted" onClick={() => void load(".")}>
            {listing?.workspace.name ?? "Files"}
          </button>
          {crumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className="flex items-center gap-1">
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
              <button type="button" className="rounded px-1 font-mono text-xs hover:bg-muted" onClick={() => void load(crumbs.slice(0, index + 1).join("/"))}>
                {crumb}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files" aria-label="Search files" className="h-8 w-40 pl-7 text-xs" />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 hover:bg-muted">
              <XIcon className="size-3" />
            </button>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load(path)}>
          <RefreshCwIcon /> Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
          <FilePlusIcon /> New file
        </Button>
        <Button variant="outline" size="sm" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} Upload
        </Button>
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2"
        >
          <span className="font-mono text-xs text-muted-foreground">{path === "." ? "" : `${path}/`}</span>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="notes.md" aria-label="New file name" className="h-8 w-56 font-mono text-xs" autoFocus />
          <Button type="submit" size="sm" disabled={!newName.trim()}>
            Create
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}

      {results ? (
        results.entries.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No file name contains &ldquo;{results.query}&rdquo;.</p>
        ) : (
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">
              {results.entries.length} match(es){results.truncated ? " — showing the first ones only" : ""}
            </p>
            <ul className={cn("grid grid-cols-1 divide-y rounded-lg border", compact && "max-h-72 overflow-y-auto")}>
              {results.entries.map((entry) => (
                <li key={entry.path} className="flex items-center gap-3 px-3 py-2">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void open(entry)}>
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !listing ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : listing.entries.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          This folder is empty. Agents write here when they work{listing.workspace.kind === "project" ? " in this project" : ""}.
        </p>
      ) : (
        <ul className={cn("grid grid-cols-1 divide-y rounded-lg border", compact && "max-h-72 overflow-y-auto")}>
          {listing.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-3 px-3 py-2">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void open(entry)}>
                {entry.kind === "directory" ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                {entry.kind === "file" && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.size)}</span>}
              </button>
              {entry.kind === "file" && (
                <span className="flex shrink-0 gap-0.5">
                  <Button variant="ghost" size="icon-xs" aria-label={`Download ${entry.name}`} asChild>
                    <a href={`/api/files/content?path=${encodeURIComponent(entry.path)}${query}&download=1`} download>
                      <DownloadIcon />
                    </a>
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}>
                    <Trash2Icon />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {loadingFile && <Skeleton className="h-32 rounded-lg" />}
      {selected && !loadingFile && (
        <div className="rounded-lg border">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected.path}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(selected.size)}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          {selected.text === null ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{selected.reason}</p>
          ) : (
            <pre className="scrollbar-thin max-h-96 overflow-auto px-3 py-2 font-mono text-[0.7rem] leading-5 whitespace-pre-wrap">{selected.text}</pre>
          )}
        </div>
      )}
    </div>
  );
}
