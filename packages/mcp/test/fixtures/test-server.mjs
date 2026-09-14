// A real MCP server used by the tests. Usage:
//   node test-server.mjs stdio
//   node test-server.mjs http <port> [bearer-token]   (prints "listening <port>")
import http from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const notes = new Map();

function createServer() {
  const server = new McpServer({ name: "aiw-test-server", version: "1.2.3" });
  // MCP_TEST_HIDE=a,b leaves tools out, to simulate a server that changed.
  const hidden = new Set((process.env.MCP_TEST_HIDE ?? "").split(","));
  const register = server.registerTool.bind(server);
  server.registerTool = (name, ...rest) => (hidden.has(name) ? undefined : register(name, ...rest));
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "add",
    {
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
      annotations: { readOnlyHint: true },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }], structuredContent: { sum: a + b } }),
  );
  server.registerTool(
    "write_note",
    { description: "Store a note", inputSchema: z.object({ name: z.string(), text: z.string() }) },
    async ({ name, text }) => {
      notes.set(name, text);
      return { content: [{ type: "text", text: `saved ${name}` }] };
    },
  );
  server.registerTool(
    "delete_note",
    { description: "Delete a note", inputSchema: z.object({ name: z.string() }), annotations: { destructiveHint: true } },
    async ({ name }) => ({ content: [{ type: "text", text: `deleted ${notes.delete(name)}` }] }),
  );
  server.registerTool("fail", { description: "Always fails", inputSchema: z.object({}) }, async () => ({
    isError: true,
    content: [{ type: "text", text: "something went wrong on the server" }],
  }));
  server.registerTool(
    "slow",
    { description: "Waits", inputSchema: z.object({ ms: z.number() }), annotations: { readOnlyHint: true } },
    async ({ ms }, ctx) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        ctx.mcpReq.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return { content: [{ type: "text", text: `waited ${ms}` }] };
    },
  );
  server.registerTool("image", { description: "Returns an image", inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
    content: [
      { type: "text", text: "here is a pixel" },
      { type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
    ],
  }));
  server.registerTool("env", { description: "Reports environment", inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          token: process.env.MCP_TEST_TOKEN ?? null,
          leaked: process.env.AIW_SERVER_SECRET ?? null,
          cwd: process.cwd(),
          pid: process.pid,
        }),
      },
    ],
  }));
  return server;
}

const [mode, portArg, token] = process.argv.slice(2);

if (mode === "http") {
  const httpServer = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });
    // Stateless: a fresh server and transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createServer();
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  httpServer.listen(Number(portArg ?? 0), "127.0.0.1", () => {
    console.log(`listening ${httpServer.address().port}`);
  });
} else {
  await createServer().connect(new StdioServerTransport());
}
