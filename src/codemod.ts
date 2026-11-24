/* mcp-dual:ignore-file */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript-compiler-api";

export interface CodemodChange {
  ruleId: string;
  kind: "auto" | "manual";
  description: string;
  line: number;
  from?: string;
  to?: string;
}

export interface CodemodFileResult {
  file: string;
  relPath: string;
  changes: CodemodChange[];
  diff: string;
  output: string;
  applied: boolean;
}

export interface CodemodReport {
  dryRun: boolean;
  files: CodemodFileResult[];
  filesScanned: number;
  filesChanged: number;
  autoChanges: number;
  manualChanges: number;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
  ruleId: string;
  kind: "auto" | "manual";
  description: string;
  from?: string;
  to?: string;
}

interface ManualNotice {
  position: number;
  ruleId: string;
  message: string;
}

const MANUAL_PATTERNS: ReadonlyArray<{ ruleId: string; pattern: RegExp; message: string }> = [
  {
    ruleId: "legacy-session-header",
    pattern: /Mcp-Session-Id/,
    message:
      "Mcp-Session-Id was removed in 2026-07-28. Drop this session plumbing and pass an explicit, server-minted handle through tool arguments.",
  },
  {
    ruleId: "legacy-initialize",
    pattern: /InitializeRequestSchema|["'`]initialize["'`]|notifications\/initialized/,
    message:
      "The initialize handshake was removed. Move protocolVersion/clientInfo/clientCapabilities into params._meta and implement server/discover.",
  },
  {
    ruleId: "ping-method",
    pattern: /PingRequestSchema|["'`]ping["'`]/,
    message: "ping was removed. Use server/discover as the liveness and capability probe.",
  },
  {
    ruleId: "logging-set-level",
    pattern: /logging\/setLevel|SetLevelRequestSchema/,
    message: "logging/setLevel was removed. Read io.modelcontextprotocol/logLevel from params._meta per request.",
  },
  {
    ruleId: "resources-subscribe",
    pattern: /resources\/(un)?subscribe|SubscribeRequestSchema/,
    message: "resources/subscribe was replaced by subscriptions/listen with a notification filter.",
  },
  {
    ruleId: "server-initiated-request",
    pattern: /sampling\/createMessage|elicitation\/create|roots\/list/,
    message:
      "Server-initiated requests are replaced by Multi Round-Trip Requests: return resultType 'input_required' and accept inputResponses on retry.",
  },
];

const LIST_RESULT_PROPERTIES = new Set(["tools", "prompts", "resources", "resourceTemplates", "contents"]);
const RESULT_PROPERTIES = new Set(["content", "structuredContent", "tools", "prompts", "resources", "resourceTemplates", "contents"]);

const EOL = (source: string): string => (source.includes("\r\n") ? "\r\n" : "\n");

function lineOf(source: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function lineStartIndent(source: string, position: number): string {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  const prefix = source.slice(lineStart, position);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function hasTodoAbove(source: string, position: number): boolean {
  const before = source.slice(0, position).split(/\r?\n/);
  for (let index = before.length - 2; index >= Math.max(0, before.length - 4); index -= 1) {
    const line = (before[index] ?? "").trim();
    if (!line) continue;
    return line.includes("TODO(mcp-dual)");
  }
  return false;
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return undefined;
}

function isReturnedValue(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && ts.isParenthesizedExpression(current)) current = current.parent;
  if (!current) return false;
  if (ts.isReturnStatement(current)) return true;
  if (ts.isArrowFunction(current) && (current.body === node || current.body.parent === current)) return true;
  return false;
}

function collectObjectEdits(sourceFile: ts.SourceFile, source: string, edits: TextEdit[]): void {
  const eol = EOL(source);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(propertyName).filter((name): name is string => Boolean(name)));
      const resultLike = [...names].some((name) => RESULT_PROPERTIES.has(name));
      const hasResultType = names.has("resultType");
      const listLike = [...names].some((name) => LIST_RESULT_PROPERTIES.has(name));
      if (resultLike && !hasResultType && isReturnedValue(node)) {
        const fields: string[] = ['resultType: "complete",'];
        if (listLike && !names.has("ttlMs")) fields.push("ttlMs: 0,");
        if (listLike && !names.has("cacheScope")) fields.push('cacheScope: "private",');
        const brace = node.getStart(sourceFile);
        const inner = source.slice(brace + 1, node.end - 1);
        const firstProperty = node.properties[0];
        const indent = firstProperty ? lineStartIndent(source, firstProperty.getStart(sourceFile)) : "  ";
        const multiline = /^\s*\r?\n/.test(inner);
        const insertion = multiline
          ? `${eol}${indent}${fields.join(`${eol}${indent}`)}`
          : `${fields.join(" ")} `;
        edits.push({
          start: brace + 1,
          end: brace + 1,
          text: insertion,
          ruleId: listLike ? "missing-cache-hints" : "missing-result-type",
          kind: "auto",
          description: listLike
            ? "Add resultType, ttlMs and cacheScope to a cacheable list result"
            : "Add resultType: \"complete\" to a tool result",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectManualNotices(sourceFile: ts.SourceFile, source: string, notices: ManualNotice[]): void {
  interface Candidate {
    node: ts.Node;
    ruleId: string;
    message: string;
    position: number;
  }
  const candidates: Candidate[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStatement(node) || ts.isCaseClause(node) || ts.isImportDeclaration(node)) {
      const text = node.getText(sourceFile);
      for (const rule of MANUAL_PATTERNS) {
        if (!rule.pattern.test(text)) continue;
        candidates.push({ node, ruleId: rule.ruleId, message: rule.message, position: node.getStart(sourceFile) });
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Keep only the innermost statement for each rule so a call expression does
  // not also comment a nested statement that matches the same pattern.
  const innermost = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.ruleId === candidate.ruleId &&
          other.position > candidate.position &&
          other.node.getEnd() <= candidate.node.getEnd(),
      ),
  );

  for (const candidate of innermost) {
    if (hasTodoAbove(source, candidate.position)) continue;
    if (notices.some((notice) => notice.position === candidate.position && notice.ruleId === candidate.ruleId)) continue;
    notices.push({ position: candidate.position, ruleId: candidate.ruleId, message: candidate.message });
  }
}

function collectSseImportEdits(sourceFile: ts.SourceFile, source: string, edits: TextEdit[]): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!/\/server\/sse(\.js|\.ts)?$/.test(specifier)) continue;
    const position = statement.getStart(sourceFile);
    if (hasTodoAbove(source, position)) continue;
    const replacement = specifier.replace(/\/server\/sse(\.js|\.ts)?$/, "/server/streamableHttp.js");
    edits.push({
      start: statement.moduleSpecifier.getStart(sourceFile) + 1,
      end: statement.moduleSpecifier.getEnd() - 1,
      text: replacement,
      ruleId: "legacy-sse-transport",
      kind: "auto",
      description: `Replace deprecated HTTP+SSE import with ${replacement}`,
      from: specifier,
      to: replacement,
    });
  }
}

function collectIdentifierRenames(sourceFile: ts.SourceFile, edits: TextEdit[]): void {
  const rename = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "SSEServerTransport") {
      edits.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        text: "StreamableHTTPServerTransport",
        ruleId: "legacy-sse-transport",
        kind: "auto",
        description: "Rename SSEServerTransport to StreamableHTTPServerTransport",
        from: "SSEServerTransport",
        to: "StreamableHTTPServerTransport",
      });
    }
    ts.forEachChild(node, rename);
  };
  rename(sourceFile);
}

function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let output = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) continue; // overlapping edit: keep the later one
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    lastStart = edit.start;
  }
  return output;
}

function noticesToEdits(source: string, notices: ManualNotice[]): TextEdit[] {
  const eol = EOL(source);
  const byPosition = new Map<number, ManualNotice[]>();
  for (const notice of notices) {
    const list = byPosition.get(notice.position) ?? [];
    list.push(notice);
    byPosition.set(notice.position, list);
  }
  const edits: TextEdit[] = [];
  for (const [position, list] of byPosition) {
    const lineStart = source.lastIndexOf("\n", position - 1) + 1;
    const atLineStart = /^[ \t]*$/.test(source.slice(lineStart, position));
    const indent = atLineStart ? source.slice(lineStart, position) : "";
    const text = atLineStart
      ? `${list.map((notice) => `// TODO(mcp-dual): ${notice.message}`).join(`${eol}${indent}`)}${eol}${indent}`
      : `${list.map((notice) => `/* TODO(mcp-dual): ${notice.message} */`).join(" ")} `;
    edits.push({
      start: position,
      end: position,
      text,
      ruleId: list[0]?.ruleId ?? "manual",
      kind: "manual",
      description: `Insert ${list.length} manual migration TODO(s)`,
    });
  }
  return edits;
}

function diffOf(before: string, after: string, relPath: string): string {
  if (before === after) return "";
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  if (n * m > 6_000_000) {
    // Very large file: show the first changed block only.
    return `--- a/${relPath}\n+++ b/${relPath}\n${describeFirstChange(before, after)}`;
  }
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? (dp[(i + 1) * width + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  type Op = { kind: " " | "-" | "+"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + j + 1] as number)) {
      ops.push({ kind: "-", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", line: a[i] as string });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "+", line: b[j] as string });
    j += 1;
  }

  const context = 3;
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]?.kind === " ") {
      index += 1;
      continue;
    }
    let start = Math.max(0, index - context);
    let end = index;
    while (end < ops.length) {
      if (ops[end]?.kind !== " ") {
        end += 1;
        continue;
      }
      let run = 0;
      let cursor = end;
      while (cursor < ops.length && ops[cursor]?.kind === " ") {
        run += 1;
        cursor += 1;
      }
      if (cursor >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + Math.min(run, context));
        break;
      }
      end = cursor;
    }
    const hunk = ops.slice(start, end);
    const beforeCount = hunk.filter((op) => op.kind !== "+").length;
    const afterCount = hunk.filter((op) => op.kind !== "-").length;
    const beforeStart = ops.slice(0, start).filter((op) => op.kind !== "+").length + 1;
    const afterStart = ops.slice(0, start).filter((op) => op.kind !== "-").length + 1;
    out.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    index = end;
  }
  return out.join("\n");
}

function describeFirstChange(before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  return [
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

export interface TransformResult {
  output: string;
  changes: CodemodChange[];
  diff: string;
}

/** Transform one TypeScript source file. Pure: no disk access, used by tests and the CLI. */
export function transformSource(fileName: string, source: string): TransformResult {
  const scriptKind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const edits: TextEdit[] = [];
  const notices: ManualNotice[] = [];

  collectObjectEdits(sourceFile, source, edits);
  collectSseImportEdits(sourceFile, source, edits);
  collectIdentifierRenames(sourceFile, edits);
  collectManualNotices(sourceFile, source, notices);

  const noticeEdits = noticesToEdits(source, notices);
  const allEdits = [...edits, ...noticeEdits];
  const output = applyEdits(source, allEdits);

  const changes: CodemodChange[] = [
    ...edits.map((edit) => ({
      ruleId: edit.ruleId,
      kind: edit.kind,
      description: edit.description,
      line: lineOf(source, edit.start),
      ...(edit.from ? { from: edit.from } : {}),
      ...(edit.to ? { to: edit.to } : {}),
    })),
    ...notices.map((notice) => ({
      ruleId: notice.ruleId,
      kind: "manual" as const,
      description: notice.message,
      line: lineOf(source, notice.position),
    })),
  ].sort((a, b) => a.line - b.line);

  return {
    output,
    changes,
    diff: diffOf(source, output, relative(process.cwd(), fileName) || fileName),
  };
}

export interface CodemodOptions {
  write?: boolean;
  include?: string[];
  exclude?: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vitest", ".next", "out"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function collectSourceFiles(target: string, exclude: RegExp[]): string[] {
  const resolved = resolve(target);
  const stat = statSync(resolved);
  if (stat.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(resolved)) && !resolved.endsWith(".d.ts")) return [resolved];
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collectSourceFiles(join(resolved, entry.name), exclude));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      const full = join(resolved, entry.name);
      if (!exclude.some((pattern) => pattern.test(full))) files.push(full);
    }
  }
  return files;
}

/** Run the codemod over files or directories. Without `write` it only produces diffs. */
export function runCodemod(targets: string[], options: CodemodOptions = {}): CodemodReport {
  const exclude = (options.exclude ?? []).map((pattern) => new RegExp(pattern));
  const files = [...new Set(targets.flatMap((target) => collectSourceFiles(target, exclude)))];
  const results: CodemodFileResult[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const transformed = transformSource(file, source);
    if (transformed.changes.length === 0) continue;
    if (options.write) writeFileSync(file, transformed.output, "utf8");
    results.push({
      file,
      relPath: relative(process.cwd(), file),
      changes: transformed.changes,
      diff: transformed.diff,
      output: transformed.output,
      applied: Boolean(options.write),
    });
  }
  return {
    dryRun: !options.write,
    files: results,
    filesScanned: files.length,
    filesChanged: results.length,
    autoChanges: results.reduce((total, result) => total + result.changes.filter((change) => change.kind === "auto").length, 0),
    manualChanges: results.reduce((total, result) => total + result.changes.filter((change) => change.kind === "manual").length, 0),
  };
}
