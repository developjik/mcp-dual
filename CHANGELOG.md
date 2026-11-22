# Changelog

## 0.1.1 — 2026-11-22

### Added
- The shim now relays upstream SSE notifications (`notifications/progress`, `notifications/message`, and any other request-scoped notification) to the client as a `text/event-stream` response carrying the notifications followed by the final replies — progress bars keep moving through the shim (DEV-27).
- `subscriptions/listen` is bridged for HTTP upstreams: a pass-through POST stream against a stateless upstream, and a session GET-stream bridge against a legacy upstream. Upstreams with no server-initiated stream (a legacy GET that is not SSE, or `--upstream-stdio`) still return `501` (DEV-27).
- stdio upstream notifications are queued and flushed alongside the next reply; the stdio-facing shim decodes a listen stream into JSON lines for its client (DEV-27).
- MRTR `input_required` conversion scope is now defined and documented: transport-level relay only — the result and `inputRequests` reach the client verbatim and `inputResponses` retries pass through untouched; no sampling/elicitation simulation (DEV-27).

## 0.1.0 — 2026-11-21

Initial release: live compatibility probe, dual-era shim proxy, and TypeScript codemod for the MCP 2026-07-28 stateless migration.
