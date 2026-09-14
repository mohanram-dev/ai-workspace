import { ProviderError } from "@aiw/ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { assertSameOrigin, errorResponse, HttpError, isUuid, readJson } from "./http";

const APP_URL = "http://localhost:3000";

function request(method: string, headers: Record<string, string> = {}, body?: string) {
  return new Request(`${APP_URL}/api/test`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

describe("assertSameOrigin", () => {
  it("allows same-origin and safe requests", () => {
    expect(() => assertSameOrigin(request("POST", { origin: APP_URL }), APP_URL)).not.toThrow();
    expect(() => assertSameOrigin(request("GET", { origin: "https://evil.example" }), APP_URL)).not.toThrow();
    expect(() => assertSameOrigin(request("POST"), APP_URL)).not.toThrow();
  });

  it("rejects cross-origin mutations", () => {
    expect(() => assertSameOrigin(request("POST", { origin: "https://evil.example" }), APP_URL)).toThrow(HttpError);
    expect(() => assertSameOrigin(request("DELETE", { "sec-fetch-site": "cross-site" }), APP_URL)).toThrow(HttpError);
  });
});

describe("readJson", () => {
  const schema = z.object({ name: z.string() });

  it("parses valid bodies", async () => {
    await expect(readJson(request("POST", {}, JSON.stringify({ name: "x" })), schema)).resolves.toEqual({ name: "x" });
  });

  it("rejects malformed, invalid and oversized bodies", async () => {
    await expect(readJson(request("POST", {}, "{oops"), schema)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request("POST", {}, JSON.stringify({ name: 1 })), schema)).rejects.toMatchObject({ status: 400 });
    await expect(
      readJson(request("POST", {}, JSON.stringify({ name: "x".repeat(300 * 1024) })), schema),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("errorResponse", () => {
  it("maps provider errors to safe responses", async () => {
    const response = errorResponse(new ProviderError("not_configured", "Gemini is not configured.", { provider: "gemini" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "provider_not_configured", message: "Gemini is not configured." },
    });
  });

  it("never leaks unexpected error details", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = errorResponse(new Error("password=hunter2"));
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("hunter2");
    } finally {
      console.error = originalError;
    }
  });
});

describe("isUuid", () => {
  it("validates UUIDs", () => {
    expect(isUuid("3f1f8f5e-2b8e-4a53-9c4f-4a5b7e1f2d3c")).toBe(true);
    expect(isUuid("1; drop table user")).toBe(false);
  });
});
