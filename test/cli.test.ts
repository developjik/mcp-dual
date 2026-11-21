import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startModernServer, type MockServer } from "./helpers/servers.js";

const cli = fileURLToPath(new URL("../dist/bin/cli.js", import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const servers: MockServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe.skipIf(!existsSync(cli))("CLI", () => {
  it("prints help and version", async () => {
    const version = await runCli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain("mcp-dual");
    expect(version.stdout).toContain("2026-07-28");

    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("mcp-dual check");
    expect(help.stdout).toContain("mcp-dual shim");
    expect(help.stdout).toContain("mcp-dual codemod");
  });

  it("runs a static-only check as JSON", async () => {
    const result = await runCli(["check", "--path", fixture("static/modern-server.ts"), "--format", "json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      specVersion: string;
      static: { filesScanned: number; counts: { error: number } };
    };
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.static.filesScanned).toBe(1);
    expect(report.static.counts.error).toBe(0);
  });

  it("probes a live endpoint and returns exit code 0 when compatible", async () => {
    const server = await startModernServer();
    servers.push(server);
    const result = await runCli(["check", "--url", server.url, "--format", "markdown"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2026-07-28 compatibility report");
    expect(result.stdout).toContain("compatible");
  });

  it("prints a codemod dry-run diff", async () => {
    const result = await runCli(["codemod", fixture("codemod/legacy-server.ts"), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("legacy-server.ts");
    expect(result.stdout).toMatch(/^\+.*resultType: "complete"/m);
    expect(result.stdout).toContain("Re-run with --write");
  });
});
