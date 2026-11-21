#!/usr/bin/env node
// Minimal stdio server speaking MCP 2026-07-28 (per-request metadata, no lifecycle).
import process from "node:process";

const SPEC = "2026-07-28";
let buffer = "";

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(message) {
  const id = message.id;
  if (id === undefined) return; // notifications are ignored
  const method = message.method;
  const params = message.params ?? {};
  const version = params._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (method !== "server/discover" && version !== SPEC) {
    fail(id, -32022, `Unsupported protocol version ${version}`);
    return;
  }
  switch (method) {
    case "server/discover":
      reply(id, {
        resultType: "complete",
        ttlMs: 60000,
        cacheScope: "public",
        supportedVersions: [SPEC],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "stdio-modern-mock", version: "1.0.0" } },
      });
      return;
    case "tools/list":
      reply(id, {
        resultType: "complete",
        ttlMs: 60000,
        cacheScope: "public",
        tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      });
      return;
    case "tools/call":
      reply(id, {
        resultType: "complete",
        content: [{ type: "text", text: `stdio-echo:${String(params.arguments?.text ?? "")}` }],
      });
      return;
    case "initialize":
    case "ping":
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      fail(null, -32700, "Parse error");
    }
  }
});
