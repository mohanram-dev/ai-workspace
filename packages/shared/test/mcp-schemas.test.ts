import { describe, expect, it } from "vitest";
import { createMcpServerSchema, updateMcpServerSchema, updateMcpToolSchema } from "../src";

describe("MCP server schemas", () => {
  const http = { name: "GitHub", slug: "github", transport: "http", url: "https://api.example.com/mcp" };

  it("accepts valid servers and applies defaults", () => {
    expect(createMcpServerSchema.parse(http)).toMatchObject({ headers: {}, enabled: true, timeoutSeconds: 60, description: "" });
    expect(createMcpServerSchema.parse({ name: "FS", slug: "fs_local", transport: "stdio", command: "npx", env: { TOKEN: "x" } })).toMatchObject({
      args: [],
      env: { TOKEN: "x" },
    });
  });

  it("rejects reserved or malformed prefixes", () => {
    for (const slug of ["files", "web", "Git", "9lives", "a", "has-dash", "x".repeat(33)]) {
      expect(createMcpServerSchema.safeParse({ ...http, slug }).success, slug).toBe(false);
    }
  });

  it("rejects URLs with credentials or other protocols, and client-managed or multi-line headers", () => {
    expect(createMcpServerSchema.safeParse({ ...http, url: "https://user:pw@example.com/mcp" }).success).toBe(false);
    expect(createMcpServerSchema.safeParse({ ...http, url: "file:///etc/passwd" }).success).toBe(false);
    expect(createMcpServerSchema.safeParse({ ...http, headers: { Host: "evil" } }).success).toBe(false);
    expect(createMcpServerSchema.safeParse({ ...http, headers: { "Mcp-Session-Id": "x" } }).success).toBe(false);
    expect(createMcpServerSchema.safeParse({ ...http, headers: { Authorization: "Bearer a\r\nX-Evil: 1" } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]));
    expect(createMcpServerSchema.safeParse({ ...http, headers: many }).success).toBe(false);
  });

  it("uses write-only secret updates and cannot change the prefix or transport", () => {
    expect(updateMcpServerSchema.parse({ headers: { Authorization: null, "X-Key": "new" } })).toEqual({
      headers: { Authorization: null, "X-Key": "new" },
    });
    expect(updateMcpServerSchema.safeParse({}).success).toBe(false);
    expect(updateMcpServerSchema.parse({ slug: "other", transport: "stdio", name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(updateMcpToolSchema.parse({ permission: null })).toEqual({ permission: null });
    expect(updateMcpToolSchema.safeParse({ permission: "ADMIN" }).success).toBe(false);
  });
});
