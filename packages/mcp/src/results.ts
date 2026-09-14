const MAX_STORED_TEXT = 20_000;

export interface ConvertedToolResult {
  /** Text for the model. */
  text: string;
  /** JSON stored with the tool call (binary payloads replaced by their size). */
  output: { isError: boolean; content: unknown[]; structuredContent?: unknown };
  isError: boolean;
}

type Block = { type?: unknown; [key: string]: unknown };

/**
 * Converts an MCP `tools/call` result. Text and text resources reach the
 * model; images, audio and binary resources are described but not forwarded
 * (the model call does not carry media yet).
 */
export function convertToolResult(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): ConvertedToolResult {
  const blocks = Array.isArray(result.content) ? (result.content as Block[]) : [];
  const texts: string[] = [];
  const stored: unknown[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = String(block.text ?? "");
        texts.push(text);
        stored.push({ type: "text", text: clip(text, MAX_STORED_TEXT) });
        break;
      }
      case "image":
      case "audio": {
        const bytes = base64Bytes(block.data);
        const mimeType = String(block.mimeType ?? "application/octet-stream");
        texts.push(`[${block.type} ${mimeType}, ${bytes} bytes: not shown to the model]`);
        stored.push({ type: block.type, mimeType, bytes });
        break;
      }
      case "resource_link": {
        const name = String(block.name ?? block.uri ?? "resource");
        texts.push(`[resource link: ${name} ${String(block.uri ?? "")}]`.trim());
        stored.push({ type: "resource_link", name, uri: block.uri ?? null, mimeType: block.mimeType ?? null });
        break;
      }
      case "resource": {
        const resource = (block.resource ?? {}) as Record<string, unknown>;
        const uri = String(resource.uri ?? "");
        if (typeof resource.text === "string") {
          texts.push(`[resource ${uri}]\n${resource.text}`);
          stored.push({ type: "resource", uri, mimeType: resource.mimeType ?? null, text: clip(resource.text, MAX_STORED_TEXT) });
        } else {
          const bytes = base64Bytes(resource.blob);
          texts.push(`[resource ${uri}, ${bytes} bytes of binary data: not shown to the model]`);
          stored.push({ type: "resource", uri, mimeType: resource.mimeType ?? null, bytes });
        }
        break;
      }
      default:
        stored.push({ type: String(block.type ?? "unknown") });
    }
  }

  const hasStructured = result.structuredContent !== undefined && result.structuredContent !== null;
  let text = texts.join("\n").trim();
  if (!text && hasStructured) text = JSON.stringify(result.structuredContent);
  const isError = result.isError === true;

  return {
    text,
    isError,
    output: { isError, content: stored, ...(hasStructured ? { structuredContent: result.structuredContent } : {}) },
  };
}

function base64Bytes(data: unknown): number {
  if (typeof data !== "string") return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} characters]` : text;
}
