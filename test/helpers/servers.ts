import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ERROR_CODES, PREVIOUS_SPEC_VERSION, SPEC_VERSION } from "../../src/version.js";
import { decodeHeaderValue } from "../../src/http.js";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

export interface ModernServerOptions {
  tools?: Array<Record<string, unknown>>;
}

/**
 * A minimal, strict 2026-07-28 server:
 * - requires MCP-Protocol-Version, Mcp-Method (and Mcp-Name where applicable)
 * - rejects mismatches with 400 / -32020
 * - rejects unknown versions with 400 / -32022
 * - answers server/discover and tools/list with resultType and cache hints
 * - rejects initialize and unknown methods with 404 / -32601
 * - ignores Mcp-Session-Id and never echoes it
 */
export async function startModernServer(options: ModernServerOptions = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const tools = options.tools ?? [
    { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  ];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        requests.push({ method: "GET", path: request.url ?? "", headers: {} });
        response.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        send(response, 400, rpcError(null, ERROR_CODES.parseError, "Parse error"));
        return;
      }
      requests.push({ method: request.method ?? "POST", path: request.url ?? "", headers: request.headers, body });

      const id = body.id;
      const method = typeof body.method === "string" ? body.method : undefined;
      if (method === undefined) {
        response.writeHead(202).end();
        return;
      }
      const version = header(request, "mcp-protocol-version");
      const methodHeader = header(request, "mcp-method");
      const params = (body.params ?? {}) as Record<string, unknown>;
      const meta = (params._meta ?? {}) as Record<string, unknown>;

      if (!version || !methodHeader) {
        send(response, 400, rpcError(id, ERROR_CODES.headerMismatch, "Missing required MCP headers"));
        return;
      }
      if (methodHeader !== method) {
        send(response, 400, rpcError(id, ERROR_CODES.headerMismatch, `Mcp-Method ${methodHeader} does not match ${method}`));
        return;
      }
      if (meta["io.modelcontextprotocol/protocolVersion"] !== version) {
        send(response, 400, rpcError(id, ERROR_CODES.headerMismatch, "MCP-Protocol-Version does not match _meta"));
        return;
      }
      if (version !== SPEC_VERSION) {
        send(
          response,
          400,
          rpcError(id, ERROR_CODES.unsupportedProtocolVersion, `Unsupported protocol version ${version}`, {
            supported: [SPEC_VERSION],
            requested: version,
          }),
        );
        return;
      }
      if (method === "tools/call" || method === "resources/read" || method === "prompts/get") {
        const expected = method === "resources/read" ? params.uri : params.name;
        const actual = header(request, "mcp-name");
        if (typeof expected === "string" && (actual === undefined || decodeHeaderValue(actual) !== expected)) {
          send(response, 400, rpcError(id, ERROR_CODES.headerMismatch, "Mcp-Name does not match body"));
          return;
        }
      }

      switch (method) {
        case "server/discover": {
          send(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              ttlMs: 60_000,
              cacheScope: "public",
              supportedVersions: [SPEC_VERSION],
              capabilities: { tools: { listChanged: false } },
              instructions: "mock stateless server",
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-mock", version: "1.0.0" } },
            },
          });
          return;
        }
        case "tools/list": {
          send(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", ttlMs: 60_000, cacheScope: "public", tools },
          });
          return;
        }
        case "tools/call": {
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const text = typeof args.text === "string" ? args.text : JSON.stringify(args);
          send(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", content: [{ type: "text", text: `echo:${text}` }] },
          });
          return;
        }
        default: {
          send(response, 404, rpcError(id, ERROR_CODES.methodNotFound, `Method not found: ${method}`));
        }
      }
    })();
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A 2025-11-25 style server: initialize + Mcp-Session-Id, tools/list without
 * resultType or cache hints, no server/discover.
 */
export async function startLegacyServer(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let currentSession: string | undefined;
  let counter = 0;

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        send(response, 400, rpcError(null, ERROR_CODES.parseError, "Parse error"));
        return;
      }
      requests.push({ method: request.method ?? "POST", path: request.url ?? "", headers: request.headers, body });

      const id = body.id;
      const method = body.method;
      if (method === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (method === "initialize") {
        counter += 1;
        currentSession = `legacy-session-${counter}`;
        const params = (body.params ?? {}) as Record<string, unknown>;
        send(
          response,
          200,
          {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PREVIOUS_SPEC_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "legacy-mock", version: "0.9.0" },
            },
          },
          { "mcp-session-id": currentSession },
        );
        return;
      }
      if (String(method).startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      const session = header(request, "mcp-session-id");
      if (!session || session !== currentSession) {
        send(response, 404, rpcError(id, ERROR_CODES.invalidRequest, "Missing or unknown Mcp-Session-Id"));
        return;
      }
      switch (method) {
        case "tools/list":
          send(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
            },
          });
          return;
        case "tools/call": {
          const params = (body.params ?? {}) as Record<string, unknown>;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          send(response, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `legacy:${String(args.text ?? "")}` }] },
          });
          return;
        }
        default:
          send(response, 404, rpcError(id, ERROR_CODES.methodNotFound, `Method not found: ${String(method)}`));
      }
    })();
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
