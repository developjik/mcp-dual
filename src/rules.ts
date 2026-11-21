/* mcp-dual:ignore-file */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export type Severity = "error" | "warning" | "info";

export type SourceKind = "ts" | "js" | "json";

export interface RuleContext {
  file: string;
  relPath: string;
  content: string;
  lines: string[];
  kind: SourceKind;
}

export interface RuleDefinition {
  id: string;
  title: string;
  severity: Severity;
  /** Specification section or SEP this rule enforces. */
  spec: string;
  message: string;
  suggestion: string;
  /** Whether `mcp-dual codemod` can change the code automatically (vs. insert a TODO). */
  fixable: boolean;
  appliesTo: ReadonlyArray<SourceKind>;
  detect: (ctx: RuleContext) => number[];
}

export interface StaticFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  spec: string;
  message: string;
  suggestion: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
  occurrences: number;
  fixable: boolean;
}

export interface StaticReport {
  root: string;
  filesScanned: number;
  rulesEvaluated: number;
  findings: StaticFinding[];
  counts: Record<Severity, number>;
}

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".vitest",
  ".next",
  ".turbo",
  "out",
]);

const SOURCE_EXTENSIONS: Record<string, SourceKind> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
};

function linesMatching(ctx: RuleContext, pattern: RegExp): number[] {
  const found: number[] = [];
  for (let index = 0; index < ctx.lines.length; index += 1) {
    const line = ctx.lines[index] ?? "";
    if (pattern.test(line)) found.push(index + 1);
  }
  return found;
}

function firstLine(ctx: RuleContext, pattern: RegExp): number[] {
  const found = linesMatching(ctx, pattern);
  return found.length > 0 ? [found[0] as number] : [];
}

function isHttpMcpHandler(ctx: RuleContext): boolean {
  const hasJsonRpc = /jsonrpc/i.test(ctx.content);
  const hasHttpSurface =
    /\b(req|request|res|response|fetch|createServer|Bun\.serve|Deno\.serve)\b/.test(ctx.content) &&
    /headers|header/i.test(ctx.content);
  return hasJsonRpc && hasHttpSurface;
}

function hasAny(ctx: RuleContext, pattern: RegExp): boolean {
  return pattern.test(ctx.content);
}

/**
 * Static rules for the 2026-07-28 stateless revision.
 * Rules are file-level heuristics: they point at the first occurrence so the
 * report stays readable, while `occurrences` carries the raw count.
 */
export const RULES: RuleDefinition[] = [
  {
    id: "legacy-session-header",
    title: "Mcp-Session-Id is gone",
    severity: "error",
    spec: "2026-07-28 · SEP-2567",
    message: "The transport no longer carries a session id; list results no longer vary per connection.",
    suggestion: "Remove session plumbing and pass an explicit server-minted handle as a normal tool argument.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /Mcp-Session-Id/i),
  },
  {
    id: "legacy-initialize",
    title: "initialize handshake retired",
    severity: "error",
    spec: "2026-07-28 · SEP-2575",
    message: "The initialize / notifications/initialized exchange was removed; every request is self-describing.",
    suggestion: "Delete the handshake and put protocolVersion, clientInfo and clientCapabilities in params._meta.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /InitializeRequestSchema|["'`]initialize["'`]|notifications\/initialized/),
  },
  {
    id: "missing-standard-headers",
    title: "Mcp-Method / Mcp-Name headers missing",
    severity: "error",
    spec: "2026-07-28 · SEP-2243",
    message: "Streamable HTTP POST requests must mirror method and principal name into headers.",
    suggestion: "Set Mcp-Method and Mcp-Name, and reject mismatches with HTTP 400 and error -32020.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!isHttpMcpHandler(ctx)) return [];
      if (hasAny(ctx, /mcp-method/i)) return [];
      return firstLine(ctx, /jsonrpc/i);
    },
  },
  {
    id: "missing-protocol-version-header",
    title: "MCP-Protocol-Version header missing",
    severity: "error",
    spec: "2026-07-28 · Streamable HTTP",
    message: "Every POST must carry MCP-Protocol-Version matching _meta protocolVersion.",
    suggestion: "Read and validate the header; reply 400 with HeaderMismatch (-32020) when it is absent or differs.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!isHttpMcpHandler(ctx)) return [];
      if (hasAny(ctx, /MCP-Protocol-Version/i)) return [];
      return firstLine(ctx, /jsonrpc/i);
    },
  },
  {
    id: "missing-result-type",
    title: "Results lack resultType",
    severity: "warning",
    spec: "2026-07-28 · SEP-2322",
    message: "Every result must include resultType ('complete' or 'input_required').",
    suggestion: "Add resultType: 'complete' to ordinary results; return input_required for MRTR.",
    fixable: true,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!hasAny(ctx, /setRequestHandler|registerTool|\bserver\.tool\(/)) return [];
      if (hasAny(ctx, /resultType/)) return [];
      return firstLine(ctx, /setRequestHandler|registerTool|\bserver\.tool\(/);
    },
  },
  {
    id: "missing-cache-hints",
    title: "List results lack ttlMs / cacheScope",
    severity: "warning",
    spec: "2026-07-28 · SEP-2549",
    message: "tools/list, prompts/list, resources/list, resources/read and templates/list must be CacheableResult.",
    suggestion: "Add ttlMs (freshness hint in ms) and cacheScope ('public' or 'private') to list and read results.",
    fixable: true,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!hasAny(ctx, /ListToolsRequestSchema|ListResourcesRequestSchema|ListPromptsRequestSchema|ListResourceTemplatesRequestSchema|\.listTools\(/)) {
        return [];
      }
      if (hasAny(ctx, /ttlMs|cacheScope/)) return [];
      return firstLine(ctx, /ListToolsRequestSchema|ListResourcesRequestSchema|ListPromptsRequestSchema|ListResourceTemplatesRequestSchema|\.listTools\(/);
    },
  },
  {
    id: "missing-server-discover",
    title: "server/discover not implemented",
    severity: "warning",
    spec: "2026-07-28 · SEP-2575",
    message: "Servers MUST implement server/discover to advertise versions, capabilities and identity.",
    suggestion: "Handle server/discover and return supportedVersions, capabilities, resultType and cache hints.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!hasAny(ctx, /new Server\(|new McpServer\(|setRequestHandler\(/)) return [];
      if (hasAny(ctx, /server\/discover|DiscoverRequest|DiscoverResult/)) return [];
      return firstLine(ctx, /new Server\(|new McpServer\(|setRequestHandler\(/);
    },
  },
  {
    id: "legacy-sse-transport",
    title: "Deprecated HTTP+SSE transport",
    severity: "error",
    spec: "2026-07-28 · deprecations",
    message: "SSEServerTransport and the 2024-11-05 HTTP+SSE transport are deprecated for removal.",
    suggestion: "Move to StreamableHTTPServerTransport (or the v2 SDK equivalent).",
    fixable: true,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /SSEServerTransport|server\/sse(\.js)?["'`]|mcp-sse/i),
  },
  {
    id: "sse-get-stream",
    title: "Standalone GET SSE stream",
    severity: "warning",
    spec: "2026-07-28 · Streamable HTTP",
    message: "The GET endpoint was replaced by subscriptions/listen; GET should return 405.",
    suggestion: "Remove the GET stream; implement subscriptions/listen for change notifications.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!hasAny(ctx, /text\/event-stream/)) return [];
      if (!hasAny(ctx, /app\.get\(|\.get\(["'`]\/?sse|createServer\(/)) return [];
      return firstLine(ctx, /app\.get\(|\.get\(["'`]\/?sse|text\/event-stream/);
    },
  },
  {
    id: "sse-resumability",
    title: "Last-Event-ID resumability",
    severity: "warning",
    spec: "2026-07-28 · SEP-2575",
    message: "SSE stream resumability and message redelivery were removed.",
    suggestion: "Drop Last-Event-ID handling; re-issue broken in-flight requests with a new id.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /Last-Event-ID/i),
  },
  {
    id: "resources-subscribe",
    title: "resources/subscribe removed",
    severity: "warning",
    spec: "2026-07-28 · SEP-2575",
    message: "Per-resource subscriptions were replaced by subscriptions/listen with a notification filter.",
    suggestion: "Opt in through subscriptions/listen and tag notifications with the subscriptionId.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /resources\/(un)?subscribe|SubscribeRequestSchema/),
  },
  {
    id: "ping-method",
    title: "ping removed",
    severity: "warning",
    spec: "2026-07-28 · SEP-2575",
    message: "The ping utility request was removed from the core protocol.",
    suggestion: "Delete the ping handler; use server/discover as a liveness and capability probe.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /PingRequestSchema|["'`]ping["'`]/),
  },
  {
    id: "logging-set-level",
    title: "logging/setLevel removed",
    severity: "warning",
    spec: "2026-07-28 · SEP-2575",
    message: "Log level is now per request via _meta io.modelcontextprotocol/logLevel.",
    suggestion: "Read logLevel from params._meta and stop handling logging/setLevel.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /logging\/setLevel|SetLevelRequestSchema/),
  },
  {
    id: "server-initiated-request",
    title: "Server-initiated requests need MRTR",
    severity: "info",
    spec: "2026-07-28 · SEP-2322",
    message: "sampling/createMessage, elicitation/create and roots/list requests are replaced by Multi Round-Trip Requests.",
    suggestion: "Return an InputRequiredResult and accept inputResponses on the retried request.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /sampling\/createMessage|elicitation\/create|roots\/list/),
  },
  {
    id: "legacy-tasks",
    title: "Tasks moved to an extension",
    severity: "info",
    spec: "2026-07-28 · SEP-2663",
    message: "Tasks are no longer core; tasks/result and tasks/list were replaced by tasks/get and tasks/update.",
    suggestion: "Adopt the io.modelcontextprotocol/tasks extension and poll with tasks/get.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /tasks\/result|tasks\/list\b|TaskResultRequest/),
  },
  {
    id: "dcr-without-application-type",
    title: "DCR missing application_type",
    severity: "warning",
    spec: "2026-07-28 · SEP-837",
    message: "Dynamic Client Registration requires application_type; DCR itself is deprecated in favour of CIMD.",
    suggestion: "Send application_type ('native' for CLI/desktop, 'web' for hosted clients) or move to CIMD.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => {
      if (!hasAny(ctx, /redirect_uris|registration_endpoint|["'`]\/register["'`]/)) return [];
      if (hasAny(ctx, /application_type/)) return [];
      return firstLine(ctx, /redirect_uris|registration_endpoint|["'`]\/register["'`]/);
    },
  },
  {
    id: "hardcoded-legacy-version",
    title: "Hard-coded legacy protocol version",
    severity: "info",
    spec: "2026-07-28 · versioning",
    message: "Pinning an older protocol version keeps the server on the pre-stateless era.",
    suggestion: "Negotiate through server/discover and _meta instead of hard-coding a version.",
    fixable: false,
    appliesTo: ["ts", "js"],
    detect: (ctx) => firstLine(ctx, /["'`](2025-11-25|2025-06-18|2025-03-26)["'`]/),
  },
  {
    id: "legacy-sdk-version",
    title: "MCP SDK v1 pinned",
    severity: "warning",
    spec: "2026-07-28 · SDK v2",
    message: "The TypeScript SDK v1 only speaks the legacy lifecycle; v2 adds the stateless core.",
    suggestion: "Upgrade @modelcontextprotocol/sdk to v2, then run mcp-dual codemod and check.",
    fixable: false,
    appliesTo: ["json"],
    detect: (ctx) => {
      if (!/package\.json$/.test(ctx.file)) return [];
      let manifest: unknown;
      try {
        manifest = JSON.parse(ctx.content);
      } catch {
        return [];
      }
      if (typeof manifest !== "object" || manifest === null) return [];
      const record = manifest as Record<string, unknown>;
      const sections = ["dependencies", "devDependencies", "peerDependencies"];
      for (const section of sections) {
        const deps = record[section];
        if (typeof deps !== "object" || deps === null) continue;
        const value = (deps as Record<string, unknown>)["@modelcontextprotocol/sdk"];
        if (typeof value !== "string") continue;
        const major = Number.parseInt(value.replace(/^[^0-9]*/, ""), 10);
        if (Number.isFinite(major) && major < 2) return [1];
      }
      return [];
    },
  },
];

const IGNORE_LINE = "mcp-dual:ignore";
const IGNORE_FILE = "mcp-dual:ignore-file";

export interface ScanOptions {
  /** Extra glob-like patterns to skip, on top of `.mcpdualignore`. */
  ignore?: string[];
  /** Restrict to these rule ids. */
  rules?: string[];
}

function loadIgnorePatterns(root: string, extra: string[]): string[] {
  const patterns = [...extra];
  try {
    const ignoreFile = join(root, ".mcpdualignore");
    const content = readFileSync(ignoreFile, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) patterns.push(trimmed);
    }
  } catch {
    // optional file
  }
  return patterns;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(relPath) || pattern.test(`${relPath}/`));
}

function normalizeRel(path: string): string {
  return path.split(sep).join("/");
}

function collectFiles(target: string): string[] {
  const resolved = resolve(target);
  const stat = statSync(resolved);
  if (stat.isFile()) return [resolved];
  const files: string[] = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(join(resolved, entry.name)));
    } else if (entry.isFile()) {
      files.push(join(resolved, entry.name));
    }
  }
  return files;
}

function kindFor(file: string): SourceKind | undefined {
  const extension = extname(file).toLowerCase();
  if (extension in SOURCE_EXTENSIONS) return SOURCE_EXTENSIONS[extension];
  if (extension === ".json" && /(^|\/)package\.json$/.test(file)) return "json";
  return undefined;
}

export function scanFileContent(
  file: string,
  relPath: string,
  content: string,
  rules: RuleDefinition[] = RULES,
): StaticFinding[] {
  if (content.includes(IGNORE_FILE)) return [];
  const kind = kindFor(file) ?? (extname(file) === ".json" ? "json" : "ts");
  const lines = content.split(/\r?\n/);
  const ctx: RuleContext = { file, relPath, content, lines, kind };
  const findings: StaticFinding[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes(kind)) continue;
    let hits: number[] = [];
    try {
      hits = rule.detect(ctx);
    } catch {
      continue;
    }
    const usable = hits.filter((line) => {
      const current = lines[line - 1] ?? "";
      const previous = lines[line - 2] ?? "";
      return !current.includes(IGNORE_LINE) && !previous.includes(`${IGNORE_LINE}-next-line`);
    });
    if (usable.length === 0) continue;
    const line = usable[0] as number;
    const source = lines[line - 1] ?? "";
    findings.push({
      ruleId: rule.id,
      title: rule.title,
      severity: rule.severity,
      spec: rule.spec,
      message: rule.message,
      suggestion: rule.suggestion,
      file: relPath,
      line,
      column: Math.max(1, source.search(/\S/) + 1 || 1),
      snippet: source.trim().slice(0, 200),
      occurrences: usable.length,
      fixable: rule.fixable,
    });
  }
  return findings;
}

export function scanProject(target: string, options: ScanOptions = {}): StaticReport {
  const root = resolve(target);
  const ignorePatterns = loadIgnorePatterns(root, options.ignore ?? []).map(globToRegExp);
  const selectedRules = options.rules && options.rules.length > 0
    ? RULES.filter((rule) => options.rules?.includes(rule.id))
    : RULES;
  const files = collectFiles(root);
  const findings: StaticFinding[] = [];
  let filesScanned = 0;

  for (const file of files) {
    const kind = kindFor(file);
    if (!kind) continue;
    const relPath = normalizeRel(relative(root, file)) || normalizeRel(relative(process.cwd(), file)) || normalizeRel(file);
    if (isIgnored(relPath, ignorePatterns)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes(IGNORE_FILE)) continue;
    filesScanned += 1;
    findings.push(...scanFileContent(file, relPath, content, selectedRules));
  }

  findings.sort((a, b) => {
    const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
  });

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    root,
    filesScanned,
    rulesEvaluated: selectedRules.length,
    findings,
    counts,
  };
}
