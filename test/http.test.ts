import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRequest, parseSseEvents, postJsonRpc } from "../src/http.js";

const result = { jsonrpc: "2.0", id: 1, result: { text: "한글" } };
const notification = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
const request = makeRequest("tools/list", {}, 1);

afterEach(() => vi.restoreAllMocks());

function mockOpenStream(chunks: string[]) {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately keep the stream open, as MCP servers may do.
    },
    cancel,
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  }));
  return cancel;
}

for (const [name, eol] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]] as const) {
  describe(`SSE ${name} framing`, () => {
    const event = `data: ${JSON.stringify(result)}${eol}${eol}`;

    it("parses standalone events and multiline data", () => {
      const text = `: comment${eol}event: message${eol}data: {"jsonrpc":"2.0",${eol}data: "id":1,"result":{"text":"한글"}}${eol}${eol}`;
      expect(parseSseEvents(text)).toEqual([result]);
    });

    it("returns the matching response without waiting for stream closure", async () => {
      const cancel = mockOpenStream([event]);
      const response = await postJsonRpc("http://localhost/mcp", request, { timeoutMs: 250 });
      expect(response.timedOut).toBe(false);
      expect(response.messages).toEqual([result]);
      expect(response.bodyText).toBe(event);
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("handles every character arriving in a separate chunk", async () => {
      const text = `data: ${JSON.stringify(notification)}${eol}${eol}${event}`;
      const cancel = mockOpenStream([...text]);
      const response = await postJsonRpc("http://localhost/mcp", request, { timeoutMs: 250 });
      expect(response.timedOut).toBe(false);
      expect(response.messages).toEqual([notification, result]);
      // A CR dispatches immediately; the final LF of CRLF may remain unread.
      expect(text.startsWith(response.bodyText)).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("decodes UTF-8 characters split across byte-sized chunks", async () => {
      const encoded = new TextEncoder().encode(event);
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < encoded.length; i++) controller.enqueue(encoded.slice(i, i + 1));
        },
        cancel,
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }));
      const response = await postJsonRpc("http://localhost/mcp", request, { timeoutMs: 250 });
      expect(response.messages).toEqual([result]);
      expect(response.bodyText).not.toContain("\uFFFD");
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("works over real HTTP while the server keeps the response open", async () => {
      let server: Server | undefined;
      try {
        server = createServer((incoming, outgoing) => {
          incoming.resume();
          outgoing.writeHead(200, { "content-type": "text/event-stream" });
          outgoing.write(event);
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing server port");
        const response = await postJsonRpc(`http://127.0.0.1:${address.port}`, request, { timeoutMs: 500 });
        expect(response.timedOut).toBe(false);
        expect(response.messages).toEqual([result]);
      } finally {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    });
  });
}

describe("SSE stream collection", () => {
  it("handles mixed newlines, multiline data, and split CRLF without duplicate events", async () => {
    const cancel = mockOpenStream([
      `data: ${JSON.stringify(notification)}\r`,
      `\n\r`,
      `\ndata: {"jsonrpc":"2.0",\r`,
      `\ndata: "id":1,"result":{"text":"한글"}}\r`,
      "\n\r",
      "\n",
    ]);
    const response = await postJsonRpc("http://localhost/mcp", request, { timeoutMs: 250 });
    expect(response.timedOut).toBe(false);
    expect(response.messages).toEqual([notification, result]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps waiting when only a notification or a different response id arrives", async () => {
    const text = `data: ${JSON.stringify(notification)}\r\n\r\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\r\n\r\n`;
    const cancel = mockOpenStream([text]);
    const response = await postJsonRpc("http://localhost/mcp", request, { timeoutMs: 30 });
    expect(response.timedOut).toBe(true);
    expect(response.messages).toHaveLength(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not duplicate the trailing event text when a stream closes", async () => {
    const text = `data: ${JSON.stringify(notification)}\r\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(text, {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await postJsonRpc("http://localhost/mcp", request);
    expect(response.messages).toEqual([notification]);
    expect(response.bodyText).toBe(text);
    expect(response.timedOut).toBe(false);
  });

  it("leaves ordinary JSON responses unchanged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    }));
    const response = await postJsonRpc("http://localhost/mcp", request);
    expect(response.messages).toEqual([result]);
    expect(response.bodyText).toBe(JSON.stringify(result));
  });
});
