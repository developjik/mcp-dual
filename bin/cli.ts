#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildReport, runProbe, UsageError, type CheckOptions } from "../src/check.js";
import { runCodemod } from "../src/codemod.js";
import { renderJson, renderMarkdown, renderText } from "../src/report.js";
import { scanProject } from "../src/rules.js";
import { runStdioShim, startShim, type ShimMode } from "../src/shim.js";
import { SPEC_VERSION, TOOL_NAME } from "../src/version.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
  /** `--no-<flag>` switches, kept separate from positive flags. */
  negated: Set<string>;
}

const VALUE_FLAGS = new Set([
  "url",
  "stdio",
  "path",
  "format",
  "out",
  "timeout",
  "header",
  "rules",
  "ignore",
  "listen",
  "host",
  "upstream-http",
  "upstream-stdio",
  "mode",
  "exclude",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const negated = new Set<string>();
  let command = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split("=", 2) as [string, string | undefined];
      if (rawName.startsWith("no-")) {
        negated.add(rawName.slice(3));
        continue;
      }
      if (VALUE_FLAGS.has(rawName)) {
        const value = inlineValue ?? argv[index + 1];
        if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
          throw new UsageError(`--${rawName} needs a value`);
        }
        if (inlineValue === undefined) index += 1;
        const list = values.get(rawName) ?? [];
        list.push(value);
        values.set(rawName, list);
      } else {
        flags.add(rawName);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (arg === "-h") flags.add("help");
      else if (arg === "-v") flags.add("version");
      else throw new UsageError(`Unknown option ${arg}`);
      continue;
    }
    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, values, flags, negated };
}

function last(values: Map<string, string[]>, name: string): string | undefined {
  return values.get(name)?.at(-1);
}

function all(values: Map<string, string[]>, name: string): string[] {
  return values.get(name) ?? [];
}

function toolVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseHeaders(entries: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator === -1) throw new UsageError(`--header expects "Name: value", got "${entry}"`);
    headers[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return headers;
}

const HELP = `mcp-dual — stateless MCP (${SPEC_VERSION}) migration kit

Usage:
  mcp-dual check   [path] [--url <endpoint> | --stdio <command>] [options]
  mcp-dual shim    (--upstream-http <url> | --upstream-stdio <command>) [options]
  mcp-dual codemod [paths...] [--write] [options]

Commands:
  check     Static scan and live compatibility probe. Prints a matrix, JSON or Markdown.
  shim      Dual-era proxy: legacy client ↔ modern server, or modern client ↔ legacy server.
  codemod   Rewrite TypeScript MCP servers for the 2026-07-28 stateless revision.

check options:
  --url <endpoint>        Streamable HTTP MCP endpoint to probe
  --stdio <command>       stdio MCP server command to spawn and probe
  --path <dir>            Source tree for the static scan (default: .)
  --format <kind>         text | json | markdown (default: text)
  --out <file>            Write the report to a file
  --timeout <ms>          Per-request timeout (default: 5000)
  --header "Name: value"  Extra header for every probe request (repeatable)
  --rules <ids>           Comma-separated static rule ids to run
  --ignore <glob>         Extra ignore pattern for the static scan (repeatable)
  --no-static             Skip the static scan
  --no-probe              Skip the live probe

shim options:
  --listen <port>         Local port (default: 7331; 0 picks a free port)
  --host <host>           Bind host (default: 127.0.0.1)
  --upstream-http <url>   Modern or legacy HTTP MCP endpoint
  --upstream-stdio <cmd>  stdio MCP server command
  --mode <mode>           auto | legacy-client | modern-client (default: auto)
  --stdio                 Serve the shim on stdin/stdout instead of HTTP
  --header "Name: value"  Extra header for upstream requests (repeatable)
  --timeout <ms>          Upstream timeout (default: 10000)

codemod options:
  --dry-run               Show diffs without writing (default)
  --write                 Apply the changes
  --json                  Machine-readable report
  --exclude <regex>       Skip files matching this pattern (repeatable)

Global:
  -h, --help              Show this help
  -v, --version           Print the version

Exit codes for check: 0 compatible, 1 incompatible/partial, 2 unreachable or usage error.
`;

async function runCheckCommand(parsed: ParsedArgs): Promise<number> {
  const path = last(parsed.values, "path") ?? parsed.positionals[0] ?? ".";
  const url = last(parsed.values, "url");
  const stdio = last(parsed.values, "stdio");
  const format = last(parsed.values, "format") ?? (parsed.flags.has("json") ? "json" : "text");
  const out = last(parsed.values, "out");
  const timeoutRaw = last(parsed.values, "timeout");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new UsageError("--timeout must be a positive number of milliseconds");
  }
  if (!["text", "json", "markdown"].includes(format)) {
    throw new UsageError(`Unknown --format ${format}`);
  }

  const skipProbe = parsed.negated.has("probe") || (!url && !stdio);
  const skipStatic = parsed.negated.has("static") || (Boolean(url || stdio) && !parsed.values.has("path"));

  const probeOptions: CheckOptions = {
    ...(url ? { url } : {}),
    ...(stdio ? { stdio } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    headers: parseHeaders(all(parsed.values, "header")),
  };
  const probe = skipProbe ? undefined : await runProbe(probeOptions);

  const staticReport = skipStatic
    ? undefined
    : scanProject(path, {
        ...(last(parsed.values, "rules") ? { rules: (last(parsed.values, "rules") as string).split(",").map((rule) => rule.trim()) } : {}),
        ignore: all(parsed.values, "ignore"),
      });

  const report = buildReport({
    ...(probe ? { probe } : {}),
    ...(staticReport ? { static: staticReport } : {}),
    toolVersion: toolVersion(),
  });

  const rendered = format === "json" ? renderJson(report) : format === "markdown" ? renderMarkdown(report) : renderText(report);
  if (out) {
    writeFileSync(resolve(out), `${rendered}\n`, "utf8");
    process.stdout.write(`Wrote ${out} (exit ${report.exitCode})\n`);
  } else {
    process.stdout.write(`${rendered}\n`);
  }
  return report.exitCode;
}

async function runShimCommand(parsed: ParsedArgs): Promise<number> {
  const upstreamHttp = last(parsed.values, "upstream-http");
  const upstreamStdio = last(parsed.values, "upstream-stdio");
  if (!upstreamHttp && !upstreamStdio) {
    throw new UsageError("shim needs --upstream-http <url> or --upstream-stdio <command>");
  }
  const mode = (last(parsed.values, "mode") ?? "auto") as ShimMode;
  if (!["auto", "legacy-client", "modern-client"].includes(mode)) {
    throw new UsageError(`Unknown --mode ${mode}`);
  }
  const timeoutRaw = last(parsed.values, "timeout");
  const log = (message: string): void => {
    if (parsed.flags.has("verbose") || parsed.flags.has("stdio")) process.stderr.write(`[mcp-dual] ${message}\n`);
  };
  const options = {
    port: Number(last(parsed.values, "listen") ?? (parsed.flags.has("stdio") ? 0 : 7331)),
    ...(last(parsed.values, "host") ? { host: last(parsed.values, "host") as string } : {}),
    ...(upstreamHttp ? { upstreamHttp } : {}),
    ...(upstreamStdio ? { upstreamStdio } : {}),
    upstreamHeaders: parseHeaders(all(parsed.values, "header")),
    mode,
    ...(timeoutRaw ? { timeoutMs: Number(timeoutRaw) } : {}),
    log,
  };

  if (parsed.flags.has("stdio")) {
    await runStdioShim(options);
    return 0;
  }

  const shim = await startShim(options);
  process.stdout.write(
    `mcp-dual shim listening on ${shim.url}\n` +
      `  upstream: ${upstreamHttp ?? upstreamStdio}\n` +
      `  mode: ${mode} (auto detects initialize / Mcp-Session-Id per request)\n` +
      `  point a legacy client at ${shim.url}, or a modern client at ${shim.url}\n`,
  );
  await new Promise<void>((resolveShim) => {
    const stop = (): void => {
      void shim.close().then(() => resolveShim());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function runCodemodCommand(parsed: ParsedArgs): number {
  const targets = parsed.positionals.length > 0 ? parsed.positionals : ["."];
  const write = parsed.flags.has("write");
  const report = runCodemod(targets, {
    write,
    exclude: all(parsed.values, "exclude"),
  });

  if (parsed.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ ...report, files: report.files.map(({ output, ...rest }) => rest) }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `mcp-dual codemod ${write ? "(write)" : "(dry run)"} — ${report.filesScanned} files scanned, ${report.filesChanged} changed, ` +
      `${report.autoChanges} automatic fix(es), ${report.manualChanges} manual TODO(s)\n\n`,
  );
  for (const file of report.files) {
    process.stdout.write(`${file.relPath}\n`);
    for (const change of file.changes) {
      process.stdout.write(`  ${change.kind === "auto" ? "fix " : "todo"} line ${change.line}: ${change.description}\n`);
    }
    process.stdout.write(`${file.diff}\n\n`);
  }
  if (report.filesChanged === 0) {
    process.stdout.write("Nothing to change. This code already looks stateless.\n");
  } else if (!write) {
    process.stdout.write("Re-run with --write to apply these changes.\n");
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags.has("version") || parsed.command === "version") {
    process.stdout.write(`${TOOL_NAME} ${toolVersion()} (MCP ${SPEC_VERSION})\n`);
    return 0;
  }
  if (parsed.flags.has("help") || parsed.command === "help" || parsed.command === "") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  switch (parsed.command) {
    case "check":
      return runCheckCommand(parsed);
    case "shim":
      return runShimCommand(parsed);
    case "codemod":
      return runCodemodCommand(parsed);
    default:
      throw new UsageError(`Unknown command "${parsed.command}". Run mcp-dual --help.`);
  }
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`mcp-dual: ${message}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    });
}
