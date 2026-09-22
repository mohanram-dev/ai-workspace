import { describe, expect, it } from "vitest";
import {
  chatStreamEventSchema,
  createScheduleSchema,
  deriveConversationTitle,
  isValidTimeZone,
  listConversationsQuerySchema,
  sendChatMessageSchema,
  updateConversationSchema,
} from "../src";

describe("sendChatMessageSchema", () => {
  it("accepts a new-conversation send and trims content", () => {
    const parsed = sendChatMessageSchema.parse({ action: "send", content: "  hello  " });
    expect(parsed).toEqual({ action: "send", content: "hello" });
  });

  it("rejects empty and oversized messages", () => {
    expect(sendChatMessageSchema.safeParse({ action: "send", content: "   " }).success).toBe(false);
    expect(
      sendChatMessageSchema.safeParse({ action: "send", content: "x".repeat(32_001) }).success,
    ).toBe(false);
  });

  it("requires a valid conversation id for retry", () => {
    expect(sendChatMessageSchema.safeParse({ action: "retry" }).success).toBe(false);
    expect(
      sendChatMessageSchema.safeParse({ action: "retry", conversationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      sendChatMessageSchema.safeParse({
        action: "retry",
        conversationId: "3f1f8f5e-2b8e-4a53-9c4f-4a5b7e1f2d3c",
      }).success,
    ).toBe(true);
  });
});

describe("chatStreamEventSchema", () => {
  it("rejects unknown event types", () => {
    expect(chatStreamEventSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  it("accepts a delta event", () => {
    expect(chatStreamEventSchema.parse({ type: "delta", text: "hi" })).toEqual({
      type: "delta",
      text: "hi",
    });
  });
});

describe("updateConversationSchema", () => {
  it("rejects empty updates", () => {
    expect(updateConversationSchema.safeParse({}).success).toBe(false);
    expect(updateConversationSchema.safeParse({ pinned: true }).success).toBe(true);
  });
});

describe("listConversationsQuerySchema", () => {
  it("parses query-string values", () => {
    expect(listConversationsQuerySchema.parse({ archived: "true", limit: "5" })).toEqual({
      archived: true,
      limit: 5,
    });
    expect(listConversationsQuerySchema.parse({})).toEqual({ archived: false, limit: 100 });
  });
});

describe("deriveConversationTitle", () => {
  it("collapses whitespace and truncates on a word boundary", () => {
    expect(deriveConversationTitle("  Hello\n\nworld  ")).toBe("Hello world");
    const title = deriveConversationTitle(
      "Research the latest AI agent frameworks and compare the top five in a report",
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(deriveConversationTitle("   ")).toBe("New conversation");
  });
});

describe("isAppError", () => {
  it("recognises AppErrors from another module copy by shape", async () => {
    const { AppError, isAppError } = await import("../src");
    expect(isAppError(new AppError(409, "conflict", "x"))).toBe(true);
    const foreign = Object.assign(new Error("x"), { name: "AppError", status: 409, code: "conflict" });
    expect(isAppError(foreign)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError({ name: "AppError", status: 409, code: "conflict" })).toBe(false);
  });
});

describe("schedule time zones (spec §26)", () => {
  it("accepts IANA names, aliases and the abbreviations Intl understands", () => {
    // Asia/Kolkata is NOT in Intl.supportedValuesOf("timeZone") — that list
    // carries only the canonical Asia/Calcutta — which is why validation goes
    // through Intl itself rather than that list.
    for (const zone of ["Asia/Kolkata", "Asia/Calcutta", "IST", "Europe/London", "UTC", "America/New_York"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it("refuses a typo or an offset, which would disable the schedule later", () => {
    // These used to be stored happily and only threw when the next occurrence
    // was computed — at which point the runner disables the schedule.
    for (const zone of ["Asia/Kolkatta", "GMT+5:30", "india", "Not/AZone"]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });

  it("rejects an unknown zone at the schema, not at the scheduler", () => {
    const base = { name: "Digest", prompt: "summarise", trigger: "daily" as const, timeOfDay: "07:00" };
    expect(createScheduleSchema.safeParse({ ...base, timezone: "Asia/Kolkata" }).success).toBe(true);

    const bad = createScheduleSchema.safeParse({ ...base, timezone: "Asia/Kolkatta" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("Unknown time zone");
  });
});
