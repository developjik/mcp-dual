import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const server = new Server(
  { name: "legacy-demo", version: "1.0.0" },
  { capabilities: { tools: {}, logging: {} } },
);

server.setRequestHandler(InitializeRequestSchema, async (request) => {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "legacy-demo", version: "1.0.0" },
  };
});

server.setRequestHandler(PingRequestSchema, async () => ({}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const session = request.params._meta?.["Mcp-Session-Id"];
  return {
    content: [{ type: "text", text: `echo:${String(request.params.arguments?.text ?? "")} session=${String(session)}` }],
  };
});

server.setRequestHandler(LoggingSetLevelRequestSchema, async () => ({}));

server.setRequestHandler(SubscribeRequestSchema, async () => ({}));

const transport = new SSEServerTransport("/messages", response);

void transport;
void server;
