export { SPEC_VERSION, PREVIOUS_SPEC_VERSION, LEGACY_SPEC_VERSIONS, ERROR_CODES, TOOL_NAME } from "./version.js";
export type {
  CheckReport,
  CheckResult,
  CheckSummary,
  ClientEra,
  CompatibilityStatus,
  JsonRpcMessage,
  ProbeReport,
  Requirement,
  Verdict,
} from "./types.js";
export { probeHttp, probeStdio, runProbe, buildReport, summarizeChecks, UsageError } from "./check.js";
export type { CheckOptions, HttpProbeOptions, StdioProbeOptions } from "./check.js";
export { scanProject, scanFileContent, RULES } from "./rules.js";
export type { RuleDefinition, Severity, StaticFinding, StaticReport } from "./rules.js";
export { transformSource, runCodemod } from "./codemod.js";
export type { CodemodChange, CodemodFileResult, CodemodOptions, CodemodReport, TransformResult } from "./codemod.js";
export { startShim, runStdioShim, ShimEngine, HttpUpstream, StdioUpstream, createUpstream, UpstreamError } from "./shim.js";
export type { RunningShim, ShimMode, ShimOptions, ShimOutcome, ShimSessionState, UpstreamEra } from "./shim.js";
export { renderText, renderMarkdown, renderJson } from "./report.js";
export { StdioConnection } from "./stdio.js";
