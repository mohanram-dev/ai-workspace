import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit";

describe("FixedWindowRateLimiter", () => {
  it("limits per key within a window and resets afterwards", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);

    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check("a")).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check("b").allowed).toBe(true);

    now = 30_000;
    expect(limiter.check("a")).toMatchObject({ allowed: false, retryAfterSeconds: 30 });

    now = 60_000;
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
  });
});
