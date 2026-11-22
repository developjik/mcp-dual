# mcp-dual

[한국어](README.ko.md) · English

**Stateless MCP (`2026-07-28`) migration kit for TypeScript servers: a live compatibility probe, a dual-era shim proxy, and a codemod.**

[![spec](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io/specification/2026-07-28)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/developjik/mcp-dual/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/mcp-dual/actions/workflows/ci.yml)

The `2026-07-28` revision turned MCP from a stateful, handshake-driven protocol into a stateless request/response protocol. Every server author now has the same three questions:

1. **Does my server actually speak the new spec?** — `mcp-dual check` probes it over HTTP or stdio and prints a pass/fail matrix with a CI exit code.
2. **Can old clients keep talking to it while I migrate?** — `mcp-dual shim` is a local proxy that bridges a legacy client to a stateless server, or a stateless client to a legacy server.
3. **What do I change in the code?** — `mcp-dual codemod` proposes a diff for TypeScript MCP servers, auto-fixing the mechanical parts and marking the rest with TODOs.

```
npx mcp-dual check --url https://your-server.example.com/mcp --format markdown
npx mcp-dual check .                                  # static scan only
npx mcp-dual shim --upstream-http http://localhost:3000/mcp --listen 7331
npx mcp-dual codemod src --dry-run                    # then --write
```

---

## What changed in `2026-07-28`

| Change | Before (`2025-11-25`) | After (`2026-07-28`) |
| --- | --- | --- |
| Lifecycle | `initialize` / `notifications/initialized` handshake | No handshake; every request carries `_meta` (`protocolVersion`, `clientCapabilities`, `clientInfo`) |
| Sessions | `Mcp-Session-Id`, server-side session state | Session id and protocol sessions removed; list results identical for every connection |
| Discovery | `initialize` result | `server/discover` RPC (supported versions, capabilities, identity) |
| HTTP routing | Body parsing | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers required; mismatch = `400` + `-32020` |
| Server → client | `sampling/createMessage`, `elicitation/create`, `roots/list` requests | Multi Round-Trip Requests: `resultType: "input_required"` + `inputRequests`, retried with `inputResponses` |
| Results | no `resultType` | Required `resultType` (`complete` / `input_required`) |
| Lists / reads | — | `ttlMs` + `cacheScope` on list and read results |
| Subscriptions | GET SSE stream, `resources/subscribe` | `subscriptions/listen` POST stream |
| Utilities | `ping`, `logging/setLevel` | Removed; log level per request via `_meta` |
| Tasks | core `tasks/*` | `io.modelcontextprotocol/tasks` extension (`tasks/get`, `tasks/update`) |
| Auth | DCR | DCR deprecated in favour of CIMD; `application_type` required when using DCR |

`mcp-dual` covers the TypeScript side of this migration. Python servers should use [`mcp-migrate`](https://github.com/dheerajjha/mcp-migrate); the `check` probe works against any language over HTTP or stdio.

---

## Install

```bash
npm install -g mcp-dual
# or run without installing
npx mcp-dual --help
```

Requires Node.js 20 or newer. No MCP SDK dependency: the probe speaks JSON-RPC directly, so it can inspect servers built with any SDK version.

---

## 1. `check` — compatibility matrix and CI exit code

### Live probe

```bash
mcp-dual check --url http://localhost:3000/mcp
mcp-dual check --stdio "node dist/server.js" --format json
mcp-dual check --url https://api.example.com/mcp --header "Authorization: Bearer $TOKEN" --format markdown --out report.md
```

The HTTP probe performs **14 checks**, each derived from a `MUST`/`SHOULD` in the spec:

| Check | Requirement | What it proves |
| --- | --- | --- |
| Endpoint reachable | must | the URL answers HTTP |
| `server/discover` implemented | must | `supportedVersions` includes `2026-07-28`, capabilities present |
| Stateless request accepted | must | `tools/list` works without `initialize` or a session |
| Results carry `resultType` | must | ordinary results include `resultType: "complete"` |
| List results are cacheable | should | `ttlMs` and `cacheScope` present |
| Header/body mismatch rejected | must | wrong `Mcp-Method` → `400` + `-32020` |
| `Mcp-Method` header required | must | missing header → `400` + `-32020` |
| `MCP-Protocol-Version` header required | must | missing header → `400` + `-32020` |
| Unknown versions rejected with supported list | must | unknown version → `-32022` + `data.supported` |
| `Mcp-Session-Id` ignored | must | no session id minted or echoed |
| Legacy `initialize` retired | should | handshake returns a JSON-RPC error |
| GET stream retired (`405`) | should | standalone SSE endpoint is gone |
| Unknown methods return `-32601` | must | and HTTP `404` |
| `subscriptions/listen` available | should | reported as skipped (needs a long-lived stream) |

The stdio probe runs the same checks that make sense without HTTP (discover, stateless call, `resultType`, cache hints, version negotiation, `initialize`/`ping` retirement, unknown method) and marks header/session/GET checks as `skip`.

**Exit codes:** `0` all mandatory checks pass · `1` partial or legacy/incompatible · `2` unreachable or usage error.

Example output (`--format markdown`):

```
**Status:** ✅ compatible — 13 pass · 0 warn · 0 fail · 1 skip (64ms)

| Check | Requirement | Result | Detail |
| --- | --- | --- | --- |
| server/discover implemented | must | ✅ pass | Advertises 2026-07-28 with capabilities |
| Stateless request accepted | must | ✅ pass | tools/list answered with 2 tool(s) without initialize or a session |
| Header/body mismatch rejected | must | ✅ pass | Mismatched Mcp-Method returned HTTP 400 with -32020 HeaderMismatch |
| Mcp-Session-Id ignored | must | ✅ pass | A request carrying Mcp-Session-Id was served and no session id was returned |
```

`--format markdown` also emits a shields.io badge line, so a server repo can publish its own compatibility result.

### Static scan

```bash
mcp-dual check .                       # scans .ts/.tsx/.mts/.cts/.js/.mjs/.cjs and package.json
mcp-dual check --path src --rules legacy-session-header,missing-standard-headers
```

18 rules cover the legacy patterns that are visible before running anything:

| Rule | Severity | Auto-fix |
| --- | --- | --- |
| `legacy-session-header` — `Mcp-Session-Id` usage | error | manual TODO |
| `legacy-initialize` — `initialize` / `initialized` | error | manual TODO |
| `missing-standard-headers` — HTTP handler without `Mcp-Method`/`Mcp-Name` | error | manual TODO |
| `missing-protocol-version-header` | error | manual TODO |
| `legacy-sse-transport` — `SSEServerTransport`, `/server/sse` import | error | rename + import rewrite |
| `missing-result-type` | warning | add `resultType` |
| `missing-cache-hints` | warning | add `ttlMs`/`cacheScope` |
| `missing-server-discover` | warning | manual TODO |
| `sse-get-stream` | warning | manual TODO |
| `sse-resumability` (`Last-Event-ID`) | warning | manual TODO |
| `resources-subscribe` | warning | manual TODO |
| `ping-method` | warning | manual TODO |
| `logging-set-level` | warning | manual TODO |
| `dcr-without-application-type` | warning | manual TODO |
| `legacy-sdk-version` — SDK v1 in `package.json` | warning | upgrade |
| `server-initiated-request` — sampling/elicitation/roots | info | manual TODO |
| `legacy-tasks` — `tasks/result`, `tasks/list` | info | manual TODO |
| `hardcoded-legacy-version` | info | negotiate instead |

Suppress intentional/legacy-aware code with `// mcp-dual:ignore-file` at the top of a file, `// mcp-dual:ignore-next-line`, or a `.mcpdualignore` file (`node_modules`, `dist`, `.git`, `coverage` and similar directories are always skipped).

### CI

```yaml
- name: MCP stateless compliance
  run: npx mcp-dual check --url "$MCP_URL" --header "Authorization: Bearer $MCP_TOKEN" --format markdown --out mcp-report.md
```

A non-zero exit fails the job. Upload `mcp-report.md` as an artifact to keep the matrix next to the build.

---

## 2. `shim` — run both eras at once

```
legacy client ── initialize + Mcp-Session-Id ──▶ mcp-dual shim ── stateless POST + Mcp-Method/Mcp-Name ──▶ new server
modern client ── per-request _meta ───────────▶ mcp-dual shim ── initialize + Mcp-Session-Id ───────────▶ old server
```

```bash
# legacy clients → stateless server
mcp-dual shim --upstream-http http://localhost:3000/mcp --listen 7331

# stateless clients → legacy server
mcp-dual shim --upstream-http http://localhost:3000/mcp --mode modern-client --listen 7331

# either side, with a local stdio server behind the proxy
mcp-dual shim --upstream-stdio "node dist/server.js" --listen 7331

# speak the shim itself over stdio
mcp-dual shim --stdio --upstream-http http://localhost:3000/mcp
```

**Legacy client → stateless server:** the shim answers `initialize` itself from `server/discover`, mints its own `shim_…` session id, and keeps the client's `clientInfo` / `clientCapabilities` / `logLevel` as the session's context. Every later request is rewritten into a self-describing stateless request with `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and `_meta`; the session id is never forwarded. `ping` and `logging/setLevel` are answered locally because the new core removed them. `DELETE` closes the shim session.

**Stateless client → legacy server:** the shim initializes the upstream once, keeps its `Mcp-Session-Id`, synthesizes `server/discover` from the legacy `initialize` result, and normalizes legacy results: adds `resultType: "complete"`, `ttlMs`/`cacheScope` on cacheable methods, and `serverInfo` in `_meta`.

The shim auto-detects which era each side speaks (an `initialize` request or an `Mcp-Session-Id` header means legacy) and can be forced with `--mode`.

---

## 3. `codemod` — a diff, not a rewrite

```bash
mcp-dual codemod src --dry-run          # default: print unified diffs
mcp-dual codemod src --write            # apply
mcp-dual codemod src --json --dry-run    # machine-readable change list
```

Automatic, syntax-preserving fixes (TypeScript compiler API; the only runtime dependency is `typescript`):

- add `resultType: "complete"` to returned tool results;
- add `ttlMs: 0` / `cacheScope: "private"` to returned list and read results;
- rewrite `@modelcontextprotocol/sdk/server/sse.js` → `streamableHttp.js` and rename `SSEServerTransport` → `StreamableHTTPServerTransport`.

Everything that needs a human decision (session plumbing, `initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, MRTR/server-initiated requests) gets a single `// TODO(mcp-dual): …` above the innermost statement, so the diff stays reviewable. The codemod is idempotent: running it twice produces no changes.

```diff
-import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
+import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
 
+// TODO(mcp-dual): The initialize handshake was removed. Move protocolVersion/clientInfo/clientCapabilities into params._meta and implement server/discover.
 server.setRequestHandler(InitializeRequestSchema, async () => { … });
 
 server.setRequestHandler(ListToolsRequestSchema, async () => ({
+  resultType: "complete",
+  ttlMs: 0,
+  cacheScope: "private",
   tools: [ … ],
 }));
```

---

## How it compares

| Tool | Scope | What it does not do |
| --- | --- | --- |
| **mcp-dual** | TypeScript servers + any HTTP/stdio endpoint | no Python codemod, no auth flow automation |
| [`mcp-migrate`](https://github.com/dheerajjha/mcp-migrate) (Python) | Python source codemod, 21 rules / 19 fixers | no TypeScript, no dual-era runtime, no live probe matrix |
| [`modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) | protocol test suite | no migration, shim, or per-server report |
| [`tachyon`](https://github.com/tachyonmcp/tachyon) | Java/Kotlin dual-era runtime | outside the JS ecosystem |
| [`inspector`](https://github.com/modelcontextprotocol/inspector) | manual MCP debugging | no "which version does my server speak" matrix |

The split is deliberate: Python teams keep using `mcp-migrate`, TypeScript teams get the codemod **plus** the two things a codemod cannot give them — a live verdict and a runtime bridge.

---

## Limits (v0.1)

- **Streaming is flattened.** The shim returns the final JSON-RPC result of each request; request-scoped `notifications/progress` and `notifications/message` on an SSE response are not relayed yet. Long-running tools still work, but progress bars will not move through the shim.
- **`subscriptions/listen` is not bridged** to a legacy upstream's GET stream (returns `501`). Stateless-to-stateless traffic passes it through untouched.
- **MRTR is passed through, not simulated.** A modern server's `input_required` result reaches a modern client, but the shim does not convert it into sampling/elicitation requests for a legacy client.
- **No authorization flows.** DCR/CIMD/OAuth are not implemented; use `--header` to attach credentials the probe and shim should send.
- **Static rules are heuristics.** They are file-level pattern checks, not a full type-aware analysis; the live probe is the source of truth. `mcp-dual:ignore` markers exist for intentional legacy code.
- **Codemod auto-fixes are conservative.** It will not delete a session store or invent a `server/discover` handler for you — those become TODOs.
- **Python/Go/Rust servers** are only covered by `check` (HTTP/stdio), not by the codemod.

---

## Development

```bash
npm install
npm run typecheck
npm test          # builds, then runs 25 tests
npm run build
```

Test coverage:

- rule scanner fixtures (legacy and already-modern servers);
- live HTTP probe against a **strict mock stateless server** and a **legacy session server**;
- stdio probe against mock modern/legacy stdio servers;
- shim round-trips in all four directions (legacy↔modern over HTTP and stdio), including session bridging, 405 GET, unknown session, DELETE;
- codemod resultType/cache-hint insertion, TODO placement, SSE import rewrite, idempotence, `--write`;
- CLI end-to-end (`--version`, static JSON, live Markdown, codemod diff).

```
src/
  check.ts    live HTTP/stdio probe, status and next steps
  rules.ts    18 static rules + project scanner
  shim.ts     era detection, HTTP/stdio upstreams, session bridge
  codemod.ts  TypeScript AST transforms + unified diff
  http.ts     JSON-RPC framing, headers, SSE parsing, _meta helpers
  stdio.ts    line-delimited JSON-RPC child process
  report.ts   text / Markdown / JSON renderers
bin/cli.ts    check | shim | codemod
```

## License

MIT © 2026 Inkwon Jung
