import { describe, expect, it } from "vitest";
import { toApiClientError } from "@/lib/api-client";
import { isLowerPermission, secretRows, secretsForCreate, secretsForUpdate } from "./mcp-parts";
import { slugFromName } from "./mcp-server-form";

describe("MCP form helpers", () => {
  it("builds write-only secret updates", () => {
    const rows = secretRows(["KEEP", "REPLACE", "DROP"]);
    expect(secretsForUpdate(rows)).toBeNull();
    rows[1]!.value = "new-value";
    rows[2]!.removed = true;
    rows.push({ key: "n", name: " NEW ", value: "v", stored: false, removed: false }, { key: "e", name: "", value: "ignored", stored: false, removed: false });
    expect(secretsForUpdate(rows)).toEqual({ REPLACE: "new-value", DROP: null, NEW: "v" });
    expect(secretsForCreate(rows.filter((r) => !r.stored))).toEqual({ NEW: "v" });
  });

  it("warns only when an override removes protection", () => {
    expect(isLowerPermission("WRITE", "EXECUTE")).toBe(false);
    expect(isLowerPermission("DESTRUCTIVE", "READ")).toBe(false);
    expect(isLowerPermission("READ", "EXECUTE")).toBe(true);
    expect(isLowerPermission("EXECUTE", "DESTRUCTIVE")).toBe(true);
    expect(isLowerPermission("READ", "READ")).toBe(false);
  });

  it("derives valid tool prefixes from names", () => {
    expect(slugFromName("GitHub MCP")).toBe("github_mcp");
    expect(slugFromName("123 Tools")).toBe("s_123_tools");
    expect(slugFromName("!!!")).toBe("");
  });

  it("shows validation issues in API error messages", async () => {
    const response = Response.json(
      { error: { code: "bad_request", message: "Invalid request.", details: { issues: [{ path: "slug", message: "This name is reserved for built-in tools." }] } } },
      { status: 400 },
    );
    expect((await toApiClientError(response)).message).toBe("Invalid request. slug: This name is reserved for built-in tools.");
  });
});
