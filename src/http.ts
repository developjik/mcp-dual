/* mcp-dual:ignore-file */
/**
 * Minimal JSON-RPC 2.0 helpers for the MCP Streamable HTTP transport.
 *
 * Deliberately dependency-free: the migration kit must be able to probe
 * servers that use any SDK version, including ones this project cannot load.
 */
import { ERROR_CODES, SPEC_VERSION } from "./version.js";
import type { JsonRpcErrorShape, JsonRpcMessage, JsonRpcRequest } from "./types.js";

export interface ExchangeOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpExchange {
  status: number;
  headers: Headers;
  messages: JsonRpcMessage[];
  bodyText: string;
  contentType: string;
  /** True when the timeout fired before the response completed. */
  timedOut: boolean;
}

const JSON_CONTENT_TYPE = "application/json";
const ACCEPT = "application/json, text/event-stream";

/** Name of the header that mirrors `params.name` / `params.uri`. */
export const MCP_NAME_HEADER = "Mcp-Name";
export const MCP_METHOD_HEADER = "Mcp-Method";
export const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
export const SESSION_HEADER = "Mcp-Session-Id";

export function makeRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  id: string | number,
): JsonRpcRequest {
  const message: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) message.params = params;
  return message;
}

export function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcMessage {
  const message: JsonRpcMessage = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  return message;
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && (typeof candidate.method === "string" || "result" in candidate || "error" in candidate);
}

export function isJsonRpcError(value: JsonRpcMessage | undefined): value is JsonRpcMessage & { error: JsonRpcErrorShape } {
  return Boolean(value && value.error && typeof value.error.code === "number");
}

export function findResponse(messages: JsonRpcMessage[], id: string | number): JsonRpcMessage | undefined {
  return messages.find((message) => message.id === id && (message.result !== undefined || message.error !== undefined));
}

/**
 * The 2026-07-28 request `_meta` block. Every request must carry the protocol
 * version and client capabilities; client identity is a SHOULD.
 */
export function requestMeta(options: {
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  logLevel?: string;
  extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    "io.modelcontextprotocol/protocolVersion": options.protocolVersion ?? SPEC_VERSION,
    "io.modelcontextprotocol/clientCapabilities": options.clientCapabilities ?? {},
  };
  const info = options.clientInfo ?? { name: "mcp-dual", version: "0.1.0" };
  meta["io.modelcontextprotocol/clientInfo"] = info;
  if (options.logLevel) meta["io.modelcontextprotocol/logLevel"] = options.logLevel;
  if (options.extra) Object.assign(meta, options.extra);
  return meta;
}

/** Merge the required `_meta` fields into an existing request without clobbering client values. */
export function withRequestMeta(
  message: JsonRpcMessage,
  meta: Record<string, unknown>,
): JsonRpcMessage {
  const params = { ...(message.params ?? {}) };
  const existing = typeof params._meta === "object" && params._meta !== null ? (params._meta as Record<string, unknown>) : {};
  params._meta = { ...meta, ...existing };
  return { ...message, params };
}

/** The principal name that must be mirrored into `Mcp-Name`. */
export function principalName(message: JsonRpcMessage): string | undefined {
  const params = message.params ?? {};
  if (message.method === "tools/call" || message.method === "prompts/get") {
    return typeof params.name === "string" ? params.name : undefined;
  }
  if (message.method === "resources/read") {
    return typeof params.uri === "string" ? params.uri : undefined;
  }
  return undefined;
}

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";
const HEADER_SAFE = /^[\x20-\x7E]*$/;

/**
 * Encode a value for an MCP HTTP header. Values that are not safely
 * representable use the `=?base64?…?=` sentinel from the specification.
 */
export function encodeHeaderValue(value: string): string {
  const needsEncoding =
    value.length === 0 ||
    !HEADER_SAFE.test(value) ||
    value.trim() !== value ||
    (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX));
  if (!needsEncoding) return value;
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

/** Decode a header value produced by `encodeHeaderValue`. */
export function decodeHeaderValue(value: string): string {
  if (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, value.length - BASE64_SENTINEL_SUFFIX.length);
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  return value;
}

export interface HeaderOptions {
  protocolVersion?: string;
  includeProtocolVersion?: boolean;
  includeMethod?: boolean;
  includeName?: boolean;
  extra?: Record<string, string>;
}

/** Build the standard MCP request headers that mirror body fields. */
export function standardHeaders(message: JsonRpcMessage, options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.includeProtocolVersion !== false) {
    headers[PROTOCOL_VERSION_HEADER] = options.protocolVersion ?? SPEC_VERSION;
  }
  if (options.includeMethod !== false && message.method) {
    headers[MCP_METHOD_HEADER] = message.method;
  }
  if (options.includeName !== false) {
    const name = principalName(message);
    if (name !== undefined) headers[MCP_NAME_HEADER] = encodeHeaderValue(name);
  }
  return { ...headers, ...(options.extra ?? {}) };
}

/** HTTP status that a stateless server must use for `HeaderMismatch`. */
export function isHeaderMismatch(message: JsonRpcMessage | undefined): boolean {
  return isJsonRpcError(message) && message.error.code === ERROR_CODES.headerMismatch;
}

export function isUnsupportedVersion(message: JsonRpcMessage | undefined): boolean {
  return isJsonRpcError(message) && message.error.code === ERROR_CODES.unsupportedProtocolVersion;
}

export function explain(message: JsonRpcMessage | undefined): string {
  if (!message) return "no JSON-RPC response";
  if (message.error) {
    const data = message.error.data as { supported?: unknown } | undefined;
    const supported = Array.isArray(data?.supported) ? ` (supported: ${data.supported.join(", ")})` : "";
    return `JSON-RPC error ${message.error.code}: ${message.error.message}${supported}`;
  }
  if (message.result !== undefined) return "JSON-RPC result";
  return "JSON-RPC message without result or error";
}

/** Parse a JSON body that may be a single message, a batch, or newline-delimited JSON. */
export function parseJsonRpcBody(body: string): JsonRpcMessage[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(isJsonRpcMessage);
    if (isJsonRpcMessage(parsed)) return [parsed];
    return [];
  } catch {
    // Some servers stream one JSON object per line without SSE framing.
    const messages: JsonRpcMessage[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isJsonRpcMessage(parsed)) messages.push(parsed);
      } catch {
        // ignore non-JSON lines
      }
    }
    return messages;
  }
}

/** Extract JSON-RPC messages from an SSE stream chunk. */
export function parseSseEvents(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    try {
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) messages.push(...parsed.filter(isJsonRpcMessage));
      else if (isJsonRpcMessage(parsed)) messages.push(parsed);
    } catch {
      // SSE comments and non-JSON data are ignored.
    }
  }
  return messages;
}

interface ReadOutcome {
  text: string;
  messages: JsonRpcMessage[];
  timedOut: boolean;
}

async function readResponseBody(
  response: Response,
  expectedId: string | number | undefined,
  timeoutMs: number,
): Promise<ReadOutcome> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body) return { text: "", messages: [], timedOut: false };

  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    return { text, messages: parseJsonRpcBody(text), timedOut: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let messages: JsonRpcMessage[] = [];
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    while (true) {
      const read = reader.read();
      const outcome = await Promise.race([
        read.then((chunk) => ({ kind: "read" as const, chunk })),
        deadline.then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind === "timeout") {
        timedOut = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (outcome.chunk.done) {
        buffer += decoder.decode();
        text += buffer;
        messages = messages.concat(parseSseEvents(buffer));
        break;
      }
      const chunkText = decoder.decode(outcome.chunk.value, { stream: true });
      text += chunkText;
      buffer += chunkText;
      // Process complete SSE events; keep the trailing partial event buffered.
      const lastBreak = buffer.lastIndexOf("\n\n");
      if (lastBreak !== -1) {
        const complete = buffer.slice(0, lastBreak + 2);
        buffer = buffer.slice(lastBreak + 2);
        messages = messages.concat(parseSseEvents(complete));
        if (expectedId !== undefined && findResponse(messages, expectedId)) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { text, messages, timedOut };
}

/** POST one JSON-RPC message (or batch) to an MCP endpoint and collect responses. */
export async function postJsonRpc(
  url: string,
  payload: JsonRpcMessage | JsonRpcMessage[],
  options: ExchangeOptions = {},
): Promise<HttpExchange> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const headers: Record<string, string> = {
    "content-type": JSON_CONTENT_TYPE,
    accept: ACCEPT,
    ...(options.headers ?? {}),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const expectedId = Array.isArray(payload) ? undefined : payload.id ?? undefined;
    const body = await readResponseBody(response, expectedId, timeoutMs);
    return {
      status: response.status,
      headers: response.headers,
      messages: body.messages,
      bodyText: body.text,
      contentType: response.headers.get("content-type") ?? "",
      timedOut: body.timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Send a plain GET, used to check that the retired standalone SSE stream returns 405. */
export async function getEndpoint(url: string, timeoutMs = 5_000): Promise<{ status: number; headers: Headers; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream, application/json" },
      signal: controller.signal,
    });
    // Do not wait for a long-lived stream: read what is immediately available, then cancel.
    let bodyText = "";
    if (response.body) {
      const reader = response.body.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
      ]);
      if (first && !first.done) bodyText = new TextDecoder().decode(first.value);
      await reader.cancel().catch(() => undefined);
    }
    return { status: response.status, headers: response.headers, bodyText };
  } finally {
    clearTimeout(timer);
  }
}
