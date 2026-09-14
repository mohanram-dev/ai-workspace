import http from "node:http";
import net, { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { createSafeLookup, isPrivateAddress } from "@aiw/tools";

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` for Chromium's --proxy-server. */
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]);

function blockedHost(host: string, allowPrivate: boolean): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (allowPrivate) return false;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  // The lookup function is not consulted for IP literals, so check them here.
  return isIP(bare) !== 0 && isPrivateAddress(bare);
}

const BLOCKED_PAGE =
  "<!doctype html><title>Blocked</title><body style=\"font-family:system-ui;padding:2rem\"><h1>Blocked by AI Workspace</h1><p>Requests to local or private network addresses are not allowed from the agent browser.</p></body>";

/**
 * Local forward proxy for the agent browser. Every connection is made here with
 * the SSRF-safe DNS lookup, so pages cannot reach loopback, private or cloud
 * metadata addresses, including through redirects, subresources or DNS rebinding.
 * HTTPS is tunnelled (CONNECT) without inspection.
 */
export async function startEgressProxy(options: { allowPrivateNetwork: boolean }): Promise<EgressProxy> {
  const lookup = createSafeLookup(options.allowPrivateNetwork);
  const sockets = new Set<Duplex>();

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    if (blockedHost(url.hostname, options.allowPrivateNetwork)) {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(BLOCKED_PAGE);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(key)) headers[key] = value;
    const upstream = http.request(
      { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, lookup },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(key)) responseHeaders[key] = value;
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error: Error & { code?: string }) => {
      if (res.headersSent) return res.destroy();
      if (error.code === "EBLOCKED") res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(BLOCKED_PAGE);
      else res.writeHead(502).end();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    if (!match) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = match[1]!.replace(/^\[|\]$/g, "");
    const port = Number(match[2]);
    if (blockedHost(host, options.allowPrivateNetwork)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host, port, lookup });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (error: Error & { code?: string }) => {
      if (!client.destroyed) client.end(error.code === "EBLOCKED" ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
