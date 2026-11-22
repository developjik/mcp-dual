import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startShim, type RunningShim } from "../src/shim.js";
import { parseSseEvents } from "../src/http.js";
import type { JsonRpcMessage } from "../src/types.js";
import { startLegacyServer, startModernServer } from "./helpers/servers.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function rpc(
  url: string,
  body: JsonRpcMessage | JsonRpcMessage[],
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: JsonRpcMessage | JsonRpcMessage[] | undefined }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[]) : undefined,
  };
}

async function track<T extends { close: () => Promise<void> }>(resource: T): Promise<T> {
  cleanups.push(() => resource.close());
  return resource;
}

function result(message: JsonRpcMessage | JsonRpcMessage[] | undefined): Record<string, unknown> {
  const single = Array.isArray(message) ? message[0] : message;
  expect(single?.result).toBeDefined();
  return single?.result as Record<string, unknown>;
}

async function startProtocolShim(options: Parameters<typeof startShim>[0]): Promise<RunningShim> {
  const shim = await startShim(options);
  cleanups.push(() => shim.close());
  return shim;
}

describe("shim: legacy client → stateless server", () => {
  it("bridges initialize, session id and stateless requests", async () => {
    const modern = await track(await startModernServer());
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });

    const initialize = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-client", version: "1.0.0" } },
    });
    expect(initialize.status).toBe(200);
    const initResult = result(initialize.body);
    expect(initResult.capabilities).toEqual({ tools: { listChanged: false } });
    expect(initResult.protocolVersion).toBe("2025-11-25");
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^shim_/);

    const list = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-session-id": sessionId as string },
    );
    expect(list.status).toBe(200);
    expect((result(list.body).tools as unknown[]).length).toBe(2);

    const call = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } },
      { "mcp-session-id": sessionId as string },
    );
    expect((result(call.body).content as Array<{ text: string }>)[0]?.text).toBe("echo:hello");

    // Utilities removed from the new core are answered locally.
    const ping = await rpc(shim.url, { jsonrpc: "2.0", id: 4, method: "ping" }, { "mcp-session-id": sessionId as string });
    expect(ping.status).toBe(200);
    expect(result(ping.body)).toEqual({});

    // The session id must never reach the stateless upstream.
    const upstreamSessions = modern.requests.filter((request) => request.headers["mcp-session-id"] !== undefined);
    expect(upstreamSessions).toEqual([]);

    // Unknown session is rejected like a legacy server would.
    const unknown = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      { "mcp-session-id": "shim_missing" },
    );
    expect(unknown.status).toBe(404);

    // DELETE terminates the shim session.
    const deleted = await fetch(shim.url, { method: "DELETE", headers: { "mcp-session-id": sessionId as string } });
    expect(deleted.status).toBe(200);
    const afterDelete = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
      { "mcp-session-id": sessionId as string },
    );
    expect(afterDelete.status).toBe(404);
  });

  it("retires the GET stream with 405", async () => {
    const modern = await track(await startModernServer());
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });
    const response = await fetch(shim.url, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
  });
});

describe("shim: modern client → legacy server", () => {
  it("synthesizes server/discover and normalizes legacy results", async () => {
    const legacy = await track(await startLegacyServer());
    const shim = await startProtocolShim({ port: 0, upstreamHttp: legacy.url });

    const discover = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(discover.status).toBe(200);
    const discoverResult = result(discover.body);
    expect(discoverResult.supportedVersions).toEqual(["2025-11-25"]);
    expect(discoverResult.resultType).toBe("complete");
    expect(discoverResult.capabilities).toEqual({ tools: { listChanged: false } });

    const list = await rpc(shim.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listResult = result(list.body);
    expect(listResult.resultType).toBe("complete");
    expect(listResult.ttlMs).toBe(0);
    expect(listResult.cacheScope).toBe("private");
    expect((listResult.tools as unknown[]).length).toBe(1);

    const call = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    const callResult = result(call.body);
    expect(callResult.resultType).toBe("complete");
    expect((callResult.content as Array<{ text: string }>)[0]?.text).toBe("legacy:hi");

    // The legacy session id is kept by the shim, not exposed to the modern client.
    expect(legacy.requests.some((request) => request.headers["mcp-session-id"] !== undefined)).toBe(true);
  });
});

describe("shim: SSE notification relay", () => {
  const progress = {
    jsonrpc: "2.0" as const,
    method: "notifications/progress",
    params: { progressToken: "t1", progress: 0.5, total: 1 },
  };
  const message = {
    jsonrpc: "2.0" as const,
    method: "notifications/message",
    params: { level: "info", data: "half way" },
  };

  async function post(url: string, body: JsonRpcMessage, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("relays progress/message notifications to a modern client as SSE", async () => {
    const modern = await track(await startModernServer({ callNotifications: [progress, message] }));
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });

    const response = await post(shim.url, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events.map((entry) => entry.method)).toEqual([
      "notifications/progress",
      "notifications/message",
      undefined,
    ]);
    const final = events.at(-1);
    expect(final?.id).toBe(9);
    expect((final?.result as Record<string, unknown>).resultType).toBe("complete");
  });

  it("relays progress/message notifications to a legacy client as SSE", async () => {
    const modern = await track(await startModernServer({ callNotifications: [progress, message] }));
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });

    const initialize = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    const sessionId = initialize.headers.get("mcp-session-id") as string;

    const response = await post(
      shim.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
      { "mcp-session-id": sessionId },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events.map((entry) => entry.method)).toEqual([
      "notifications/progress",
      "notifications/message",
      undefined,
    ]);
    expect(events.at(-1)?.id).toBe(2);
  });

  it("keeps a plain JSON response when the upstream streams no notifications", async () => {
    const modern = await track(await startModernServer());
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });
    const response = await post(shim.url, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("shim: subscriptions/listen", () => {
  it("bridges listen to the legacy upstream GET stream", async () => {
    const legacy = await track(
      await startLegacyServer({
        getStreamEvents: [
          {
            jsonrpc: "2.0",
            method: "notifications/resources/updated",
            params: { uri: "res://watched" },
          },
        ],
      }),
    );
    const shim = await startProtocolShim({ port: 0, upstreamHttp: legacy.url });

    // A modern client must discover the shim first so the upstream session exists.
    await rpc(shim.url, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });

    const response = await fetch(shim.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {} }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events[0]?.method).toBe("notifications/resources/updated");
    expect((events[0]?.params as Record<string, unknown>).uri).toBe("res://watched");

    // The bridge issued a GET against the legacy upstream carrying its session id.
    const get = legacy.requests.find((entry) => entry.method === "GET");
    expect(get).toBeDefined();
    expect(String(get?.headers["mcp-session-id"])).toMatch(/^legacy-session-/);
  });

  it("passes listen through to a stateless upstream stream", async () => {
    const modern = await track(
      await startModernServer({
        listenEvents: [{ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } }],
      }),
    );
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });

    const response = await fetch(shim.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: {} }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events[0]?.method).toBe("notifications/message");
  });

  it("returns the upstream reply when a stateless server rejects listen", async () => {
    const modern = await track(await startModernServer());
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });
    const outcome = await rpc(shim.url, { jsonrpc: "2.0", id: 8, method: "subscriptions/listen", params: {} });
    const single = Array.isArray(outcome.body) ? outcome.body[0] : outcome.body;
    expect(single?.error?.code).toBe(-32601);
  });

  it("returns 501 for a stdio upstream (documented unsupported)", async () => {
    const shim = await startProtocolShim({
      port: 0,
      upstreamStdio: `node "${fixture("stdio-legacy.mjs")}"`,
    });
    const outcome = await rpc(shim.url, { jsonrpc: "2.0", id: 9, method: "subscriptions/listen", params: {} });
    expect(outcome.status).toBe(501);
    const single = Array.isArray(outcome.body) ? outcome.body[0] : outcome.body;
    expect(single?.error?.code).toBe(-32601);
  });
});

describe("shim: MRTR input_required scope", () => {
  it("passes an input_required result through to a legacy client unchanged", async () => {
    const modern = await track(
      await startModernServer({
        callResult: {
          resultType: "input_required",
          inputRequests: [
            { method: "elicitation/create", params: { message: "confirm?" } },
          ],
        },
      }),
    );
    const shim = await startProtocolShim({ port: 0, upstreamHttp: modern.url });

    const initialize = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    const sessionId = initialize.headers.get("mcp-session-id") as string;

    const call = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } },
      { "mcp-session-id": sessionId },
    );
    const callResult = result(call.body);
    // Defined scope: the shim relays MRTR payloads verbatim; it does not
    // simulate sampling/elicitation for a legacy client.
    expect(callResult.resultType).toBe("input_required");
    expect((callResult.inputRequests as Array<{ method: string }>)[0]?.method).toBe("elicitation/create");
  });
});

describe("shim: stdio upstream", () => {
  it("bridges a legacy client to a stateless stdio server", async () => {
    const shim = await startProtocolShim({
      port: 0,
      upstreamStdio: `node "${fixture("stdio-modern.mjs")}"`,
    });
    const initialize = await rpc(shim.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(result(initialize.body).capabilities).toEqual({ tools: {} });

    const list = await rpc(
      shim.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-session-id": sessionId as string },
    );
    expect((result(list.body).tools as unknown[]).length).toBe(1);
  });

  it("bridges a modern client to a legacy stdio server", async () => {
    const shim = await startProtocolShim({
      port: 0,
      upstreamStdio: `node "${fixture("stdio-legacy.mjs")}"`,
    });
    const discover = await rpc(shim.url, { jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(result(discover.body).supportedVersions).toEqual(["2025-11-25"]);
    const list = await rpc(shim.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listResult = result(list.body);
    expect(listResult.resultType).toBe("complete");
    expect(listResult.ttlMs).toBe(0);
  });
});
