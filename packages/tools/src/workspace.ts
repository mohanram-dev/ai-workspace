import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./types";

/**
 * A directory tools may read and write. Every path is resolved inside the root;
 * absolute paths, `..` traversal and symlinks pointing outside are rejected.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    // Absolute roots only: resolving against the process cwd would also make
    // bundler file tracing include the whole project.
    if (!path.isAbsolute(root)) throw new Error("Workspace root must be an absolute path");
    this.root = path.normalize(root);
  }

  /** Per-user workspace under a shared base directory. */
  static forUser(baseDir: string, userId: string): Workspace {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safeId) throw new Error("Invalid user id for workspace");
    return new Workspace(path.join(baseDir, "users", safeId));
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Workspace-relative display path with forward slashes. */
  relative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join("/") || ".";
  }

  /**
   * Resolves a user- or model-supplied relative path. With `mustExist`, also
   * verifies the real path (following symlinks) stays inside the workspace.
   */
  async resolve(input: string, options: { mustExist?: boolean } = {}): Promise<string> {
    const cleaned = input.trim().replace(/\\/g, "/");
    if (cleaned.includes("\0")) throw new ToolError("invalid_input", "Path contains a null byte.");
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("//")) {
      throw new ToolError("invalid_input", "Use a path relative to the workspace, not an absolute path.");
    }

    // Paths are runtime user data; tell the bundler not to trace them.
    const resolved = path.join(/* turbopackIgnore: true */ this.root, cleaned || ".");
    if (!this.contains(resolved)) throw new ToolError("permission_denied", "Path is outside the workspace.");

    await this.ensure();
    const rootReal = await realpath(this.root);
    // Check the deepest existing ancestor so symlinked directories cannot escape.
    let probe = resolved;
    for (;;) {
      try {
        const real = await realpath(/* turbopackIgnore: true */ probe);
        if (!isInside(rootReal, real)) throw new ToolError("permission_denied", "Path resolves outside the workspace.");
        break;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (options.mustExist && probe === resolved) {
          throw new ToolError("not_found", `No such file or directory: ${this.relative(resolved)}`);
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return resolved;
  }

  contains(absolute: string): boolean {
    return isInside(this.root, absolute);
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
