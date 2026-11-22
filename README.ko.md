# mcp-dual

[English](README.md) · 한국어

**TypeScript 서버를 위한 무상태(stateless) MCP(`2026-07-28`) 마이그레이션 킷: 실시간 호환성 프로브, 두 시대를 함께 지원하는 shim 프록시, 그리고 codemod.**

[![spec](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io/specification/2026-07-28)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/developjik/mcp-dual/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/mcp-dual/actions/workflows/ci.yml)

`2026-07-28` 리비전은 MCP를 상태를 가진 핸드셰이크 기반 프로토콜에서 무상태 요청/응답 프로토콜로 바꿨습니다. 이제 모든 서버 작성자는 같은 세 가지 질문을 갖게 됩니다:

1. **내 서버가 정말 새 스펙을 말하는가?** — `mcp-dual check`가 HTTP 또는 stdio로 프로브하고, CI 종료 코드가 붙은 통과/실패 매트릭스를 출력합니다.
2. **마이그레이션하는 동안 옛 클라이언트가 계속 붙어 있을 수 있는가?** — `mcp-dual shim`은 레거시 클라이언트를 무상태 서버에, 또는 무상태 클라이언트를 레거시 서버에 연결하는 로컬 프록시입니다.
3. **코드에서 무엇을 바꿔야 하는가?** — `mcp-dual codemod`가 TypeScript MCP 서버용 diff를 제안하고, 기계적인 부분은 자동 수정하며, 나머지는 TODO로 표시합니다.

```
npx mcp-dual check --url https://your-server.example.com/mcp --format markdown
npx mcp-dual check .                                  # static scan only
npx mcp-dual shim --upstream-http http://localhost:3000/mcp --listen 7331
npx mcp-dual codemod src --dry-run                    # then --write
```

---

## `2026-07-28`에서 무엇이 바뀌었나

| 변경 | 이전 (`2025-11-25`) | 이후 (`2026-07-28`) |
| --- | --- | --- |
| 라이프사이클 | `initialize` / `notifications/initialized` 핸드셰이크 | 핸드셰이크 없음; 모든 요청이 `_meta`(`protocolVersion`, `clientCapabilities`, `clientInfo`)를 지님 |
| 세션 | `Mcp-Session-Id`, 서버 측 세션 상태 | 세션 id와 프로토콜 세션 제거; 모든 연결에서 리스트 결과가 동일 |
| 디스커버리 | `initialize` 결과 | `server/discover` RPC (지원 버전, 기능, 아이덴티티) |
| HTTP 라우팅 | 본문 파싱 | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` 헤더 필수; 불일치 = `400` + `-32020` |
| 서버 → 클라이언트 | `sampling/createMessage`, `elicitation/create`, `roots/list` 요청 | Multi Round-Trip Requests: `resultType: "input_required"` + `inputRequests`, `inputResponses`로 재시도 |
| 결과 | `resultType` 없음 | `resultType` 필수 (`complete` / `input_required`) |
| 리스트 / 읽기 | — | 리스트·읽기 결과에 `ttlMs` + `cacheScope` |
| 구독 | GET SSE 스트림, `resources/subscribe` | `subscriptions/listen` POST 스트림 |
| 유틸리티 | `ping`, `logging/setLevel` | 제거; 요청별 로그 레벨은 `_meta`로 |
| 태스크 | 코어 `tasks/*` | `io.modelcontextprotocol/tasks` 확장 (`tasks/get`, `tasks/update`) |
| 인증 | DCR | DCR은 CIMD 권장으로 폐기 예정; DCR을 쓰면 `application_type` 필수 |

`mcp-dual`은 이 마이그레이션의 TypeScript 쪽을 다룹니다. Python 서버는 [`mcp-migrate`](https://github.com/dheerajjha/mcp-migrate)를 쓰세요. `check` 프로브는 HTTP 또는 stdio를 통해 어떤 언어의 서버에도 동작합니다.

---

## 설치

```bash
npm install -g mcp-dual
# 또는 설치 없이 실행
npx mcp-dual --help
```

Node.js 20 이상이 필요합니다. MCP SDK 의존성이 없습니다: 프로브가 JSON-RPC를 직접 말하므로 어떤 SDK 버전으로 만든 서버든 검사할 수 있습니다.

---

## 1. `check` — 호환성 매트릭스와 CI 종료 코드

### 라이브 프로브

```bash
mcp-dual check --url http://localhost:3000/mcp
mcp-dual check --stdio "node dist/server.js" --format json
mcp-dual check --url https://api.example.com/mcp --header "Authorization: Bearer $TOKEN" --format markdown --out report.md
```

HTTP 프로브는 **14개 검사**를 수행하며, 각각은 스펙의 `MUST`/`SHOULD`에서 나온 것입니다:

| 검사 | 요구 수준 | 증명하는 것 |
| --- | --- | --- |
| 엔드포인트 도달 가능 | must | URL이 HTTP로 응답함 |
| `server/discover` 구현됨 | must | `supportedVersions`에 `2026-07-28` 포함, 기능 제시 |
| 무상태 요청 수용 | must | `initialize`나 세션 없이 `tools/list` 동작 |
| 결과에 `resultType` 포함 | must | 일반 결과에 `resultType: "complete"` 포함 |
| 리스트 결과 캐시 가능 | should | `ttlMs`와 `cacheScope` 존재 |
| 헤더/본문 불일치 거부 | must | 잘못된 `Mcp-Method` → `400` + `-32020` |
| `Mcp-Method` 헤더 필수 | must | 헤더 누락 → `400` + `-32020` |
| `MCP-Protocol-Version` 헤더 필수 | must | 헤더 누락 → `400` + `-32020` |
| 알 수 없는 버전은 지원 목록과 함께 거부 | must | 알 수 없는 버전 → `-32022` + `data.supported` |
| `Mcp-Session-Id` 무시 | must | 세션 id를 발급하지도 되돌려주지도 않음 |
| 레거시 `initialize` 폐기 | should | 핸드셰이크가 JSON-RPC 에러 반환 |
| GET 스트림 폐기(`405`) | should | 독립 SSE 엔드포인트 없음 |
| 알 수 없는 메서드는 `-32601` 반환 | must | 그리고 HTTP `404` |
| `subscriptions/listen` 사용 가능 | should | 건너뜀으로 보고 (장기 스트림 필요) |

stdio 프로브는 HTTP 없이도 의미 있는 같은 검사를 수행하고(디스커버리, 무상태 호출, `resultType`, 캐시 힌트, 버전 협상, `initialize`/`ping` 폐기, 알 수 없는 메서드), 헤더/세션/GET 검사는 `skip`으로 표시합니다.

**종료 코드:** `0` 필수 검사 전부 통과 · `1` 부분 통과 또는 레거시/비호환 · `2` 도달 불가 또는 사용법 오류.

출력 예시(`--format markdown`):

```
**Status:** ✅ compatible — 13 pass · 0 warn · 0 fail · 1 skip (64ms)

| Check | Requirement | Result | Detail |
| --- | --- | --- | --- |
| server/discover implemented | must | ✅ pass | Advertises 2026-07-28 with capabilities |
| Stateless request accepted | must | ✅ pass | tools/list answered with 2 tool(s) without initialize or a session |
| Header/body mismatch rejected | must | ✅ pass | Mismatched Mcp-Method returned HTTP 400 with -32020 HeaderMismatch |
| Mcp-Session-Id ignored | must | ✅ pass | A request carrying Mcp-Session-Id was served and no session id was returned |
```

`--format markdown`은 shields.io 배지 줄도 출력하므로, 서버 리포가 자기 호환성 결과를 게시할 수 있습니다.

### 정적 스캔

```bash
mcp-dual check .                       # .ts/.tsx/.mts/.cts/.js/.mjs/.cjs와 package.json 스캔
mcp-dual check --path src --rules legacy-session-header,missing-standard-headers
```

18개 규칙이 무엇이든 실행하기 전에 보이는 레거시 패턴을 다룹니다:

| 규칙 | 심각도 | 자동 수정 |
| --- | --- | --- |
| `legacy-session-header` — `Mcp-Session-Id` 사용 | error | 수동 TODO |
| `legacy-initialize` — `initialize` / `initialized` | error | 수동 TODO |
| `missing-standard-headers` — `Mcp-Method`/`Mcp-Name` 없는 HTTP 핸들러 | error | 수동 TODO |
| `missing-protocol-version-header` | error | 수동 TODO |
| `legacy-sse-transport` — `SSEServerTransport`, `/server/sse` import | error | 이름 변경 + import 재작성 |
| `missing-result-type` | warning | `resultType` 추가 |
| `missing-cache-hints` | warning | `ttlMs`/`cacheScope` 추가 |
| `missing-server-discover` | warning | 수동 TODO |
| `sse-get-stream` | warning | 수동 TODO |
| `sse-resumability` (`Last-Event-ID`) | warning | 수동 TODO |
| `resources-subscribe` | warning | 수동 TODO |
| `ping-method` | warning | 수동 TODO |
| `logging-set-level` | warning | 수동 TODO |
| `dcr-without-application-type` | warning | 수동 TODO |
| `legacy-sdk-version` — `package.json`의 SDK v1 | warning | 업그레이드 |
| `server-initiated-request` — sampling/elicitation/roots | info | 수동 TODO |
| `legacy-tasks` — `tasks/result`, `tasks/list` | info | 수동 TODO |
| `hardcoded-legacy-version` | info | 대신 협상 |

의도적이거나 레거시를 인지한 코드는 파일 맨 위의 `// mcp-dual:ignore-file`, `// mcp-dual:ignore-next-line`, 또는 `.mcpdualignore` 파일로 억제하세요(`node_modules`, `dist`, `.git`, `coverage` 같은 디렉터리는 항상 건너뜁니다).

### CI

```yaml
- name: MCP stateless compliance
  run: npx mcp-dual check --url "$MCP_URL" --header "Authorization: Bearer $MCP_TOKEN" --format markdown --out mcp-report.md
```

종료 코드가 0이 아니면 잡이 실패합니다. `mcp-report.md`를 아티팩트로 업로드해 매트릭스를 빌드 옆에 남기세요.

---

## 2. `shim` — 두 시대를 동시에

```
legacy client ── initialize + Mcp-Session-Id ──▶ mcp-dual shim ── stateless POST + Mcp-Method/Mcp-Name ──▶ new server
modern client ── per-request _meta ───────────▶ mcp-dual shim ── initialize + Mcp-Session-Id ───────────▶ old server
```

```bash
# 레거시 클라이언트 → 무상태 서버
mcp-dual shim --upstream-http http://localhost:3000/mcp --listen 7331

# 무상태 클라이언트 → 레거시 서버
mcp-dual shim --upstream-http http://localhost:3000/mcp --mode modern-client --listen 7331

# 어느 쪽이든, 프록시 뒤에 로컬 stdio 서버를 둠
mcp-dual shim --upstream-stdio "node dist/server.js" --listen 7331

# shim 자체를 stdio로 말함
mcp-dual shim --stdio --upstream-http http://localhost:3000/mcp
```

**레거시 클라이언트 → 무상태 서버:** shim이 `server/discover`를 바탕으로 `initialize`에 직접 응답하고, 자체 `shim_…` 세션 id를 발급하며, 클라이언트의 `clientInfo` / `clientCapabilities` / `logLevel`을 세션 컨텍스트로 유지합니다. 이후 모든 요청은 `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `_meta`를 지닌 자기서술적 무상태 요청으로 재작성되고, 세션 id는 절대 넘기지 않습니다. `ping`과 `logging/setLevel`은 새 코어에서 제거됐으므로 로컬에서 응답합니다. `DELETE`는 shim 세션을 닫습니다.

**무상태 클라이언트 → 레거시 서버:** shim이 업스트림을 한 번 초기화하고 그 `Mcp-Session-Id`를 유지하며, 레거시 `initialize` 결과에서 `server/discover`를 합성하고, 레거시 결과를 정규화합니다: `resultType: "complete"` 추가, 캐시 가능한 메서드에 `ttlMs`/`cacheScope` 추가, `_meta`에 `serverInfo` 추가.

shim은 양쪽이 어느 시대를 말하는지 자동 감지하고(`initialize` 요청이나 `Mcp-Session-Id` 헤더가 있으면 레거시), `--mode`로 강제할 수 있습니다.

---

## 3. `codemod` — 재작성이 아니라 diff

```bash
mcp-dual codemod src --dry-run          # 기본: 통합 diff 출력
mcp-dual codemod src --write            # 적용
mcp-dual codemod src --json --dry-run    # 기계 판독 가능한 변경 목록
```

자동이고 구문을 보존하는 수정(TypeScript 컴파일러 API 사용, 유일한 런타임 의존성은 `typescript`):

- 반환되는 툴 결과에 `resultType: "complete"` 추가;
- 반환되는 리스트·읽기 결과에 `ttlMs: 0` / `cacheScope: "private"` 추가;
- `@modelcontextprotocol/sdk/server/sse.js` → `streamableHttp.js` 재작성, `SSEServerTransport` → `StreamableHTTPServerTransport` 이름 변경.

사람의 판단이 필요한 모든 것(세션 배관, `initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, MRTR/서버 시작 요청)은 가장 안쪽 문장 위에 `// TODO(mcp-dual): …` 하나를 붙이므로 diff는 리뷰 가능한 상태로 남습니다. codemod는 멱등합니다: 두 번 돌려도 변경이 없습니다.

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

## 다른 도구와 비교

| 도구 | 범위 | 하지 않는 것 |
| --- | --- | --- |
| **mcp-dual** | TypeScript 서버 + 모든 HTTP/stdio 엔드포인트 | Python codemod 없음, 인증 플로 자동화 없음 |
| [`mcp-migrate`](https://github.com/dheerajjha/mcp-migrate) (Python) | Python 소스 codemod, 규칙 21개 / 픽서 19개 | TypeScript 없음, 두 시대 런타임 없음, 라이브 프로브 매트릭스 없음 |
| [`modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) | 프로토콜 테스트 스위트 | 마이그레이션, shim, 서버별 리포트 없음 |
| [`tachyon`](https://github.com/tachyonmcp/tachyon) | Java/Kotlin 두 시대 런타임 | JS 생태계 밖 |
| [`inspector`](https://github.com/modelcontextprotocol/inspector) | 수동 MCP 디버깅 | "내 서버가 어느 버전을 말하는가" 매트릭스 없음 |

분담은 의도적입니다: Python 팀은 `mcp-migrate`를 계속 쓰고, TypeScript 팀은 codemod **더하기** codemod가 줄 수 없는 두 가지 — 라이브 판정과 런타임 브리지 — 를 받습니다.

---

## 한계 (v0.1)

- **요청 범위 알림은 SSE로 중계됩니다.** 업스트림이 응답 위에 `notifications/progress`·`notifications/message`(또는 다른 알림)를 스트리밍하면, shim은 그 알림들 다음에 최종 응답을 담은 `text/event-stream` 본문으로 응답합니다 — 진행 표시줄이 shim을 거쳐서도 움직입니다. stdio 업스트림은 푸시 채널이 없으므로 알림을 큐에 쌓았다가 다음 응답에 함께 보냅니다.
- **`subscriptions/listen`은 HTTP 업스트림에서 브리지됩니다.** 무상태 업스트림에는 POST 스트림 패스스루이고, 레거시 업스트림에는 shim이 세션 GET 스트림을 열어 이벤트를 파이프합니다. 서버 시작 스트림이 없는 업스트림(GET이 SSE가 아닌 레거시 서버, 모든 `--upstream-stdio`)은 여전히 `501`을 반환합니다.
- **MRTR은 통과시키되 시뮬레이션하지 않습니다 — 이것이 정의된 범위입니다.** 변환 범위는 전송 계층 중계까지입니다: `input_required` 결과와 `inputRequests`는 어떤 시대의 클라이언트든 그대로 도달하고, `inputResponses`를 담은 재시도도 손대지 않고 전달합니다. `inputRequests`를 레거시 `sampling/createMessage`·`elicitation/create` 호출로 바꾸는 일은 shim이 유지하지 않는 서버→클라이언트 요청 채널을 필요로 하므로 범위 밖입니다.
- **인증 플로 없음.** DCR/CIMD/OAuth는 구현되지 않았습니다. 프로브와 shim이 보내야 할 자격 증명은 `--header`로 붙이세요.
- **정적 규칙은 휴리스틱입니다.** 파일 수준 패턴 검사이지 타입을 아는 전체 분석이 아닙니다. 진실은 라이브 프로브에 있습니다. 의도적인 레거시 코드를 위한 `mcp-dual:ignore` 마커가 있습니다.
- **codemod 자동 수정은 보수적입니다.** 세션 저장소를 지우거나 `server/discover` 핸들러를 대신 만들어주지 않습니다 — 그런 것은 TODO가 됩니다.
- **Python/Go/Rust 서버**는 `check`(HTTP/stdio)로만 다룰 수 있고 codemod로는 다루지 않습니다.

---

## 개발

```bash
npm install
npm run typecheck
npm test          # 빌드 후 25개 테스트 실행
npm run build
```

테스트 범위:

- 규칙 스캐너 픽스처 (레거시 서버와 이미 현대화된 서버);
- **엄격한 목 무상태 서버**와 **레거시 세션 서버**를 상대로 한 라이브 HTTP 프로브;
- 목 현대/레거시 stdio 서버를 상대로 한 stdio 프로브;
- 네 방향 모두의 shim 왕복 (HTTP와 stdio에서 레거시↔현대), 세션 브리지, 405 GET, 알 수 없는 세션, DELETE 포함;
- codemod의 resultType/캐시 힌트 삽입, TODO 배치, SSE import 재작성, 멱등성, `--write`;
- CLI 엔드투엔드 (`--version`, 정적 JSON, 라이브 Markdown, codemod diff).

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

## 라이선스

MIT © 2026 Inkwon Jung
