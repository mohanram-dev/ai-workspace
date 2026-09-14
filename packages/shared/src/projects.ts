import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).nullable().default(null),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  conversationCount: number;
  taskCount: number;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export const MEMORY_SCOPES = ["project", "agent", "conversation"] as const;
export type MemoryScopeName = (typeof MEMORY_SCOPES)[number];

/** A short structured fact, not a transcript (spec §25). */
export const memoryKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\n\r]+$/, "The key must be a single line.");
export const memoryValueSchema = z.string().trim().min(1).max(2000);

export const createMemorySchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    projectId: z.uuid().nullish(),
    agentId: z.uuid().nullish(),
    conversationId: z.uuid().nullish(),
    key: memoryKeySchema,
    value: memoryValueSchema,
  })
  .refine((v) => (v.scope === "project" ? Boolean(v.projectId) : v.scope === "agent" ? Boolean(v.agentId) : Boolean(v.conversationId)), {
    message: "The scope needs its matching id.",
  });

export const updateMemorySchema = z
  .object({ key: memoryKeySchema, value: memoryValueSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No changes provided" });

export interface MemoryDto {
  id: string;
  scope: MemoryScopeName;
  projectId: string | null;
  agentId: string | null;
  conversationId: string | null;
  key: string;
  value: string;
  /** "user" when you wrote it, "agent" when an agent remembered it. */
  source: "user" | "agent";
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Filled in when listing across scopes. */
  scopeName?: string | null;
}

export type FileEntryKind = "file" | "directory";

export interface FileEntryDto {
  name: string;
  /** Path relative to the workspace root, with forward slashes. */
  path: string;
  kind: FileEntryKind;
  size: number;
  modifiedAt: string;
}

export interface FileListDto {
  /** The directory that was listed. */
  path: string;
  /** "personal" or the project's name. */
  workspace: { kind: "personal" | "project"; id: string | null; name: string };
  entries: FileEntryDto[];
  parent: string | null;
}

export interface FileContentDto {
  path: string;
  size: number;
  modifiedAt: string;
  /** Null when the file is binary or too large to show. */
  text: string | null;
  truncated: boolean;
  reason: string | null;
}

export const fileSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  projectId: z.uuid().nullish(),
});

export const createFileSchema = z.object({
  /** Path relative to the workspace root, including the file name. */
  path: z.string().trim().min(1).max(1024),
  content: z.string().max(512 * 1024).default(""),
  projectId: z.uuid().nullish(),
});

export const filePathQuerySchema = z.object({
  path: z.string().max(1024).default("."),
  projectId: z.uuid().nullish(),
});
