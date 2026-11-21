import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanFileContent, scanProject } from "../src/rules.js";

const staticFixtures = fileURLToPath(new URL("./fixtures/static/", import.meta.url));

describe("static rules", () => {
  it("flags the legacy lifecycle, session header, missing headers and cache hints", () => {
    const file = fileURLToPath(new URL("./fixtures/static/legacy-server.ts", import.meta.url));
    const report = scanProject(file);
    const ids = new Set(report.findings.map((finding) => finding.ruleId));

    expect(ids).toContain("legacy-session-header");
    expect(ids).toContain("legacy-initialize");
    expect(ids).toContain("ping-method");
    expect(ids).toContain("logging-set-level");
    expect(ids).toContain("resources-subscribe");
    expect(ids).toContain("legacy-sse-transport");
    expect(ids).toContain("sse-get-stream");
    expect(ids).toContain("sse-resumability");
    expect(ids).toContain("missing-standard-headers");
    expect(ids).toContain("missing-protocol-version-header");
    expect(ids).toContain("missing-result-type");
    expect(ids).toContain("missing-cache-hints");
    expect(ids).toContain("missing-server-discover");
    expect(ids).toContain("dcr-without-application-type");
    expect(report.counts.error).toBeGreaterThan(0);
    expect(report.findings[0]?.severity).toBe("error");
  });

  it("does not flag a modern HTTP handler", () => {
    const file = fileURLToPath(new URL("./fixtures/static/modern-server.ts", import.meta.url));
    const report = scanProject(file);
    expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
    expect(report.filesScanned).toBe(1);
  });

  it("scans a directory and reports every file", () => {
    const report = scanProject(staticFixtures);
    expect(report.filesScanned).toBeGreaterThanOrEqual(2);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.rulesEvaluated).toBeGreaterThan(10);
  });

  it("flags an @modelcontextprotocol/sdk v1 dependency", () => {
    const manifest = JSON.stringify({
      name: "legacy-app",
      dependencies: { "@modelcontextprotocol/sdk": "^1.20.0" },
    });
    const findings = scanFileContent("package.json", "package.json", manifest);
    expect(findings.map((finding) => finding.ruleId)).toContain("legacy-sdk-version");

    const modern = JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "^2.1.0" } });
    expect(scanFileContent("package.json", "package.json", modern)).toEqual([]);
  });

  it("honours ignore-file and ignore-next-line markers", () => {
    const ignoredFile = scanFileContent("x.ts", "x.ts", "// mcp-dual:ignore-file\nconst a = 'Mcp-Session-Id';\n");
    expect(ignoredFile).toEqual([]);

    const ignoredLine = scanFileContent(
      "x.ts",
      "x.ts",
      "// mcp-dual:ignore-next-line\nconst header = 'Mcp-Session-Id';\n",
    );
    expect(ignoredLine).toEqual([]);

    const sessionHeaderOnly = scanFileContent("x.ts", "x.ts", "const header = 'Mcp-Session-Id';\n");
    expect(sessionHeaderOnly.map((finding) => finding.ruleId)).toContain("legacy-session-header");
  });
});
