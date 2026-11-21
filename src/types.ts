import type { StaticReport } from "./rules.js";

export type Requirement = "must" | "should";

export type Verdict = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Stable identifier used in JSON output and tests. */
  id: string;
  title: string;
  requirement: Requirement;
  verdict: Verdict;
  detail: string;
  /** Short machine-readable evidence, e.g. status code or error code. */
  evidence?: Record<string, unknown>;
}

export interface CheckSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

/**
 * - `compatible`: every mandatory probe passed.
 * - `partial`: the server answers modern MCP requests but misses mandatory behavior.
 * - `legacy`: the endpoint is reachable but does not speak the stateless revision.
 * - `unreachable`: no MCP response could be obtained.
 * - `not-probed`: static scan only.
 */
export type CompatibilityStatus = "compatible" | "partial" | "legacy" | "unreachable" | "not-probed";

export type ProbeTransport = "http" | "stdio";

export interface ProbeReport {
  transport: ProbeTransport;
  target: string;
  status: CompatibilityStatus;
  startedAt: string;
  durationMs: number;
  checks: CheckResult[];
  summary: CheckSummary;
}

export interface CheckReport {
  tool: { name: string; version: string };
  specVersion: string;
  generatedAt: string;
  probe?: ProbeReport;
  static?: StaticReport;
  /** 0 = compatible, 1 = incompatible/partial, 2 = usage or connection failure. */
  exitCode: number;
  nextSteps: string[];
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export interface JsonRpcRequest extends JsonRpcMessage {
  id: string | number;
  method: string;
}

export type ClientEra = "legacy" | "modern";

export interface ClientContext {
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
  logLevel?: string;
}
