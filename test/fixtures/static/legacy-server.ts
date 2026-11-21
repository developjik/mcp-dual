import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const server = new McpServer({ name: "legacy-http", version: "1.0.0" });

server.setRequestHandler(InitializeRequestSchema, async () => ({
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
}));

server.setRequestHandler(PingRequestSchema, async () => ({}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }],
}));

server.setRequestHandler(LoggingSetLevelRequestSchema, async () => ({}));
server.setRequestHandler(SubscribeRequestSchema, async () => ({}));

app.post("/mcp", async (req, res) => {
  const body = req.body;
  if (body.jsonrpc !== "2.0") {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const session = req.headers["mcp-session-id"];
  res.json({ jsonrpc: "2.0", id: body.id, result: { session } });
});

app.get("/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  const resume = req.headers["Last-Event-ID"];
  res.write(`data: ${JSON.stringify({ resume })}\n\n`);
});

const transport = new SSEServerTransport("/messages", response);
const redirectUri = "http://localhost/callback";
app.post("/register", (req, res) => {
  res.json({ redirect_uris: [redirectUri], client_name: req.body.client_name });
});

void transport;
void server;
void app;
