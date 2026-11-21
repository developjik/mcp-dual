/* mcp-dual:ignore-file */
import {
  explain,
  findResponse,
  getEndpoint,
  isHeaderMismatch,
  isUnsupportedVersion,
  makeRequest,
  postJsonRpc,
  requestMeta,
  standardHeaders,
  MCP_METHOD_HEADER,
  SESSION_HEADER,
  type HttpExchange,
} from "./http.js";
import { StdioConnection } from "./stdio.js";
import type {
  CheckReport,
  CheckResult,
  CheckSummary,
  CompatibilityStatus,
  ProbeReport,
  Requirement,
  Verdict,
} from "./types.js";
import { ERROR_CODES, SPEC_VERSION, TOOL_NAME } from "./version.js";

export interface HttpProbeOptions {
  timeoutMs?: number;
  /** Extra headers sent on every request (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface StdioProbeOptions {
  timeoutMs?: number;
  cwd?: string;
}

let requestId = 1;
function nextId(): number {
  requestId += 1;
  return requestId;
}

export function summarizeChecks(checks: CheckResult[]): CheckSummary {
  const summary: CheckSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.verdict] += 1;
  return summary;
}

function check(
  id: string,
  title: string,
  requirement: Requirement,
  verdict: Verdict,
  detail: string,
  evidence?: Record<string, unknown>,
): CheckResult {
  return { id, title, requirement, verdict, detail, ...(evidence ? { evidence } : {}) };
}

function statusDetail(exchange: HttpExchange, response?: ReturnType<typeof findResponse>): string {
  const parts = [`HTTP ${exchange.status}`];
  if (exchange.timedOut) parts.push("timed out");
  const target = response ?? exchange.messages[0];
  if (target) parts.push(explain(target));
  else if (exchange.bodyText.trim()) parts.push(`body: ${exchange.bodyText.trim().slice(0, 160)}`);
  return parts.join(" · ");
}

interface CallResult {
  exchange: HttpExchange;
  response: ReturnType<typeof findResponse>;
}

async function call(
  url: string,
  method: string,
  params: Record<string, unknown>,
  options: HttpProbeOptions,
  headerOverrides: {
    includeMethod?: boolean;
    includeName?: boolean;
    includeProtocolVersion?: boolean;
    protocolVersion?: string;
    extra?: Record<string, string>;
  } = {},
): Promise<CallResult> {
  const id = nextId();
  const message = makeRequest(method, params, id);
  const headers = standardHeaders(message, {
    protocolVersion: headerOverrides.protocolVersion ?? SPEC_VERSION,
    ...(headerOverrides.includeMethod !== undefined ? { includeMethod: headerOverrides.includeMethod } : {}),
    ...(headerOverrides.includeName !== undefined ? { includeName: headerOverrides.includeName } : {}),
    ...(headerOverrides.includeProtocolVersion !== undefined
      ? { includeProtocolVersion: headerOverrides.includeProtocolVersion }
      : {}),
    extra: { ...(options.headers ?? {}), ...(headerOverrides.extra ?? {}) },
  });
  const exchange = await postJsonRpc(url, message, { headers, timeoutMs: options.timeoutMs ?? 5_000 });
  return { exchange, response: findResponse(exchange.messages, id) };
}

function resultOf(result: CallResult | undefined): Record<string, unknown> | undefined {
  if (!result?.response || result.response.result === undefined) return undefined;
  const value = result.response.result;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Exercise a live HTTP MCP endpoint against the mandatory and recommended
 * behaviors of the 2026-07-28 revision.
 */
export async function probeHttp(url: string, options: HttpProbeOptions = {}): Promise<ProbeReport> {
  const startedAt = new Date();
  const checks: CheckResult[] = [];

  let discover: CallResult;
  try {
    discover = await call(url, "server/discover", { _meta: requestMeta() }, options);
  } catch (error) {
    checks.push(
      check("reachable", "Endpoint reachable", "must", "fail", `Could not reach ${url}: ${(error as Error).message}`),
    );
    return finalize("http", url, checks, startedAt, "unreachable");
  }
  checks.push(check("reachable", "Endpoint reachable", "must", "pass", "Received an HTTP response from the MCP endpoint."));

  const discoverResult = resultOf(discover);
  const supportedVersions = discoverResult?.supportedVersions;
  if (discover.exchange.status === 200 && discoverResult && Array.isArray(supportedVersions)) {
    const hasSpec = supportedVersions.includes(SPEC_VERSION);
    const hasCapabilities = typeof discoverResult.capabilities === "object" && discoverResult.capabilities !== null;
    const serverInfo = (discoverResult._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/serverInfo"];
    const who = serverInfo && typeof serverInfo === "object" ? ` · server ${JSON.stringify(serverInfo)}` : "";
    if (hasSpec && hasCapabilities) {
      checks.push(
        check(
          "server-discover",
          "server/discover implemented",
          "must",
          "pass",
          `Advertises ${supportedVersions.join(", ")} with capabilities${who}`,
          { supportedVersions },
        ),
      );
    } else {
      checks.push(
        check(
          "server-discover",
          "server/discover implemented",
          "must",
          "fail",
          hasSpec
            ? "server/discover answered but capabilities are missing."
            : `server/discover answered but does not list ${SPEC_VERSION} (supported: ${supportedVersions.join(", ")}).`,
          { supportedVersions },
        ),
      );
    }
  } else if (isUnsupportedVersion(discover.response)) {
    const data = discover.response?.error?.data as { supported?: string[] } | undefined;
    checks.push(
      check(
        "server-discover",
        "server/discover implemented",
        "must",
        "fail",
        `Version probe rejected: ${explain(discover.response)}`,
        { supported: data?.supported ?? [] },
      ),
    );
  } else {
    checks.push(
      check(
        "server-discover",
        "server/discover implemented",
        "must",
        "fail",
        statusDetail(discover.exchange, discover.response),
        { status: discover.exchange.status, errorCode: discover.response?.error?.code },
      ),
    );
  }

  // Stateless tools/list: no initialize, no Mcp-Session-Id.
  let toolsList: CallResult | undefined;
  try {
    toolsList = await call(url, "tools/list", { _meta: requestMeta() }, options);
  } catch (error) {
    checks.push(check("stateless-request", "Stateless request accepted", "must", "fail", `Request failed: ${(error as Error).message}`));
  }
  const toolsResult = resultOf(toolsList);
  if (toolsList) {
    const tools = toolsResult?.tools;
    if (toolsList.exchange.status === 200 && Array.isArray(tools)) {
      checks.push(
        check(
          "stateless-request",
          "Stateless request accepted",
          "must",
          "pass",
          `tools/list answered with ${tools.length} tool(s) without initialize or a session.`,
          { tools: tools.length },
        ),
      );
    } else {
      checks.push(
        check(
          "stateless-request",
          "Stateless request accepted",
          "must",
          "fail",
          statusDetail(toolsList.exchange, toolsList.response),
          { status: toolsList.exchange.status, errorCode: toolsList.response?.error?.code },
        ),
      );
    }
  }

  // resultType on results.
  if (toolsResult) {
    checks.push(
      check(
        "result-type",
        "Results carry resultType",
        "must",
        toolsResult.resultType === "complete" ? "pass" : "fail",
        toolsResult.resultType === "complete"
          ? 'tools/list returned resultType: "complete".'
          : `tools/list result has resultType=${JSON.stringify(toolsResult.resultType)}.`,
        { resultType: toolsResult.resultType },
      ),
    );
    // Cache hints on list results.
    const ttl = toolsResult.ttlMs;
    const scope = toolsResult.cacheScope;
    const cacheOk = typeof ttl === "number" && (scope === "public" || scope === "private");
    checks.push(
      check(
        "cache-hints",
        "List results are cacheable",
        "should",
        cacheOk ? "pass" : "warn",
        cacheOk
          ? `ttlMs=${ttl}, cacheScope=${String(scope)}`
          : `Missing ttlMs/cacheScope (ttlMs=${JSON.stringify(ttl)}, cacheScope=${JSON.stringify(scope)}).`,
        { ttlMs: ttl, cacheScope: scope },
      ),
    );
  } else {
    checks.push(check("result-type", "Results carry resultType", "must", "skip", "tools/list did not return a result."));
    checks.push(check("cache-hints", "List results are cacheable", "should", "skip", "tools/list did not return a result."));
  }

  // Header mirroring: correct headers are required, mismatches must be rejected.
  const mismatch = await call(url, "tools/list", { _meta: requestMeta() }, options, {
    extra: { [MCP_METHOD_HEADER]: "tools/call" },
  });
  if (mismatch.exchange.status === 400 && isHeaderMismatch(mismatch.response)) {
    checks.push(
      check(
        "header-mismatch",
        "Header/body mismatch rejected",
        "must",
        "pass",
        "Mismatched Mcp-Method returned HTTP 400 with -32020 HeaderMismatch.",
      ),
    );
  } else if (mismatch.exchange.status === 400) {
    checks.push(
      check(
        "header-mismatch",
        "Header/body mismatch rejected",
        "must",
        "warn",
        `Rejected with HTTP 400 but not with -32020: ${statusDetail(mismatch.exchange, mismatch.response)}`,
      ),
    );
  } else {
    checks.push(
      check(
        "header-mismatch",
        "Header/body mismatch rejected",
        "must",
        "fail",
        `Server accepted a mismatched Mcp-Method header (${statusDetail(mismatch.exchange, mismatch.response)}).`,
      ),
    );
  }

  const missingMethod = await call(url, "tools/list", { _meta: requestMeta() }, options, { includeMethod: false });
  if (missingMethod.exchange.status === 400 && isHeaderMismatch(missingMethod.response)) {
    checks.push(
      check(
        "header-required",
        "Mcp-Method header required",
        "must",
        "pass",
        "A request without Mcp-Method was rejected with HTTP 400 / -32020.",
      ),
    );
  } else {
    checks.push(
      check(
        "header-required",
        "Mcp-Method header required",
        "must",
        "fail",
        `A request without Mcp-Method was not rejected as required (${statusDetail(missingMethod.exchange, missingMethod.response)}).`,
      ),
    );
  }

  const missingVersionHeader = await call(url, "tools/list", { _meta: requestMeta() }, options, {
    includeProtocolVersion: false,
  });
  if (missingVersionHeader.exchange.status === 400 && isHeaderMismatch(missingVersionHeader.response)) {
    checks.push(
      check(
        "protocol-version-header",
        "MCP-Protocol-Version header required",
        "must",
        "pass",
        "A request without MCP-Protocol-Version was rejected with HTTP 400 / -32020.",
      ),
    );
  } else {
    checks.push(
      check(
        "protocol-version-header",
        "MCP-Protocol-Version header required",
        "must",
        "fail",
        `A request without MCP-Protocol-Version was not rejected as required (${statusDetail(
          missingVersionHeader.exchange,
          missingVersionHeader.response,
        )}).`,
      ),
    );
  }

  const bogusVersion = "2099-01-01";
  const versionProbe = await call(url, "tools/list", { _meta: requestMeta({ protocolVersion: bogusVersion }) }, options, {
    protocolVersion: bogusVersion,
  });
  const versionData = versionProbe.response?.error?.data as { supported?: string[] } | undefined;
  if (isUnsupportedVersion(versionProbe.response)) {
    const supported = Array.isArray(versionData?.supported) ? versionData?.supported : [];
    const listsSpec = supported.includes(SPEC_VERSION);
    checks.push(
      check(
        "version-negotiation",
        "Unknown versions rejected with supported list",
        "must",
        listsSpec ? "pass" : "warn",
        listsSpec
          ? `-32022 returned with supported: ${supported.join(", ")}.`
          : `-32022 returned but ${SPEC_VERSION} is not in supported: ${supported.join(", ") || "(empty)"}.`,
        { supported },
      ),
    );
  } else {
    checks.push(
      check(
        "version-negotiation",
        "Unknown versions rejected with supported list",
        "must",
        "fail",
        `Unknown protocol version ${bogusVersion} was not rejected: ${statusDetail(versionProbe.exchange, versionProbe.response)}`,
      ),
    );
  }

  // Session header must be ignored, never echoed.
  const bogusSession = `mcp-dual-probe-${Date.now()}`;
  const sessionProbe = await call(url, "tools/list", { _meta: requestMeta() }, options, {
    extra: { [SESSION_HEADER]: bogusSession },
  });
  const echoedSession = sessionProbe.exchange.headers.get("mcp-session-id");
  if (sessionProbe.exchange.status === 200 && !echoedSession) {
    checks.push(
      check(
        "session-removed",
        "Mcp-Session-Id ignored",
        "must",
        "pass",
        "A request carrying Mcp-Session-Id was served and no session id was returned.",
      ),
    );
  } else {
    checks.push(
      check(
        "session-removed",
        "Mcp-Session-Id ignored",
        "must",
        "fail",
        echoedSession
          ? `Server returned Mcp-Session-Id: ${echoedSession} — the transport is still session-based.`
          : statusDetail(sessionProbe.exchange, sessionProbe.response),
      ),
    );
  }

  // Legacy handshake must be gone.
  const initialize = await call(
    url,
    "initialize",
    {
      protocolVersion: SPEC_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-dual", version: "0.1.0" },
      _meta: requestMeta(),
    },
    options,
  );
  const initializeResult = resultOf(initialize);
  if (initialize.response?.error) {
    checks.push(
      check(
        "initialize-retired",
        "Legacy initialize retired",
        "should",
        "pass",
        `initialize returned ${explain(initialize.response)}.`,
      ),
    );
  } else if (initialize.exchange.status === 200 && initializeResult) {
    checks.push(
      check(
        "initialize-retired",
        "Legacy initialize retired",
        "should",
        "warn",
        `initialize still handshakes (protocolVersion=${JSON.stringify(initializeResult.protocolVersion)}); this is a dual-era server.`,
      ),
    );
  } else {
    checks.push(
      check(
        "initialize-retired",
        "Legacy initialize retired",
        "should",
        "warn",
        `initialize did not produce a modern handshake or a JSON-RPC error (${statusDetail(initialize.exchange, initialize.response)}).`,
      ),
    );
  }

  // Retired GET stream.
  try {
    const get = await getEndpoint(url, options.timeoutMs ?? 5_000);
    if (get.status === 405) {
      checks.push(check("get-endpoint", "GET stream retired (405)", "should", "pass", "GET returned 405 Method Not Allowed."));
    } else if (get.status === 200) {
      checks.push(
        check("get-endpoint", "GET stream retired (405)", "should", "warn", "GET opened a stream; use subscriptions/listen instead."),
      );
    } else {
      checks.push(check("get-endpoint", "GET stream retired (405)", "should", "warn", `GET returned HTTP ${get.status}.`));
    }
  } catch (error) {
    checks.push(check("get-endpoint", "GET stream retired (405)", "should", "skip", `GET failed: ${(error as Error).message}`));
  }

  // Unknown methods must be 404 + -32601.
  const unknown = await call(url, "mcp-dual/unknown-method", { _meta: requestMeta() }, options);
  const unknownCode = unknown.response?.error?.code;
  if (unknownCode === ERROR_CODES.methodNotFound) {
    checks.push(
      check(
        "unknown-method",
        "Unknown methods return Method not found",
        "must",
        unknown.exchange.status === 404 ? "pass" : "warn",
        unknown.exchange.status === 404
          ? "Unknown method returned HTTP 404 with -32601."
          : `Unknown method returned -32601 but HTTP ${unknown.exchange.status} (spec requires 404).`,
      ),
    );
  } else {
    checks.push(
      check(
        "unknown-method",
        "Unknown methods return Method not found",
        "must",
        "fail",
        statusDetail(unknown.exchange, unknown.response),
      ),
    );
  }

  checks.push(
    check(
      "subscriptions-listen",
      "subscriptions/listen available",
      "should",
      "skip",
      "Not probed: it requires holding a long-lived POST response stream open.",
    ),
  );

  const modernEvidence = checks.some(
    (entry) => entry.id === "server-discover" && entry.verdict === "pass",
  ) || checks.some((entry) => entry.id === "stateless-request" && entry.verdict === "pass");
  const mustFailures = checks.some((entry) => entry.requirement === "must" && entry.verdict === "fail");
  const status: CompatibilityStatus = !modernEvidence ? "legacy" : mustFailures ? "partial" : "compatible";
  return finalize("http", url, checks, startedAt, status);
}

/** Exercise a live stdio MCP server. HTTP-only checks are reported as skipped. */
export async function probeStdio(command: string, options: StdioProbeOptions = {}): Promise<ProbeReport> {
  const startedAt = new Date();
  const checks: CheckResult[] = [];
  const timeoutMs = options.timeoutMs ?? 5_000;
  const connection = StdioConnection.start(command, options.cwd ? { cwd: options.cwd } : {});
  const skipHttpChecks = (): void => {
    for (const [id, title] of [
      ["header-mismatch", "Header/body mismatch rejected"],
      ["header-required", "Mcp-Method header required"],
      ["protocol-version-header", "MCP-Protocol-Version header required"],
      ["get-endpoint", "GET stream retired (405)"],
      ["session-removed", "Mcp-Session-Id ignored"],
    ] as const) {
      checks.push(check(id, title, "must", "skip", "HTTP transport checks do not apply to stdio."));
    }
  };

  try {
    await probeStdioChecks(connection, checks, timeoutMs);
  } catch (error) {
    checks.push(
      check("reachable", "stdio server reachable", "must", "fail", `Could not start ${command}: ${(error as Error).message}`),
    );
    skipHttpChecks();
    await connection.close();
    return finalize("stdio", command, checks, startedAt, "unreachable");
  }

  skipHttpChecks();

  let discoverOk = false;
  // Re-derive status from the checks gathered above.
  discoverOk = checks.some((entry) => entry.id === "server-discover" && entry.verdict === "pass");
  const statelessOk = checks.some((entry) => entry.id === "stateless-request" && entry.verdict === "pass");
  const modernEvidence = discoverOk || statelessOk;
  const mustFailures = checks.some((entry) => entry.requirement === "must" && entry.verdict === "fail");
  const status: CompatibilityStatus = !modernEvidence ? "legacy" : mustFailures ? "partial" : "compatible";
  await connection.close();
  return finalize("stdio", command, checks, startedAt, status);
}

async function probeStdioChecks(connection: StdioConnection, checks: CheckResult[], timeoutMs: number): Promise<void> {
  checks.push(check("reachable", "stdio server reachable", "must", "pass", "spawned the stdio server."));

  const discover = await connection.request("server/discover", { _meta: requestMeta() }, timeoutMs);
  const discoverResult =
    discover.result && typeof discover.result === "object" ? (discover.result as Record<string, unknown>) : undefined;
  const versions = discoverResult?.supportedVersions;
  if (discoverResult && Array.isArray(versions) && versions.includes(SPEC_VERSION)) {
    checks.push(
      check(
        "server-discover",
        "server/discover implemented",
        "must",
        "pass",
        `Advertises ${versions.join(", ")}.`,
        { supportedVersions: versions },
      ),
    );
  } else {
    checks.push(
      check(
        "server-discover",
        "server/discover implemented",
        "must",
        "fail",
        `server/discover did not advertise ${SPEC_VERSION}: ${discover.error ? explain(discover) : JSON.stringify(discover.result)}`,
      ),
    );
  }

  const tools = await connection.request("tools/list", { _meta: requestMeta() }, timeoutMs);
  const toolsResult = tools.result && typeof tools.result === "object" ? (tools.result as Record<string, unknown>) : undefined;
  if (toolsResult && Array.isArray(toolsResult.tools)) {
    checks.push(
      check(
        "stateless-request",
        "Stateless request accepted",
        "must",
        "pass",
        `tools/list answered with ${toolsResult.tools.length} tool(s).`,
      ),
    );
  } else {
    checks.push(check("stateless-request", "Stateless request accepted", "must", "fail", explain(tools)));
  }

  if (toolsResult) {
    checks.push(
      check(
        "result-type",
        "Results carry resultType",
        "must",
        toolsResult.resultType === "complete" ? "pass" : "fail",
        `tools/list resultType=${JSON.stringify(toolsResult.resultType)}.`,
      ),
    );
    const cacheOk =
      typeof toolsResult.ttlMs === "number" &&
      (toolsResult.cacheScope === "public" || toolsResult.cacheScope === "private");
    checks.push(
      check(
        "cache-hints",
        "List results are cacheable",
        "should",
        cacheOk ? "pass" : "warn",
        cacheOk
          ? `ttlMs=${toolsResult.ttlMs}, cacheScope=${String(toolsResult.cacheScope)}`
          : "Missing ttlMs/cacheScope on tools/list.",
      ),
    );
  } else {
    checks.push(check("result-type", "Results carry resultType", "must", "skip", "tools/list returned no result."));
    checks.push(check("cache-hints", "List results are cacheable", "should", "skip", "tools/list returned no result."));
  }

  const bogusVersion = "2099-01-01";
  const versionProbe = await connection.request(
    "tools/list",
    { _meta: requestMeta({ protocolVersion: bogusVersion }) },
    timeoutMs,
  );
  if (isUnsupportedVersion(versionProbe)) {
    checks.push(
      check("version-negotiation", "Unknown versions rejected with supported list", "must", "pass", explain(versionProbe)),
    );
  } else {
    checks.push(
      check(
        "version-negotiation",
        "Unknown versions rejected with supported list",
        "must",
        "fail",
        `Unknown protocol version was not rejected: ${explain(versionProbe)}`,
      ),
    );
  }

  const initialize = await connection.request(
    "initialize",
    { protocolVersion: SPEC_VERSION, capabilities: {}, clientInfo: { name: "mcp-dual", version: "0.1.0" } },
    timeoutMs,
  );
  checks.push(
    check(
      "initialize-retired",
      "Legacy initialize retired",
      "should",
      initialize.error ? "pass" : "warn",
      initialize.error
        ? `initialize returned ${explain(initialize)}.`
        : "initialize still handshakes; this is a dual-era server.",
    ),
  );

  const ping = await connection.request("ping", undefined, timeoutMs);
  checks.push(
    check(
      "ping-removed",
      "ping removed",
      "should",
      ping.error ? "pass" : "warn",
      ping.error ? explain(ping) : "ping still answers; it was removed from the core protocol.",
    ),
  );

  const unknown = await connection.request("mcp-dual/unknown-method", { _meta: requestMeta() }, timeoutMs);
  checks.push(
    check(
      "unknown-method",
      "Unknown methods return Method not found",
      "must",
      unknown.error?.code === ERROR_CODES.methodNotFound ? "pass" : "fail",
      explain(unknown),
    ),
  );

  checks.push(
    check(
      "subscriptions-listen",
      "subscriptions/listen available",
      "should",
      "skip",
      "Not probed: it requires holding a long-lived response stream open.",
    ),
  );
}

function finalize(
  transport: "http" | "stdio",
  target: string,
  checks: CheckResult[],
  startedAt: Date,
  status: CompatibilityStatus,
): ProbeReport {
  return {
    transport,
    target,
    status,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    checks,
    summary: summarizeChecks(checks),
  };
}

export interface CheckOptions {
  url?: string;
  stdio?: string;
  path?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  skipStatic?: boolean;
  skipProbe?: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Build the machine-readable report used by the CLI and the GitHub Action. */
export async function runProbe(options: CheckOptions): Promise<ProbeReport> {
  if (options.url && options.stdio) throw new UsageError("Use either --url or --stdio, not both.");
  if (options.url) return probeHttp(options.url, { timeoutMs: options.timeoutMs, headers: options.headers });
  if (options.stdio) return probeStdio(options.stdio, { timeoutMs: options.timeoutMs });
  throw new UsageError("A probe target is required: pass --url <endpoint> or --stdio <command>.");
}

export function buildNextSteps(report: CheckReport): string[] {
  const steps: string[] = [];
  const probe = report.probe;
  if (probe) {
    if (probe.status === "legacy") {
      steps.push(
        "The endpoint does not speak 2026-07-28 yet. For clients that already speak the new spec, run `mcp-dual shim --upstream-http <url>` and point them at the shim.",
      );
      steps.push("For the server itself, run `mcp-dual codemod <src> --dry-run` to see the TypeScript changes, or follow the Python path with mcp-migrate.");
    }
    const failing = probe.checks.filter((entry) => entry.verdict === "fail");
    const ids = new Set(failing.map((entry) => entry.id));
    if (ids.has("server-discover")) steps.push("Implement `server/discover` returning supportedVersions, capabilities, resultType and cache hints.");
    if (ids.has("stateless-request")) steps.push("Serve `tools/list` without initialize and without a session id.");
    if (ids.has("header-mismatch") || ids.has("header-required")) {
      steps.push("Mirror `method` and `params.name`/`params.uri` into `Mcp-Method`/`Mcp-Name`, and reject mismatches with HTTP 400 + -32020.");
    }
    if (ids.has("protocol-version-header")) steps.push("Require `MCP-Protocol-Version` on every POST and compare it with `_meta` protocolVersion.");
    if (ids.has("version-negotiation")) steps.push("Return -32022 with `data.supported` listing every supported version for unknown versions.");
    if (ids.has("session-removed")) steps.push("Remove session minting and state: the new transport is stateless by design.");
    if (ids.has("result-type")) steps.push("Add `resultType: \"complete\"` to every result object.");
    if (ids.has("unknown-method")) steps.push("Return HTTP 404 with JSON-RPC -32601 for unknown methods.");
    if (probe.checks.some((entry) => entry.id === "cache-hints" && entry.verdict === "warn")) {
      steps.push("Add `ttlMs` and `cacheScope` to list/read results so clients can cache them.");
    }
    if (probe.status === "compatible") steps.push("The endpoint passed every mandatory probe. Keep the report in CI with `--format markdown`.");
  }
  const findings = report.static?.findings ?? [];
  if (findings.some((finding) => finding.severity === "error")) {
    steps.push("Fix the static errors first (`mcp-dual codemod <path> --dry-run` shows the diff), then re-run the live check.");
  }
  if (report.exitCode === 2) {
    steps.push("No MCP response was obtained. Check the URL, auth headers, and that the server speaks Streamable HTTP.");
  }
  if (!report.probe && !report.static) {
    steps.push("Pass `--url`, `--stdio`, or `--path` so there is something to check.");
  }
  return steps;
}

export function buildReport(options: {
  probe?: ProbeReport;
  static?: import("./rules.js").StaticReport;
  toolVersion: string;
}): CheckReport {
  const staticErrors = (options.static?.counts.error ?? 0) > 0;
  let exitCode = 0;
  if (options.probe) {
    if (options.probe.status === "unreachable") exitCode = 2;
    else if (options.probe.status !== "compatible") exitCode = 1;
  }
  if (staticErrors) exitCode = Math.max(exitCode, 1);
  const report: CheckReport = {
    tool: { name: TOOL_NAME, version: options.toolVersion },
    specVersion: SPEC_VERSION,
    generatedAt: new Date().toISOString(),
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.static ? { static: options.static } : {}),
    exitCode,
    nextSteps: [],
  };
  report.nextSteps = buildNextSteps(report);
  return report;
}
