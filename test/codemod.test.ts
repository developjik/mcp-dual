import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCodemod, transformSource } from "../src/codemod.js";

const fixture = fileURLToPath(new URL("./fixtures/codemod/legacy-server.ts", import.meta.url));
const source = readFileSync(fixture, "utf8");
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("codemod", () => {
  it("adds resultType and cache hints to returned result objects", () => {
    const result = transformSource("legacy-server.ts", source);
    expect(result.output.match(/resultType: "complete"/g)?.length).toBe(2);
    expect(result.output).toContain("ttlMs: 0");
    expect(result.output).toContain('cacheScope: "private"');
    expect(result.changes.filter((change) => change.ruleId === "missing-result-type" && change.kind === "auto")).toHaveLength(1);
    expect(result.changes.filter((change) => change.ruleId === "missing-cache-hints" && change.kind === "auto")).toHaveLength(1);
  });

  it("inserts manual TODOs for removed protocol features", () => {
    const result = transformSource("legacy-server.ts", source);
    expect(result.output).toContain("TODO(mcp-dual): The initialize handshake was removed");
    expect(result.output).toContain("TODO(mcp-dual): ping was removed");
    expect(result.output).toContain("TODO(mcp-dual): logging/setLevel was removed");
    expect(result.output).toContain("TODO(mcp-dual): resources/subscribe was replaced");
    expect(result.output.match(/Mcp-Session-Id was removed/g)?.length).toBe(1);
  });

  it("rewrites the deprecated SSE transport import and identifier", () => {
    const result = transformSource("legacy-server.ts", source);
    expect(result.output).toContain('from "@modelcontextprotocol/sdk/server/streamableHttp.js"');
    expect(result.output).toContain("new StreamableHTTPServerTransport(");
    expect(result.output).not.toContain("SSEServerTransport");
  });

  it("produces a unified diff without touching the input", () => {
    const result = transformSource("legacy-server.ts", source);
    expect(result.diff).toContain("--- a/legacy-server.ts");
    expect(result.diff).toContain("+++ b/legacy-server.ts");
    expect(result.diff.split("\n").some((line) => line.startsWith("+") && line.includes("resultType"))).toBe(true);
    expect(readFileSync(fixture, "utf8")).toBe(source);
  });

  it("is idempotent", () => {
    const once = transformSource("legacy-server.ts", source);
    const twice = transformSource("legacy-server.ts", once.output);
    expect(twice.changes).toEqual([]);
    expect(twice.output).toBe(once.output);
  });

  it("writes changes only with --write", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-dual-codemod-"));
    tempDirs.push(dir);
    const target = join(dir, "server.ts");
    copyFileSync(fixture, target);

    const dryRun = runCodemod([dir]);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.filesChanged).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(source);

    const applied = runCodemod([dir], { write: true });
    expect(applied.dryRun).toBe(false);
    expect(applied.autoChanges).toBeGreaterThan(3);
    expect(applied.manualChanges).toBeGreaterThan(3);
    const written = readFileSync(target, "utf8");
    expect(written).toContain('resultType: "complete"');
    expect(written).toContain("TODO(mcp-dual)");
  });
});
