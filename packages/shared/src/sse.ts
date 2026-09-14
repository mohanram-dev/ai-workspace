/**
 * Minimal Server-Sent Events framing used for POST streaming responses.
 * EventSource only supports GET, so the client reads the body with fetch and
 * parses frames with `parseSseStream`.
 */

export function encodeSseFrame(data: unknown): string {
  // JSON.stringify never emits raw newlines, so one `data:` line is enough.
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed !== undefined) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        const parsed = parseFrame(buffer);
        if (parsed !== undefined) yield parsed;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): unknown {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return undefined;
  return JSON.parse(data);
}
