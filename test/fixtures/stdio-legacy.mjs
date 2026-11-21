#!/usr/bin/env node
// Minimal stdio server speaking the pre-stateless lifecycle (initialize + no _meta).
import process from "node:process";

let buffer = "";
let initialized = false;

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(message) {
  const id = message.id;
  const method = message.method;
  if (method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "stdio-legacy-mock", version: "0.9.0" },
    });
    return;
  }
  if (id === undefined) return;
  switch (method) {
    case "tools/list":
      reply(id, { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
      return;
    case "tools/call":
      reply(id, { content: [{ type: "text", text: `stdio-legacy:${String(message.params?.arguments?.text ?? "")}` }] });
      return;
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
  void initialized;
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
