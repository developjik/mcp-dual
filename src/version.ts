/**
 * Version constants for the stateless MCP era.
 *
 * The 2026-07-28 revision removed the `initialize` handshake and the
 * `Mcp-Session-Id` header, added `server/discover`, and made every request
 * self-describing through `_meta`.
 */
export const SPEC_VERSION = "2026-07-28";

/** Last revision before the stateless core; used by the shim when talking to legacy peers. */
export const PREVIOUS_SPEC_VERSION = "2025-11-25";

export const LEGACY_SPEC_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const TOOL_NAME = "mcp-dual";

/** JSON-RPC error codes introduced or re-used by the 2026-07-28 revision. */
export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;
