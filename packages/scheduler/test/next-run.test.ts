import { describe, expect, it } from "vitest";
import { assertValidTrigger, describeTrigger, InvalidTriggerError, isValidTimezone, nextRunAt } from "../src";

const at = (iso: string) => new Date(iso);

describe("nextRunAt", () => {
  it("runs daily at the chosen local time", () => {
    const settings = { trigger: "daily" as const, timezone: "UTC", timeOfDay: "08:30" };
    expect(nextRunAt(settings, at("2026-03-01T07:00:00Z"))?.toISOString()).toBe("2026-03-01T08:30:00.000Z");
    // Already past today, so tomorrow.
    expect(nextRunAt(settings, at("2026-03-01T09:00:00Z"))?.toISOString()).toBe("2026-03-02T08:30:00.000Z");
    // Exactly on the minute counts as past: the next one is tomorrow.
    expect(nextRunAt(settings, at("2026-03-01T08:30:00Z"))?.toISOString()).toBe("2026-03-02T08:30:00.000Z");
  });

  it("keeps the local time across a daylight-saving change", () => {
    const settings = { trigger: "daily" as const, timezone: "Europe/London", timeOfDay: "08:00" };
    // London is UTC+0 in winter and UTC+1 in summer; 08:00 local moves in UTC.
    expect(nextRunAt(settings, at("2026-03-28T09:00:00Z"))?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(nextRunAt(settings, at("2026-01-10T09:00:00Z"))?.toISOString()).toBe("2026-01-11T08:00:00.000Z");
  });

  it("handles a zone ahead of UTC", () => {
    const settings = { trigger: "daily" as const, timezone: "Asia/Kolkata", timeOfDay: "09:00" };
    // 09:00 IST is 03:30 UTC.
    expect(nextRunAt(settings, at("2026-05-01T00:00:00Z"))?.toISOString()).toBe("2026-05-01T03:30:00.000Z");
  });

  it("runs weekly on the chosen weekday", () => {
    const settings = { trigger: "weekly" as const, timezone: "UTC", timeOfDay: "10:00", weekday: 1 };
    // 2026-03-01 is a Sunday, so the next Monday is the 2nd.
    const next = nextRunAt(settings, at("2026-03-01T12:00:00Z"))!;
    expect(next.toISOString()).toBe("2026-03-02T10:00:00.000Z");
    expect(next.getUTCDay()).toBe(1);
    // From that moment, a week later.
    expect(nextRunAt(settings, next)?.toISOString()).toBe("2026-03-09T10:00:00.000Z");
  });

  it("runs monthly, falling back to the last day of shorter months", () => {
    const settings = { trigger: "monthly" as const, timezone: "UTC", timeOfDay: "00:00", dayOfMonth: 31 };
    expect(nextRunAt(settings, at("2026-01-31T01:00:00Z"))?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(nextRunAt(settings, at("2026-03-05T00:00:00Z"))?.toISOString()).toBe("2026-03-31T00:00:00.000Z");
    // A leap year gives February 29.
    expect(nextRunAt(settings, at("2028-02-01T00:00:00Z"))?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("supports cron expressions in the schedule's zone", () => {
    const settings = { trigger: "cron" as const, timezone: "Europe/London", cron: "0 6 * * 1-5" };
    // Saturday: the next weekday run is Monday 06:00 local (05:00 UTC in summer).
    expect(nextRunAt(settings, at("2026-07-04T12:00:00Z"))?.toISOString()).toBe("2026-07-06T05:00:00.000Z");
  });

  it("supports intervals and one-time runs", () => {
    expect(nextRunAt({ trigger: "interval", timezone: "UTC", intervalMinutes: 90 }, at("2026-03-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-03-01T01:30:00.000Z",
    );
    const runAt = at("2026-06-01T10:00:00Z");
    expect(nextRunAt({ trigger: "once", timezone: "UTC", runAt }, at("2026-05-01T00:00:00Z"))).toEqual(runAt);
    // Already past: never again.
    expect(nextRunAt({ trigger: "once", timezone: "UTC", runAt }, at("2026-07-01T00:00:00Z"))).toBeNull();
  });

  it("rejects unusable triggers", () => {
    expect(() => nextRunAt({ trigger: "daily", timezone: "Mars/Olympus", timeOfDay: "08:00" })).toThrow(InvalidTriggerError);
    expect(() => nextRunAt({ trigger: "cron", timezone: "UTC", cron: "not a cron" })).toThrow(InvalidTriggerError);
    expect(() => nextRunAt({ trigger: "daily", timezone: "UTC" })).toThrow(InvalidTriggerError);
    expect(() => nextRunAt({ trigger: "weekly", timezone: "UTC", timeOfDay: "08:00" })).toThrow(InvalidTriggerError);
    expect(() => assertValidTrigger({ trigger: "cron", timezone: "UTC", cron: "0 6 * * 1-5" })).not.toThrow();
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Nowhere/Here")).toBe(false);
  });

  it("describes triggers in plain language", () => {
    expect(describeTrigger({ trigger: "daily", timezone: "UTC", timeOfDay: "08:00" })).toBe("Every day at 08:00 (UTC)");
    expect(describeTrigger({ trigger: "weekly", timezone: "UTC", timeOfDay: "09:30", weekday: 1 })).toBe("Every Monday at 09:30 (UTC)");
    expect(describeTrigger({ trigger: "interval", timezone: "UTC", intervalMinutes: 120 })).toBe("Every 2 hour(s)");
    expect(describeTrigger({ trigger: "interval", timezone: "UTC", intervalMinutes: 45 })).toBe("Every 45 minutes");
    expect(describeTrigger({ trigger: "monthly", timezone: "UTC", timeOfDay: "00:00", dayOfMonth: 1 })).toContain("Day 1 of each month");
  });
});
