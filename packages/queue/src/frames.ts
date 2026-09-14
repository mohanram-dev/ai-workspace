import type { Redis } from "ioredis";
import { KEY_PREFIX } from "./connection";

/** Live preview frames are throwaway: if nobody fetches one within this window it is gone. */
const FRAME_TTL_SECONDS = 60;

export type FrameKind = "browser" | "computer";

export interface StoredFrame {
  image: Buffer;
  seq: number;
  url: string;
}

function key(kind: FrameKind, taskId: string): string {
  return `${KEY_PREFIX}:frame:${kind}:${taskId}`;
}

/**
 * Hands the live browser/desktop preview from the worker that produced it to the
 * web process that serves it (spec §44). Only the newest frame is kept, for a
 * minute; stored screenshots stay in Postgres as before.
 */
export class RedisFrameStore {
  constructor(private readonly redis: Redis) {}

  async put(kind: FrameKind, taskId: string, frame: StoredFrame): Promise<void> {
    const payload = Buffer.concat([Buffer.from(`${frame.seq}\n${frame.url}\n`, "utf8"), frame.image]);
    await this.redis.set(key(kind, taskId), payload, "EX", FRAME_TTL_SECONDS);
  }

  async get(kind: FrameKind, taskId: string): Promise<StoredFrame | null> {
    const payload = await this.redis.getBuffer(key(kind, taskId));
    if (!payload) return null;
    const firstBreak = payload.indexOf(10);
    const secondBreak = payload.indexOf(10, firstBreak + 1);
    if (firstBreak === -1 || secondBreak === -1) return null;
    return {
      seq: Number(payload.subarray(0, firstBreak).toString("utf8")),
      url: payload.subarray(firstBreak + 1, secondBreak).toString("utf8"),
      image: payload.subarray(secondBreak + 1),
    };
  }
}
