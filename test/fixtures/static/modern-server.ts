import express from "express";

const app = express();
const VERSION = "2026-07-28";

const tools = [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

app.post("/mcp", async (req, res) => {
  const version = req.headers["mcp-protocol-version"];
  const method = req.headers["mcp-method"];
  const name = req.headers["mcp-name"];
  if (version !== VERSION || !method) {
    res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32020, message: "HeaderMismatch" } });
    return;
  }
  const body = req.body;
  switch (body.method) {
    case "server/discover":
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          ttlMs: 60000,
          cacheScope: "public",
          supportedVersions: [VERSION],
          capabilities: { tools: {} },
        },
      });
      return;
    case "tools/list":
      res.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ttlMs: 60000, cacheScope: "public", tools } });
      return;
    default:
      res.status(404).json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }
  void name;
});

void app;
