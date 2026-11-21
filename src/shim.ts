/* mcp-dual:ignore-file */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  explain,
  findResponse,
  makeNotification,
  makeRequest,
  parseJsonRpcBody,
  postJsonRpc,
  requestMeta,
  standardHeaders,
  withRequestMeta,
  PROTOCOL_VERSION_HEADER,
  SESSION_HEADER,
  type HttpExchange,
} from "./http.js";
import { StdioConnection } from "./stdio.js";
import type { ClientContext, ClientEra, JsonRpcMessage } from "./types.js";
import { ERROR_CODES, PREVIOUS_SPEC_VERSION, TOOL_NAME } from "./version.js";

export type { ClientEra };

export type UpstreamEra = "modern" | "legacy";

export type ShimMode = "auto" | "legacy-client" | "modern-client";

export interface ShimOptions {
  host?: string;
  port: number;
  upstreamHttp?: string;
  upstreamStdio?: string;
  upstreamHeaders?: Record<string, string>;
  mode?: ShimMode;
  timeoutMs?: number;
  sessionTtlMs?: number;
  log?: (message: string) => void;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface ShimSessionState extends ClientContext {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  upstreamSessionId?: string;
}

export interface ShimOutcome {
  status: number;
  era: ClientEra;
  messages: JsonRpcMessage[];
  sessionId?: string;
}

interface Upstream {
  readonly era: UpstreamEra | "unknown";
  ensureEra(): Promise<UpstreamEra>;
  discover(): Promise<Record<string, unknown>>;
  sendModern(message: JsonRpcMessage, context: ClientContext): Promise<JsonRpcMessage>;
  sendLegacy(message: JsonRpcMessage): Promise<JsonRpcMessage>;
  serverInfo(): Record<string, unknown> | undefined;
  close(): Promise<void>;
}

function serverInfoFrom(discover: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const meta = discover?._meta;
  if (typeof meta === "object" && meta !== null) {
    const info = (meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"];
    if (typeof info === "object" && info !== null) return info as Record<string, unknown>;
  }
  const direct = discover?.serverInfo;
  return typeof direct === "object" && direct !== null ? (direct as Record<string, unknown>) : undefined;
}

function legacyVersion(requested: unknown): string {
  return typeof requested === "string" && requested.length > 0 ? requested : PREVIOUS_SPEC_VERSION;
}

function errorMessage(id: JsonRpcMessage["id"], code: number, message: string): JsonRpcMessage {
  const response: JsonRpcMessage = { jsonrpc: "2.0", error: { code, message } };
  if (id !== undefined) response.id = id;
  return response;
}

function resultMessage(id: JsonRpcMessage["id"], result: unknown): JsonRpcMessage {
  const response: JsonRpcMessage = { jsonrpc: "2.0", result };
  if (id !== undefined) response.id = id;
  return response;
}

const CACHEABLE_METHODS = new Set([
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "server/discover",
]);

/** Normalize a legacy result so a 2026-07-28 client can consume it. */
function normalizeLegacyResult(
  method: string | undefined,
  response: JsonRpcMessage,
  info: Record<string, unknown> | undefined,
): JsonRpcMessage {
  if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) return response;
  const result = { ...(response.result as Record<string, unknown>) };
  if (result.resultType === undefined) result.resultType = "complete";
  if (method && CACHEABLE_METHODS.has(method)) {
    if (typeof result.ttlMs !== "number") result.ttlMs = 0;
    if (result.cacheScope !== "public" && result.cacheScope !== "private") result.cacheScope = "private";
  }
  if (info) {
    const meta = typeof result._meta === "object" && result._meta !== null ? (result._meta as Record<string, unknown>) : {};
    if (meta["io.modelcontextprotocol/serverInfo"] === undefined) {
      result._meta = { ...meta, "io.modelcontextprotocol/serverInfo": info };
    }
  }
  return { ...response, result };
}

/** HTTP upstream that auto-detects whether the server speaks the stateless revision. */
export class HttpUpstream implements Upstream {
  era: UpstreamEra | "unknown" = "unknown";
  private legacySessionId?: string;
  private initResult?: Record<string, unknown>;
  private discoverResult?: Record<string, unknown>;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 10_000,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  private async rpc(message: JsonRpcMessage, headers: Record<string, string>): Promise<{ exchange: HttpExchange; response?: JsonRpcMessage }> {
    const exchange = await postJsonRpc(this.url, message, { headers, timeoutMs: this.timeoutMs });
    const response =
      message.id !== undefined && message.id !== null ? findResponse(exchange.messages, message.id) : exchange.messages[0];
    return { exchange, response };
  }

  private async modernRpc(message: JsonRpcMessage, context: ClientContext = {}): Promise<JsonRpcMessage> {
    const translated = withRequestMeta(
      message,
      requestMeta({
        ...(context.clientInfo ? { clientInfo: context.clientInfo } : {}),
        ...(context.clientCapabilities ? { clientCapabilities: context.clientCapabilities } : {}),
        ...(context.logLevel ? { logLevel: context.logLevel } : {}),
      }),
    );
    const headers = standardHeaders(translated, { extra: this.headers });
    const { exchange, response } = await this.rpc(translated, headers);
    if (response) return response;
    if (message.id === undefined) return message;
    return errorMessage(
      message.id,
      ERROR_CODES.internalError,
      `upstream returned HTTP ${exchange.status}${exchange.bodyText.trim() ? `: ${exchange.bodyText.trim().slice(0, 300)}` : ""}`,
    );
  }

  async ensureEra(): Promise<UpstreamEra> {
    if (this.era !== "unknown") return this.era;
    let exchange: HttpExchange | undefined;
    try {
      const message = makeRequest("server/discover", { _meta: requestMeta() }, this.nextId++);
      const outcome = await this.rpc(message, standardHeaders(message, { extra: this.headers }));
      exchange = outcome.exchange;
      const result = outcome.response?.result;
      if (outcome.response && result && typeof result === "object") {
        this.era = "modern";
        this.discoverResult = result as Record<string, unknown>;
        return this.era;
      }
    } catch (error) {
      throw new UpstreamError(`Could not reach upstream ${this.url}: ${(error as Error).message}`);
    }
    try {
      await this.initializeLegacy();
      this.era = "legacy";
      return this.era;
    } catch (error) {
      throw new UpstreamError(
        `Upstream ${this.url} does not speak MCP 2026-07-28 or the 2025-11-25 lifecycle. ` +
          `server/discover returned HTTP ${exchange?.status ?? "?"}; initialize failed: ${(error as Error).message}`,
      );
    }
  }

  private async initializeLegacy(): Promise<Record<string, unknown>> {
    if (this.initResult) return this.initResult;
    const message = makeRequest(
      "initialize",
      {
        protocolVersion: PREVIOUS_SPEC_VERSION,
        capabilities: {},
        clientInfo: { name: `${TOOL_NAME}-shim`, version: "0.1.0" },
      },
      this.nextId++,
    );
    const { exchange, response } = await this.rpc(message, {
      [PROTOCOL_VERSION_HEADER]: PREVIOUS_SPEC_VERSION,
      ...this.headers,
    });
    if (!response?.result || typeof response.result !== "object") {
      throw new UpstreamError(`legacy initialize failed: HTTP ${exchange.status} · ${explain(response)}`);
    }
    this.initResult = response.result as Record<string, unknown>;
    const sessionId = exchange.headers.get("mcp-session-id");
    if (sessionId) {
      this.legacySessionId = sessionId;
      const notification = makeNotification("notifications/initialized");
      await postJsonRpc(this.url, notification, {
        headers: { [SESSION_HEADER]: sessionId, [PROTOCOL_VERSION_HEADER]: PREVIOUS_SPEC_VERSION, ...this.headers },
        timeoutMs: this.timeoutMs,
      }).catch(() => undefined);
    }
    this.log(`upstream ${this.url} speaks the legacy lifecycle${this.legacySessionId ? " with a session id" : ""}`);
    return this.initResult;
  }

  async discover(): Promise<Record<string, unknown>> {
    const era = await this.ensureEra();
    if (era === "modern") {
      if (this.discoverResult) return this.discoverResult;
      const message = makeRequest("server/discover", { _meta: requestMeta() }, this.nextId++);
      const { exchange, response } = await this.rpc(message, standardHeaders(message, { extra: this.headers }));
      if (!response?.result || typeof response.result !== "object") {
        throw new UpstreamError(`server/discover failed: HTTP ${exchange.status} · ${explain(response)}`);
      }
      this.discoverResult = response.result as Record<string, unknown>;
      return this.discoverResult;
    }
    const init = await this.initializeLegacy();
    return {
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      supportedVersions: [legacyVersion(init.protocolVersion)],
      capabilities: init.capabilities ?? {},
      ...(typeof init.instructions === "string" ? { instructions: init.instructions } : {}),
      _meta: {
        "io.modelcontextprotocol/serverInfo": (init.serverInfo as Record<string, unknown> | undefined) ?? {
          name: `${TOOL_NAME}-shim`,
          version: "0.1.0",
        },
      },
    };
  }

  async sendModern(message: JsonRpcMessage, context: ClientContext): Promise<JsonRpcMessage> {
    await this.ensureEra();
    return this.modernRpc(message, context);
  }

  async sendLegacy(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    await this.ensureEra();
    const init = await this.initializeLegacy();
    const headers: Record<string, string> = {
      [PROTOCOL_VERSION_HEADER]: legacyVersion(init.protocolVersion),
      ...this.headers,
    };
    const sessionId = this.legacySessionId;
    if (sessionId) headers[SESSION_HEADER] = sessionId;
    const sent = { ...message };
    if (sent.method === "initialize" && sent.params) {
      sent.params = { ...sent.params, protocolVersion: legacyVersion(init.protocolVersion) };
    }
    const { exchange, response } = await this.rpc(sent, headers);
    if (response) return response;
    if (message.id === undefined) return message;
    return errorMessage(
      message.id,
      ERROR_CODES.internalError,
      `legacy upstream returned HTTP ${exchange.status}${exchange.bodyText.trim() ? `: ${exchange.bodyText.trim().slice(0, 300)}` : ""}`,
    );
  }

  serverInfo(): Record<string, unknown> | undefined {
    return serverInfoFrom(this.discoverResult) ?? (this.initResult?.serverInfo as Record<string, unknown> | undefined);
  }

  async close(): Promise<void> {
    // Stateless upstream: nothing to close.
  }
}

/** stdio upstream, used when the shim fronts a local command instead of an HTTP endpoint. */
export class StdioUpstream implements Upstream {
  era: UpstreamEra | "unknown" = "unknown";
  private connection?: StdioConnection;
  private initResult?: Record<string, unknown>;
  private discoverResult?: Record<string, unknown>;

  constructor(
    private readonly command: string,
    private readonly timeoutMs = 10_000,
    private readonly log: (message: string) => void = () => undefined,
    private readonly cwd?: string,
  ) {}

  private connect(): StdioConnection {
    if (!this.connection) {
      this.connection = StdioConnection.start(this.command, this.cwd ? { cwd: this.cwd } : {});
    }
    return this.connection;
  }

  async ensureEra(): Promise<UpstreamEra> {
    if (this.era !== "unknown") return this.era;
    const connection = this.connect();
    const discover = await connection.request("server/discover", { _meta: requestMeta() }, this.timeoutMs);
    if (discover.result && typeof discover.result === "object") {
      this.era = "modern";
      this.discoverResult = discover.result as Record<string, unknown>;
      return this.era;
    }
    const init = await this.initializeLegacy();
    if (!init) throw new UpstreamError("stdio upstream does not implement server/discover or initialize");
    this.era = "legacy";
    return this.era;
  }

  private async initializeLegacy(): Promise<Record<string, unknown> | undefined> {
    if (this.initResult) return this.initResult;
    const connection = this.connect();
    const response = await connection.request(
      "initialize",
      {
        protocolVersion: PREVIOUS_SPEC_VERSION,
        capabilities: {},
        clientInfo: { name: `${TOOL_NAME}-shim`, version: "0.1.0" },
      },
      this.timeoutMs,
    );
    if (!response.result || typeof response.result !== "object") return undefined;
    this.initResult = response.result as Record<string, unknown>;
    connection.notify("notifications/initialized");
    this.log(`stdio upstream speaks the legacy lifecycle`);
    return this.initResult;
  }

  async discover(): Promise<Record<string, unknown>> {
    const era = await this.ensureEra();
    if (era === "modern") {
      if (this.discoverResult) return this.discoverResult;
      const response = await this.connect().request("server/discover", { _meta: requestMeta() }, this.timeoutMs);
      this.discoverResult =
        response.result && typeof response.result === "object" ? (response.result as Record<string, unknown>) : {};
      return this.discoverResult;
    }
    const init = (await this.initializeLegacy()) ?? {};
    return {
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      supportedVersions: [legacyVersion(init.protocolVersion)],
      capabilities: init.capabilities ?? {},
      ...(typeof init.instructions === "string" ? { instructions: init.instructions } : {}),
      _meta: {
        "io.modelcontextprotocol/serverInfo": (init.serverInfo as Record<string, unknown> | undefined) ?? {
          name: `${TOOL_NAME}-shim`,
          version: "0.1.0",
        },
      },
    };
  }

  async sendModern(message: JsonRpcMessage, context: ClientContext): Promise<JsonRpcMessage> {
    await this.ensureEra();
    const translated = withRequestMeta(
      message,
      requestMeta({
        ...(context.clientInfo ? { clientInfo: context.clientInfo } : {}),
        ...(context.clientCapabilities ? { clientCapabilities: context.clientCapabilities } : {}),
        ...(context.logLevel ? { logLevel: context.logLevel } : {}),
      }),
    );
    return this.connect().send(translated, this.timeoutMs);
  }

  async sendLegacy(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    await this.ensureEra();
    await this.initializeLegacy();
    return this.connect().send(message, this.timeoutMs);
  }

  serverInfo(): Record<string, unknown> | undefined {
    return serverInfoFrom(this.discoverResult) ?? (this.initResult?.serverInfo as Record<string, unknown> | undefined);
  }

  async close(): Promise<void> {
    await this.connection?.close();
  }
}

/** Translate legacy client traffic into stateless requests, and modern traffic into legacy lifecycle requests. */
export class ShimEngine {
  readonly sessions = new Map<string, ShimSessionState>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly upstream: Upstream,
    private readonly options: { mode?: ShimMode; sessionTtlMs?: number; log?: (message: string) => void } = {},
  ) {
    const ttl = options.sessionTtlMs ?? 30 * 60_000;
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - ttl;
      for (const [id, session] of this.sessions) {
        if (session.lastUsedAt < cutoff) this.sessions.delete(id);
      }
    }, Math.min(ttl, 60_000));
    this.cleanupTimer.unref();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  eraFor(message: JsonRpcMessage, sessionId: string | undefined): ClientEra {
    if (this.options.mode === "legacy-client") return "legacy";
    if (this.options.mode === "modern-client") return "modern";
    if (message.method === "initialize" || sessionId !== undefined) return "legacy";
    return "modern";
  }

  async handle(message: JsonRpcMessage, sessionId?: string): Promise<ShimOutcome> {
    const era = this.eraFor(message, sessionId);
    try {
      return era === "legacy" ? await this.handleLegacy(message, sessionId) : await this.handleModern(message);
    } catch (error) {
      this.log(`upstream error: ${(error as Error).message}`);
      const isUpstream = error instanceof UpstreamError;
      return {
        status: isUpstream ? 502 : 500,
        era,
        messages: message.id === undefined ? [] : [
          errorMessage(message.id, ERROR_CODES.internalError, `mcp-dual shim: ${(error as Error).message}`),
        ],
      };
    }
  }

  private session(sessionId: string | undefined): ShimSessionState | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsedAt = Date.now();
    return session;
  }

  private async handleLegacy(message: JsonRpcMessage, sessionId: string | undefined): Promise<ShimOutcome> {
    const upstreamEra = await this.upstream.ensureEra();
    let session = this.session(sessionId);
    if (sessionId && !session) {
      return {
        status: 404,
        era: "legacy",
        messages: [errorMessage(message.id, ERROR_CODES.invalidRequest, `Unknown shim session ${sessionId}`)],
      };
    }

    if (message.method === "initialize" && message.id !== undefined) {
      const params = message.params ?? {};
      const discover = await this.upstream.discover();
      const id = `shim_${randomUUID()}`;
      session = {
        id,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        ...(typeof params.clientInfo === "object" && params.clientInfo !== null
          ? { clientInfo: params.clientInfo as { name: string; version: string } }
          : {}),
        ...(typeof params.capabilities === "object" && params.capabilities !== null
          ? { clientCapabilities: params.capabilities as Record<string, unknown> }
          : {}),
      };
      this.sessions.set(id, session);
      const result = {
        protocolVersion: legacyVersion(params.protocolVersion),
        capabilities: discover.capabilities ?? {},
        serverInfo:
          (discover._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/serverInfo"] ?? {
            name: `${TOOL_NAME}-shim`,
            version: "0.1.0",
          },
        ...(typeof discover.instructions === "string" ? { instructions: discover.instructions } : {}),
      };
      this.log(`legacy client initialized → shim session ${id} (upstream: ${upstreamEra})`);
      return { status: 200, era: "legacy", messages: [resultMessage(message.id, result)], sessionId: id };
    }

    if (message.method === "notifications/initialized") {
      return { status: 202, era: "legacy", messages: [] };
    }

    // Utilities removed from the core protocol are answered locally.
    if (message.method === "ping" && upstreamEra === "modern") {
      return { status: 200, era: "legacy", messages: [resultMessage(message.id, {})] };
    }
    if (message.method === "logging/setLevel") {
      if (session && typeof message.params?.level === "string") session.logLevel = message.params.level;
      if (upstreamEra === "modern") {
        return { status: 200, era: "legacy", messages: [resultMessage(message.id, {})] };
      }
    }

    if (upstreamEra === "modern") {
      const response = await this.upstream.sendModern(message, {
        ...(session?.clientInfo ? { clientInfo: session.clientInfo } : {}),
        ...(session?.clientCapabilities ? { clientCapabilities: session.clientCapabilities } : {}),
        ...(session?.logLevel ? { logLevel: session.logLevel } : {}),
      });
      if (message.id === undefined) return { status: 202, era: "legacy", messages: [] };
      return { status: 200, era: "legacy", messages: [response] };
    }

    const response = await this.upstream.sendLegacy(message);
    if (message.id === undefined) return { status: 202, era: "legacy", messages: [] };
    return { status: 200, era: "legacy", messages: [response] };
  }

  private async handleModern(message: JsonRpcMessage): Promise<ShimOutcome> {
    const upstreamEra = await this.upstream.ensureEra();

    if (upstreamEra === "modern") {
      const response = await this.upstream.sendModern(message, {});
      if (message.id === undefined) return { status: 202, era: "modern", messages: [] };
      return { status: 200, era: "modern", messages: [response] };
    }

    if (message.method === "server/discover") {
      const discover = await this.upstream.discover();
      if (message.id === undefined) return { status: 202, era: "modern", messages: [] };
      return { status: 200, era: "modern", messages: [resultMessage(message.id, discover)] };
    }

    if (message.method === "subscriptions/listen") {
      return {
        status: 501,
        era: "modern",
        messages: [
          errorMessage(
            message.id,
            ERROR_CODES.methodNotFound,
            "subscriptions/listen is not bridged to a legacy upstream; the legacy server only has GET streams.",
          ),
        ],
      };
    }

    if (message.method === "ping") {
      return {
        status: 200,
        era: "modern",
        messages: [errorMessage(message.id, ERROR_CODES.methodNotFound, "ping was removed in MCP 2026-07-28")],
      };
    }

    const response = await this.upstream.sendLegacy(message);
    if (message.id === undefined) return { status: 202, era: "modern", messages: [] };
    return {
      status: 200,
      era: "modern",
      messages: [normalizeLegacyResult(message.method, response, this.upstream.serverInfo())],
    };
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }
}

export async function createUpstream(options: ShimOptions): Promise<Upstream> {
  const log = options.log ?? (() => undefined);
  if (options.upstreamHttp && options.upstreamStdio) {
    throw new UpstreamError("Pass either --upstream-http or --upstream-stdio, not both.");
  }
  if (options.upstreamHttp) {
    return new HttpUpstream(
      options.upstreamHttp,
      options.upstreamHeaders ?? {},
      options.timeoutMs ?? 10_000,
      log,
    );
  }
  if (options.upstreamStdio) {
    return new StdioUpstream(options.upstreamStdio, options.timeoutMs ?? 10_000, log);
  }
  throw new UpstreamError("A shim upstream is required: --upstream-http <url> or --upstream-stdio <command>.");
}

async function readBody(request: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

export interface RunningShim {
  url: string;
  port: number;
  server: Server;
  engine: ShimEngine;
  upstreamEra: () => UpstreamEra | "unknown";
  close: () => Promise<void>;
}

/** Start the HTTP shim. Port 0 picks a free port (used by tests). */
export async function startShim(options: ShimOptions): Promise<RunningShim> {
  const upstream = await createUpstream(options);
  const engine = new ShimEngine(upstream, {
    mode: options.mode ?? "auto",
    ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  });

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, engine, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeJson(response, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERROR_CODES.internalError, message: `mcp-dual shim: ${(error as Error).message}` },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const host = options.host ?? "127.0.0.1";
  options.log?.(`shim listening on http://${host}:${port}`);

  return {
    url: `http://${host}:${port}`,
    port,
    server,
    engine,
    upstreamEra: () => upstream.era,
    close: async () => {
      engine.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await upstream.close();
    },
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  engine: ShimEngine,
  options: ShimOptions,
): Promise<void> {
  const sessionId = typeof request.headers[SESSION_HEADER.toLowerCase()] === "string"
    ? (request.headers[SESSION_HEADER.toLowerCase()] as string)
    : undefined;

  if (request.method === "GET") {
    writeJson(response, 405, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: ERROR_CODES.invalidRequest,
        message: "The standalone GET SSE stream was removed in MCP 2026-07-28. Use POST subscriptions/listen.",
      },
    });
    return;
  }

  if (request.method === "DELETE") {
    if (sessionId && engine.sessions.delete(sessionId)) {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(404).end();
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST, DELETE" }).end();
    return;
  }

  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    writeJson(response, 413, {
      jsonrpc: "2.0",
      id: null,
      error: { code: ERROR_CODES.invalidRequest, message: (error as Error).message },
    });
    return;
  }

  const parsed = parseJsonRpcBody(body);
  if (parsed.length === 0) {
    writeJson(response, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: ERROR_CODES.parseError, message: "Body is not a JSON-RPC message" },
    });
    return;
  }

  const messages: JsonRpcMessage[] = [];
  let status = 202;
  let responseSession: string | undefined;
  let era: ClientEra = "modern";
  for (const message of parsed) {
    const outcome = await engine.handle(message, sessionId);
    era = outcome.era;
    if (outcome.messages.length > 0) {
      messages.push(...outcome.messages.filter((entry) => entry.id !== undefined || entry.error !== undefined));
      status = outcome.status;
    }
    if (outcome.sessionId) responseSession = outcome.sessionId;
  }

  const headers: Record<string, string> = {};
  if (responseSession) headers[SESSION_HEADER] = responseSession;
  if (messages.length === 0) {
    response.writeHead(status === 202 ? 202 : status, headers).end();
    return;
  }
  if (parsed.length > 1) {
    writeJson(response, status, messages, headers);
  } else {
    writeJson(response, status, messages[0] ?? messages, headers);
  }
  options.log?.(`${parsed.length} message(s) relayed as ${era} traffic`);
}

/**
 * Run the shim over stdin/stdout (a stdio-facing proxy). The client era is
 * inferred from the first request: an `initialize` means a legacy client.
 */
export async function runStdioShim(options: ShimOptions): Promise<void> {
  const upstream = await createUpstream(options);
  const engine = new ShimEngine(upstream, {
    mode: options.mode ?? "auto",
    ...(options.log ? { log: options.log } : {}),
  });
  let connectionEra: ClientEra | undefined;
  let buffer = "";
  let queue: Promise<void> = Promise.resolve();
  const handleLine = (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(errorMessage(null, ERROR_CODES.parseError, "Invalid JSON"))}\n`);
      return Promise.resolve();
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const run = async (): Promise<void> => {
      for (const message of messages) {
        if (typeof message !== "object" || message === null) continue;
        const candidate = message as JsonRpcMessage;
        if (candidate.jsonrpc !== "2.0") continue;
        connectionEra ??= candidate.method === "initialize" ? "legacy" : "modern";
        const outcome = await engine.handle(candidate);
        if (outcome.messages.length > 0) {
          for (const entry of outcome.messages) {
            if (entry.id !== undefined || entry.error !== undefined) {
              process.stdout.write(`${JSON.stringify(entry)}\n`);
            }
          }
        }
      }
    };
    queue = queue.then(run, run);
    return queue;
  };

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk as string;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await handleLine(line);
    }
  }
  if (buffer.trim()) await handleLine(buffer.trim());
  engine.dispose();
  await upstream.close();
  if (connectionEra === "legacy") options.log?.("stdio client session ended");
}

