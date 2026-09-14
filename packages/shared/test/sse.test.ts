import { describe, expect, it } from "vitest";
import { encodeSseFrame, parseSseStream } from "../src/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: unknown[] = [];
  for await (const item of parseSseStream(stream)) out.push(item);
  return out;
}

describe("SSE framing", () => {
  it("round-trips events including newlines in payloads", async () => {
    const events = [{ type: "delta", text: "line 1\nline 2\n\n" }, { type: "done" }];
    const wire = events.map(encodeSseFrame).join("");
    expect(await collect(streamOf([wire]))).toEqual(events);
  });

  it("handles frames split across arbitrary chunk boundaries", async () => {
    const events = [{ a: 1 }, { b: "héllo \u{1F30D}" }, { c: [1, 2, 3] }];
    const wire = events.map(encodeSseFrame).join("");
    const bytes = new TextEncoder().encode(wire);
    // Split on raw byte boundaries so multi-byte characters get cut in half.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual(events);
  });

  it("ignores comments and blank frames", async () => {
    const frames = [": keep-alive\n\n", "\n\n", `data: ${JSON.stringify({ x: 1 })}\n\n`];
    expect(await collect(streamOf(frames))).toEqual([{ x: 1 }]);
  });
});
