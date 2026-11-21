import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildReport, probeHttp, probeStdio } from "../src/check.js";
import { renderMarkdown, renderText } from "../src/report.js";
import { startModernServer, startLegacyServer, type MockServer } from "./helpers/servers.js";

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const servers: MockServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("HTTP probe", () => {
  it("passes every mandatory check against a stateless server", async () => {
    const server = await startModernServer();
    servers.push(server);
    const report = await probeHttp(server.url, { timeoutMs: 4_000 });

    expect(report.status).toBe("compatible");
    expect(report.checks.filter((check) => check.verdict === "fail")).toEqual([]);
    expect(report.checks.find((check) => check.id === "session-removed")?.verdict).toBe("pass");
    expect(report.checks.find((check) => check.id === "header-mismatch")?.verdict).toBe("pass");
    expect(report.checks.find((check) => check.id === "cache-hints")?.verdict).toBe("pass");

    const report2 = buildReport({ probe: report, toolVersion: "0.1.0" });
    expect(report2.exitCode).toBe(0);
    expect(renderMarkdown(report2)).toContain("| Check | Requirement | Result | Detail |");
    expect(renderMarkdown(report2)).toContain("brightgreen");
    expect(renderText(report2)).toContain("compatible");
  });

  it("detects a legacy session-based server", async () => {
    const server = await startLegacyServer();
    servers.push(server);
    const report = await probeHttp(server.url, { timeoutMs: 4_000 });

    expect(report.status).toBe("legacy");
    const stateless = report.checks.find((check) => check.id === "stateless-request");
    expect(stateless?.verdict).toBe("fail");
    expect(report.checks.find((check) => check.id === "initialize-retired")?.verdict).toBe("warn");
    expect(report.checks.find((check) => check.id === "server-discover")?.verdict).toBe("fail");
    const built = buildReport({ probe: report, toolVersion: "0.1.0" });
    expect(built.exitCode).toBe(1);
    expect(built.nextSteps.join("\n")).toContain("mcp-dual shim");
  });

  it("reports an unreachable endpoint with exit code 2", async () => {
    const report = await probeHttp("http://127.0.0.1:9/mcp", { timeoutMs: 800 });
    expect(report.status).toBe("unreachable");
    const built = buildReport({ probe: report, toolVersion: "0.1.0" });
    expect(built.exitCode).toBe(2);
  });
});

describe("stdio probe", () => {
  it("passes mandatory checks against a stateless stdio server", async () => {
    const report = await probeStdio(`node "${fixture("stdio-modern.mjs")}"`, { timeoutMs: 5_000 });
    expect(report.status).toBe("compatible");
    const headerChecks = report.checks.filter((check) => check.id === "header-required");
    expect(headerChecks[0]?.verdict).toBe("skip");
    expect(report.checks.find((check) => check.id === "ping-removed")?.verdict).toBe("pass");
  });

  it("flags a legacy stdio server", async () => {
    const report = await probeStdio(`node "${fixture("stdio-legacy.mjs")}"`, { timeoutMs: 5_000 });
    expect(report.status).not.toBe("compatible");
    expect(report.checks.find((check) => check.id === "server-discover")?.verdict).toBe("fail");
    expect(report.checks.find((check) => check.id === "initialize-retired")?.verdict).toBe("warn");
  });
});
