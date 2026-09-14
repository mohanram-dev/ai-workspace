import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";
import { ToolError } from "./types";

/** True for loopback, private, link-local, CGNAT, multicast, reserved and cloud-metadata ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return true;
}

/**
 * DNS lookup that refuses private addresses. Used as the socket's lookup
 * function, so the check applies to the exact address connected to (no DNS
 * rebinding window between check and connect).
 */
export function createSafeLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      const list = addresses as LookupAddress[];
      const blocked = list.find((a) => !allowPrivate && isPrivateAddress(a.address));
      if (blocked || list.length === 0) {
        const err = Object.assign(new Error(`Blocked request to a private or reserved address (${hostname}).`), { code: "EBLOCKED" });
        return callback(err, "", 4);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      const first = list[0]!;
      callback(null, first.address, first.family);
    });
  };
}

export interface FetchOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  allowPrivateNetwork?: boolean;
  userAgent?: string;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function validateUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("invalid_input", "The URL is not valid.");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new ToolError("invalid_input", "Only http and https URLs can be fetched.");
  if (url.username || url.password) throw new ToolError("invalid_input", "URLs with credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))) {
    throw new ToolError("permission_denied", "Requests to local or private network addresses are blocked.");
  }
  return url;
}

/**
 * Fetches a public URL with SSRF protection: http(s) only, private addresses
 * refused at connect time (including after redirects), bounded size and time.
 */
export async function safeFetch(rawUrl: string, options: FetchOptions): Promise<FetchResult> {
  const allowPrivate = options.allowPrivateNetwork ?? false;
  let url = validateUrl(rawUrl, allowPrivate);
  const lookup = createSafeLookup(allowPrivate);
  const maxRedirects = options.maxRedirects ?? 5;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);

  for (let redirects = 0; ; redirects++) {
    const response = await request(url, lookup, signal, options);
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects >= maxRedirects) throw new ToolError("failed", "Too many redirects.");
      url = validateUrl(new URL(response.location, url).toString(), allowPrivate);
      continue;
    }
    return { ...response.result, url: url.toString() };
  }
}

function request(
  url: URL,
  lookup: LookupFunction,
  signal: AbortSignal,
  options: FetchOptions,
): Promise<{ status: number; location: string | null; result: Omit<FetchResult, "url"> }> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: {
          "User-Agent": options.userAgent ?? "AIWorkspaceBot/1.0 (+self-hosted agent workspace)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, result: emptyResult(status) });
        }

        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? res.pipe(zlib.createInflate())
              : encoding === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;

        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          if (bytes + chunk.length > options.maxBytes) {
            chunks.push(chunk.subarray(0, options.maxBytes - bytes));
            bytes = options.maxBytes;
            truncated = true;
            req.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({
            status,
            location: null,
            result: {
              status,
              contentType: String(res.headers["content-type"] ?? ""),
              body: Buffer.concat(chunks).toString("utf8"),
              bytes,
              truncated,
            },
          });
        };
        stream.on("end", finish);
        stream.on("error", (error) => (truncated ? finish() : reject(toFetchError(error, signal))));
      },
    );
    req.on("error", (error) => reject(toFetchError(error, signal)));
    req.end();
  });
}

function emptyResult(status: number): Omit<FetchResult, "url"> {
  return { status, contentType: "", body: "", bytes: 0, truncated: false };
}

function toFetchError(error: Error & { code?: string }, signal: AbortSignal): ToolError {
  if (error.code === "EBLOCKED") return new ToolError("permission_denied", error.message);
  if (signal.aborted) return new ToolError("timeout", "The request timed out or was cancelled.");
  if (error.code === "ENOTFOUND") return new ToolError("not_found", "The host name could not be resolved.");
  return new ToolError("failed", `The request failed (${error.code ?? error.message}).`);
}

export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` replacement with the same SSRF protection as `safeFetch`, but
 * streaming the response body (for protocol clients such as MCP over
 * Streamable HTTP). Redirects are not followed; the caller sees the 3xx.
 */
export function createGuardedFetch(options: { allowPrivateNetwork: boolean }): GuardedFetch {
  const lookup = createSafeLookup(options.allowPrivateNetwork);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = validateUrl(request.url, options.allowPrivateNetwork);
    const body = request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    if (body) headers["content-length"] = String(body.length);

    const transport = url.protocol === "https:" ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const req = transport.request(url, { method: request.method, headers, lookup, signal: request.signal }, (res) => {
        const status = res.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        if (NULL_BODY_STATUSES.has(status) || request.method === "HEAD") {
          res.resume();
          return resolve(new Response(null, { status, headers: responseHeaders }));
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => controller.close());
            res.on("error", (error) => controller.error(error));
          },
          cancel() {
            res.destroy();
          },
        });
        resolve(new Response(stream, { status, headers: responseHeaders }));
      });
      req.on("error", (error: Error & { code?: string }) => {
        if (request.signal.aborted) return reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
        reject(toFetchError(error, request.signal));
      });
      req.end(body ?? undefined);
    });
  };
}
