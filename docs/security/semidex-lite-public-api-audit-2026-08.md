# Semidex Lite — Public API Security Audit (2026-08)

Status: **living document.** Originally an audit-only pass (2026-08-17/18,
no mitigations implemented). Multiple mitigation phases have shipped since
and are layered in as dated `STATUS:` annotations under the finding they
correct (§7) and as dated `## 12x` sections; §12j (2026-08-21) is the most
recent. **Read a finding's own `STATUS` line, not just its original prose,
for what is actually true today** — §1 below separates the original,
as-audited claim from the current state explicitly, and the same applies
throughout §7.

Scope: the HTTP API surface shipped by Semidex Lite (`packages/lite/`), and
the shared router/route code it composes from `src/shared/`, `src/core/`,
`src/cloud/`, and `src/admin/`. Every claim below is traced to a specific
file and line, or to a characterization test added alongside this document
under `tests/unit/security/`.

## 1. Executive summary

**As originally audited (2026-08-17/18):** Semidex Lite's HTTP API had **no
authentication, no authorization, no rate limiting, and no Origin/CSRF
enforcement** of any kind. (It also set no CORS headers — but that *absence*
blocked cross-origin attackers from reading responses, so it was not itself
a weakness; the gap was the missing server-side Origin check on
state-changing routes. See P1-1, which is deliberately scoped to that
distinction.) This was a documented, deliberate MVP decision
(`src/shared/admin/register-neutral-routes.js:18-19`: *"JSON-only,
localhost-only by default, no CORS, no auth (the loopback bind IS the auth
boundary for MVP)"*), not an oversight — but the loopback bind was a weaker
boundary than the comment implied, for three reasons this audit confirmed in
code: (1) the bind address was a single env var (`ADMIN_ALLOW_REMOTE=1`) away
from being exposed to a LAN or the internet with zero other change; (2) even
while bound to loopback, the server had no Host-header or Origin check, so it
could not distinguish a legitimate same-machine client from a malicious
same-machine *browser tab* running attacker JavaScript against
`127.0.0.1:8642`, or from a DNS-rebinding attack; (3) once *anything* sat in
front of it as a reverse proxy — the exact "Lite behind your own backend"
deployment the product is designed for — the loopback boundary disappeared
entirely and nothing inside Semidex Lite itself re-established a trust
boundary.

**Current state (updated 2026-08-21 — every line below has a corresponding
dated `STATUS` note in §7 or a `## 12x` section; read those for exact scope
and proof):**

| Original gap | Current status |
|---|---|
| No Host-header / DNS-rebinding defense | 🟢 FIXED, every route — P3-1, §12b |
| No Origin/CSRF enforcement | 🟢 FIXED, every route — P1-1, §12b |
| No authentication anywhere | 🟡 FIXED for `POST /api/v1/search`, `POST /api/v1/ask`, `POST /api/v2/ask` only (bearer keys, §12n); the Admin surface (settings, jobs, collections incl. `DELETE`, `POST /api/search`, schema sync, Qdrant Cloud probe, static UI) remains exactly as originally audited — no authentication at all, by design — P1-1 residual, §12d, §12e, §12n |
| No collection scoping | 🟡 FIXED for Search v1/Ask v1/v2 only (per-key `collections` scope, §12n); every Admin read/write route still performs zero collection-level scoping — P1-2 STATUS |
| No rate limiting anywhere | 🟡 FIXED for Search v1/Ask v1/v2 only (per-key token bucket, shared across all three — §12n — **and**, for Ask specifically, a per-request/per-key spend-token-budget ceiling, §12m); the Admin surface, including `POST /api/search`, still has no rate limit of any kind — P2-1 STATUS |
| Unscoped local filesystem indexing | 🟢 FIXED, `INDEX_ALLOWED_ROOTS` fail-closed — P1-3 |
| `settings.json` default OS permissions | 🟢 FIXED on POSIX (0o600, fail-closed pre-rename); Windows unaddressed by design — P2-2 STATUS |
| No security response headers | 🟢 FIXED, every response, Full and Lite — §12h |

The takeaway has not changed in kind, only in scope: the risk is still
concentrated in **the absence of any caller-identity concept on the Admin
surface** — that surface is unauthenticated, unscoped, and unrate-limited
today exactly as it was at the original audit, protected only by the
loopback bind plus the Host/Origin checks. The Integration surface (Ask v1/
v2) is the one part of the original blanket claim that is now substantially
closed.

Within both models, the API is otherwise carefully engineered:
request bodies are strictly validated (unknown-field rejection throughout),
secrets are never echoed back by the Settings API, error messages are
redacted before crossing the process boundary, Ask generation is
single-flight-gated, and the Full/Lite composition split is real and
verified — Full-only local-runtime routes (ONNX, Ollama) do not leak into
the Lite build.

## 2. Scope and non-goals

**In scope:** every HTTP route reachable through `createLiteApp()`
(`src/admin/composition/lite.js`) and, for comparison, `createApp()`
(`src/admin/server-full.js`); the shared router (`src/shared/admin/router.js`);
the HTTP/SSE primitives (`src/core/http/http.js`, `src/core/http/sse.js`);
the Settings API and its Lite allow-list; the job registry and indexer
spawn path; the Ask v1/v2 APIs; CORS/Origin/Host handling; static UI
serving.

**Out of scope (not audited here):** OCR/vision code (excluded per task
constraints); the MCP server (`src/mcp/`) — a separate transport with its
own trust model; the Admin UI's client-side JavaScript beyond what's needed
to confirm server-side enforcement; supply-chain/dependency vulnerabilities;
Qdrant Cloud's and Gemini's own server-side security posture (both are
treated as trusted third parties whose credentials Semidex holds, not audit
targets in their own right).

**Non-goals of this document:** no auth/rate-limiting/mitigation is
implemented here. No production code is modified. No live Qdrant/Gemini
calls were made — every claim is either a direct code trace or a
characterization test run against fakes/stubs.

## 3. Deployment assumptions

Semidex Lite is designed to run as: (a) a local CLI + admin dashboard for a
single trusted operator, (b) an embedded backend component behind another
application's own server, or (c) — undocumented as a *supported* mode, but
technically possible with one env var — directly exposed to a network. The
codebase's actual default (`ADMIN_HOST=127.0.0.1`, refused unless
`ADMIN_ALLOW_REMOTE=1` — `src/shared/admin/server.js:20-29`) matches
scenario (a)/(b). This audit evaluates all five scenarios explicitly in
§6.

## 4. Full API inventory

32 routes total: 30 registered with a literal path string plus
`POST /api/v1/ask` / `POST /api/v2/ask` (registered via the `ASK_PATH`
constant in `src/core/ask-api/v{1,2}/contract.js`). Verified by reading
`src/shared/admin/register-neutral-routes.js`, `src/admin/server-full.js`,
`src/admin/composition/lite.js`, and every file under
`src/shared/admin/api/`, `src/core/ask-api/`, `src/cloud/admin/`,
`src/local/admin/api/`.

Legend — **Composition:** Shared (both Full and Lite) / Full-only / Lite-N/A.
**Expensive:** network round-trip to Qdrant/Gemini, subprocess spawn, or
unbounded response size.

| Method + path | Composition | Purpose | R/W | Inputs | External calls | Expensive? | Current protection | Exposure |
|---|---|---|---|---|---|---|---|---|
| `GET /api/health` | Shared | Storage ping | R | none | Qdrant | No | Redacts QDRANT_KEY from failure detail (`api/health.js:16-18`) | loopback default |
| `GET /api/capabilities` | Shared | Adapter capability flags | R | none | none | No | none needed (static) | loopback default |
| `GET /api/collections` | Shared | List collections | R | none | Qdrant | Yes (Qdrant list) | none | loopback default |
| `GET /api/collections/:name` | Shared | Collection detail | R | path param | Qdrant | No | 404 on missing | loopback default |
| `POST /api/collections/:name/sync-schema` | Shared | Repair/create Qdrant schema | W | path param | Qdrant | Yes (multiple Qdrant round-trips) | 404 on missing; tracked via taskRegistry | loopback default |
| `DELETE /api/collections/:name` | Shared | **Destructive** — delete collection | W | path param | Qdrant | Yes | 404 on missing; **no confirmation token** — explicitly documented as a UI-level concern only (`collections.js:62-66`) | loopback default |
| `GET /api/collections/:name/documents` | Shared | List source docs | R | path param, query (`prefix`,`limit`) | Qdrant | Possibly (limit≤1000) | `limit` clamped 1–1000 (`query-params.js`) | loopback default |
| `GET /api/collections/:name/chunks` | Shared | Chunk / windowed chunk read | R | path param, query | Qdrant | No (window≤5) | window clamped 0–5, rejects out-of-range | loopback default |
| `GET /api/collections/:name/assembly` | Shared | Assembled document/section | R | path param, query | Qdrant | Yes (assembles full doc) | scope enum-checked; 404 on missing scope target | loopback default |
| `GET /api/collections/:name/node` | Shared | Structural content node | R | path param, query | Qdrant | No | `requireExactlyOne` | loopback default |
| `GET /api/collections/:name/skeleton` | Shared | Skeleton root | R | path param | Qdrant | No | 404 on missing collection | loopback default |
| `GET /api/collections/:name/skeleton/node` | Shared | Skeleton node | R | path param, query | Qdrant | No | `requireExactlyOne` | loopback default |
| `GET /api/collections/:name/skeleton/children` | Shared | Skeleton children | R | path param, query | Qdrant | No | limit clamped 1–500 | loopback default |
| `GET /api/collections/:name/skeleton/anchor` | Shared | Section anchor chunk | R | path param, query | Qdrant | No | `requireExactlyOne` | loopback default |
| `POST /api/search` | Shared | Hybrid search | R | body (`collection`,`query`,`top`≤20,`window`≤5,`tags`) | Qdrant, embedding provider | Yes (embed + Qdrant query) | full body validation; top/window bounded | loopback default |
| `POST /api/v1/ask` | Shared | Stateless grounded Ask (SSE) | R (generation) | body (`collection`,`question`,`scope.sourceFile`) | Qdrant, Gemini | **Yes** — LLM generation, streamed | single-flight busy lock (429) shared across v1/v2 (`core/ask/coordinator.js`); redacts secrets from all error paths | loopback default |
| `POST /api/v2/ask` | Shared | Multi-turn Ask (SSE, caller-owned history) | R (generation) | body (`collection`,`question`,`conversation`) | Qdrant, Gemini | **Yes** | same busy lock; fixed protocol ceilings: 200 messages, 50k chars/message, 8k-char summary (`ask-api/v2/request.js:41-44`) | loopback default |
| `GET /api/generation/status` | Shared | Provider readiness | R | none | none (cached readiness) | No | redacts secrets from `reason` | loopback default |
| `GET /api/generation/models` | Shared (Gemini-only in Lite) | Model discovery | R | query (`backend`) | Gemini (or Ollama in Full) | Yes (external API call) | redacts API key from `reason`; never echoes key on success | loopback default |
| `GET /api/jobs` | Shared | List indexing jobs | R | none | none (in-memory) | No | none needed | loopback default |
| `GET /api/jobs/:id` | Shared | Job detail incl. log | R | path param | none | No | log capped at 200 lines in response, 2000 in memory; **redacted at capture time** (`registry.js:73-77,111`) | loopback default |
| `POST /api/jobs/index` | Shared | **Start indexing job → spawns subprocess** | W | body (`collection`,`path`,`options`,`kind`) | filesystem (via spawned indexer), then Qdrant | **Yes** — spawns `node index-{lite,full}.js` | single global job slot (409 if busy); fail-closed `INDEX_ALLOWED_ROOTS` realpath/containment guard runs before job creation (see Finding P1-3) | loopback default |
| `POST /api/jobs/:id/cancel` | Shared | Cancel job | W | path param | signals child process | No | 404 on missing job | loopback default |
| `GET /api/operations` | Shared | Merged job+task view | R | none | none | No | none needed | loopback default |
| `GET /api/operations/:id` | Shared | Merged detail | R | path param | none | No | 404 on missing | loopback default |
| `GET /api/settings` | Shared (Lite: allow-list filtered) | Read all settings | R | none | none | No | secrets never return raw value, only `configured:boolean` (verified — §7 confirmed-safe) | loopback default |
| `PATCH /api/settings` | Shared (Lite: allow-list filtered, hard-pinned keys rejected) | Write settings | W | body `{changes}` | none (writes settings.json) | No | all-or-nothing validation; `not_writable`/`invalid_value`/`setting_overridden` typed errors; Lite additionally rejects any key outside `LITE_SETTINGS_KEY_SET` (`service.lite.js:49-52`) | loopback default |
| `POST /api/system/pick-folder` | Shared | OS folder-picker dialog | R | none | spawns OS dialog process (Full/Lite both) | Yes (subprocess) | platform-specific error mapping | loopback default |
| `GET /api/system/ollama-status` | **Full-only** | Ollama reachability | R | none | Ollama (local) | Yes | n/a to Lite — confirmed unmounted (see Finding-verification below) | loopback default (Full) |
| `GET /api/ollama-models` | **Full-only** | Ollama model discovery | R | query | Ollama (local) | Yes | n/a to Lite — confirmed unmounted | loopback default (Full) |
| `POST /api/system/onnx-probe` | **Full-only** | ONNX CUDA/DML/CPU probe | R | body | spawns child process | Yes | n/a to Lite — confirmed unmounted | loopback default (Full) |
| `GET /api/system/onnx-managed-runtimes` | **Full-only** | ONNX managed runtime listing | R | none | filesystem | No | n/a to Lite — confirmed unmounted | loopback default (Full) |
| `POST /api/system/qdrant-cloud-probe` | Shared | Explicit Qdrant Cloud Inference test | R | body (`denseModel`,`sparseModel`) | Qdrant Cloud Inference | Yes (real embedding round-trip) | dense/sparse model validated against catalog; secrets redacted (`qdrant-cloud-api.js:9-11`) | loopback default |
| Static UI (`GET /*` non-`/api`) | Shared | Serve built dashboard | R | path | filesystem (`dist/admin-ui/`) | No | traversal guard (`static.js:32-38`, normalize + prefix check), extension allow-list, GET/HEAD-only | loopback default |

### Full-vs-Lite route parity — verified, not assumed

Traced `src/admin/composition/lite.js` against `src/admin/server-full.js`
line by line. `createApp()` (Full) imports and calls three functions
`createLiteApp()` never imports at all:
`registerOllamaStatusRoutes` (`server-full.js:20,179`),
`registerOnnxRoutes` (`server-full.js:21,184-191`), and
`registerOllamaModelsRoutes` (`server-full.js:22,158`). `createLiteApp()`
has zero import lines referencing `local/admin/api/onnx.js`,
`local/admin/system/ollama.js`, or `local/core/ollama-models.js` — confirmed
by reading the full import list at the top of
`src/admin/composition/lite.js` (lines 20-35). This is a structural
guarantee (the routes literally cannot be registered without an import that
doesn't exist), not just an untested assumption — and it is now also a
**passing behavioral test**:
`tests/unit/security/lite-full-route-parity.test.js` boots a real
`createLiteApp()` instance and asserts all four Full-only routes 404, that
`backend=ollama` on the shared `/api/generation/models` route returns a
clean 400 (not a 500 from a missing dependency), and that
`options.llmSummaries` is rejected by `LITE_JOB_POLICY` before any
Ollama-availability check is attempted. Pre-existing coverage
(`tests/unit/lite/serve-lite.test.js:96-110`) already checked two of these
four routes through the full `startLite()` CLI-bootstrap path; the new test
widens this to all four Full-only routes and checks it at the lower-level
`createLiteApp()` composition boundary directly.

**Verdict: confirmed — no Full-only route ships in the Lite composition.**

## 5. Trust-boundary diagram

```mermaid
flowchart TB
    subgraph untrusted["Untrusted zone"]
        browser["Browser tab<br/>(could be running attacker JS<br/>if user has another tab open)"]
        thirdparty["Third-party client<br/>(if exposed beyond loopback)"]
    end

    subgraph wrapper["Optional: wrapper backend / reverse proxy<br/>(NOT part of Semidex — deployer-supplied)"]
        proxy["Reverse proxy / app backend<br/>*** should own auth, rate limiting, CORS ***"]
    end

    subgraph semidex["Semidex Lite process — TRUST BOUNDARY STARTS HERE"]
        direction TB
        httpserver["node:http server<br/>(register-neutral-routes.js)<br/>NO AUTH, NO ORIGIN CHECK, NO RATE LIMIT"]
        router["Router<br/>(shared/admin/router.js)"]
        settingsapi["Settings API<br/>GET/PATCH /api/settings<br/>[holds QDRANT_KEY, GEMINI_API_KEY]"]
        jobsapi["Jobs API<br/>POST /api/jobs/index<br/>*** spawns subprocess, reads local FS ***"]
        askapi["Ask v1/v2 API<br/>*** triggers billed Gemini calls ***"]
        searchapi["Search / Collections / Chunks / Skeleton APIs<br/>[read Qdrant data]"]
    end

    subgraph localfs["Local filesystem"]
        settingsjson["settings.json<br/>[plaintext, no restrictive file perms set]"]
        indexed["Arbitrary indexed source path<br/>*** validated only against URL-scheme,<br/>no traversal/scope guard ***"]
    end

    subgraph qdrant["Qdrant Cloud"]
        qcoll["Collections<br/>[shared trust: NO per-collection<br/>caller allow-list in Semidex]"]
    end

    subgraph gemini["Gemini API"]
        gmodel["Generation + model discovery<br/>[billed per Ask call]"]
    end

    browser -- "browser-simple requests EXECUTE<br/>cross-origin (no Origin check);<br/>response unreadable (no ACAO).<br/>DELETE/PATCH/JSON blocked by<br/>unanswered OPTIONS preflight" --> httpserver
    thirdparty -- "if ADMIN_ALLOW_REMOTE=1<br/>or behind misconfigured proxy" --> httpserver
    browser -.->|"normally blocked by<br/>proxy's own auth, IF proxy adds one"| proxy
    proxy --> httpserver

    httpserver --> router
    router --> settingsapi
    router --> jobsapi
    router --> askapi
    router --> searchapi

    settingsapi -- "credentials read/written<br/>[QDRANT_KEY never echoed;<br/>GEMINI_API_KEY never echoed]" --> settingsjson
    jobsapi -- "state-changing: spawn child_process<br/>+ write to Qdrant" --> indexed
    jobsapi -- "writes new points" --> qcoll
    askapi -- "state-changing: billed generation call" --> gmodel
    askapi -- "reads any existing<br/>collection name supplied<br/>by the caller" --> qcoll
    searchapi -- "reads" --> qcoll

    classDef credentials fill:#7c2d12,color:#fff,stroke:#431407
    classDef stateChange fill:#7f1d1d,color:#fff,stroke:#450a0a
    classDef boundary fill:#1e3a5f,color:#fff,stroke:#0f1f33
    class settingsjson,settingsapi credentials
    class jobsapi,askapi,indexed,gmodel stateChange
    class semidex boundary
```

## 6. Deployment scenarios

**1. Loopback, single trusted user (documented default).**
Trusted: whoever can reach `127.0.0.1:8642` on the machine — in practice
any local process or browser tab, since loopback is not per-user isolated
on a shared machine. Collection control: whoever runs the CLI/opens the
dashboard. Indexing trigger: same. Credentials: `QDRANT_KEY`/`GEMINI_API_KEY`
live in `.env`/`settings.json` under `SEMIDEX_HOME`, readable by any local
process running as the same OS user (no file-permission hardening observed
— `settings-store.js:29-33` uses plain `writeFileSync`, no `mode` option).
Cross-user isolation: none — this scenario doesn't claim it. **Verdict:
officially safe as-is** for a genuinely single-user, single-OS-account
machine; the caveat above (no file-mode hardening, no same-machine
browser-tab defense) should be disclosed, not silently assumed away.

**2. Lite behind the user's own backend (the product's primary intended
integration path).** Trusted: the wrapper backend, which owns end-user
auth. Collection control / indexing trigger: whoever the wrapper backend
lets call through — Semidex itself enforces nothing here since it has no
caller-identity concept. Credentials: live in Semidex's own env, never
touch the wrapper backend directly (good separation) — but the wrapper
backend has *unrestricted* access to every Semidex route including
`DELETE /api/collections/:name`, `PATCH /api/settings` (which can rewrite
`QDRANT_URL`/`QDRANT_KEY`), and unlimited-rate Ask calls. Cross-user
isolation: entirely the wrapper's responsibility; Semidex provides zero
help (no collection allow-list, no per-caller scoping). **Verdict:
officially safe as-is ONLY if the wrapper backend treats every Semidex
route as equally dangerous and fully mediates access** — this is not
enforced or even checked by Semidex, so it is a documentation
responsibility, not a built-in guarantee. The README's Ask v2 section
already does this well for Ask specifically (§9 below); the same rigor is
absent for the admin/indexing/settings routes.

**3. Lite exposed directly to a LAN.** Requires `ADMIN_ALLOW_REMOTE=1` —
one line. Trusted: nothing beyond "the LAN administrator trusts everyone on
this LAN," which is rarely actually true (guest Wi-Fi, IoT-compromised
devices, BYOD). No auth means every device on the LAN can read/write
settings, delete collections, spawn indexing jobs against arbitrary local
paths, and drive unlimited Gemini-billed Ask calls. **Verdict: must be
explicitly disallowed/marked unsupported** — the current codebase makes
this one env var away from "on" with no additional warning at request time
(only a startup-time refusal without the flag — `server.js:23-28` — no
runtime nag once the flag is set).

**4. Lite exposed directly or via reverse proxy to the internet.** Same as
#3 but with a global attacker population instead of a LAN's. A
misconfigured reverse proxy (e.g. one that doesn't strip/validate Origin,
or that forwards all methods) inherits every gap in this document with no
additional mitigation from Semidex's side — no CORS, no rate limit, no
body-size-aware DoS protection beyond the generic 1MB JSON cap
(`http.js:62`, `readJsonBody`'s `maxBytes` default) and Ask's own
single-flight lock (which throttles *concurrency* to 1, not *rate* — an
attacker can still fire requests as fast as each 429 returns). **Verdict:
must be explicitly disallowed/marked unsupported** until auth + rate
limiting ship.

**5. One instance serving multiple users/assistants (multi-tenant).**
This is the scenario the "collection allow-list" and "API keys/scopes"
questions in §10 exist to answer, and today's answer is: **not supported,
full stop.** There is no concept of a caller identity anywhere in the
request path — `collection` is a bare string checked only for existence
in Qdrant (confirmed: `tests/unit/security/ask-api-collection-allowlist.test.js`
proves `parseAskRequestV1`/`V2` accept any non-empty string, including one
shaped like another tenant's private collection name, and that the v1
route passes it straight to the coordinator with no gate in between). Any
caller who can reach the API and can guess or enumerate a collection name
can read it via Ask/search and, if also allowed to POST, can index into it
or delete it. **Verdict: must be explicitly disallowed/marked unsupported**
until a real caller-identity + collection-scoping layer exists — this is
the single decision every other finding in this document ultimately routes
back to.

## 7. Findings by severity

### P0 — none confirmed as directly, remotely exploitable with zero
configuration change. (The "P0-shaped" risks — full compromise via LAN/
internet exposure — all require the operator to first set
`ADMIN_ALLOW_REMOTE=1` or add a permissive reverse proxy; see P1-1 for why
that boundary is thinner than it looks even without doing so.)

### P1-1 — No Origin/CSRF enforcement on state-changing routes; loopback
bind does not defend against a same-machine malicious browser tab.

**Framing note (important — this finding is deliberately narrower than
"no CORS").** The absence of CORS headers is *not itself* the vulnerability.
Because no `Access-Control-Allow-Origin` header is ever emitted, a
cross-origin attacker page **cannot read any response** from this API — the
browser blocks it. Absence of ACAO is, for confidentiality, working *in
Semidex's favour* today. The actual gap is the **absence of any server-side
Origin / `Sec-Fetch-Site` / CSRF-token check on state-changing routes**: for
the subset of requests a browser will send cross-origin *without* a
preflight, the request still **executes** server-side before the response
read-block is relevant. This is a write-side (integrity) risk, not a
read-side (confidentiality) one.

> **CORRECTION (2026-08-18).** An earlier revision of this finding claimed
> that JSON-bodied POST routes were only a "near miss" because a
> `text/plain` request would die at `readJsonBody()`'s parse step. **That was
> wrong.** `readJsonBody()` (`src/core/http/http.js`) never inspected
> `Content-Type` at all — it read the bytes and called `JSON.parse()` on
> whatever arrived. A CORS-simple request declaring `Content-Type:
> text/plain` with a body that *is* valid JSON therefore parsed perfectly and
> executed the route in full. This was confirmed live, not reasoned about:
> a cross-origin `POST /api/jobs/index` with `Origin:
> https://attacker.example`, `Content-Type: text/plain` and a valid JSON body
> returned **HTTP 202 and really spawned an indexer subprocess against an
> arbitrary local path**. The corrected classification is below.

**Which routes were actually reachable this way — two distinct classes.**
The split is determined by whether a browser sends a CORS preflight. A
preflight is fatal to the attacker here because *nothing answers `OPTIONS`*
(the router registers no `OPTIONS` handler — it 404s/403s, which fails the
preflight so the real request is never sent). Crucially, the JSON body was
**not** a barrier before the fix, because Content-Type was unenforced:

| Class | Shape | Cross-origin executable *before* the fix? | Routes in this API |
|---|---|---|---|
| **Browser-simple** | `POST` with `Content-Type: text/plain`, `application/x-www-form-urlencoded`, or `multipart/form-data`; no custom headers. Body may be valid JSON — it was parsed regardless of the declared type. | **Yes — fully, including the JSON-bodied routes** | `POST /api/jobs/index` (**confirmed: 202 + real subprocess spawn against an arbitrary local path**), `POST /api/search`, `POST /api/v1/ask`, `POST /api/v2/ask`, `POST /api/system/qdrant-cloud-probe`, `POST /api/collections/:name/sync-schema`, `POST /api/jobs/:id/cancel`, `POST /api/system/pick-folder` |
| **Preflight-protected** | `DELETE`/`PATCH` methods, or any request carrying a custom header (e.g. `X-Semidex-Request`) | **No** — the browser must preflight; the preflight is unanswered, so the real request is never dispatched | `DELETE /api/collections/:name`, `PATCH /api/settings` |

Note what moved between classes in this correction: declaring
`Content-Type: application/json` *does* force a preflight, but an attacker
simply would not declare it — they would send `text/plain` and let the
server parse the JSON anyway. So the "JSON-bodied form is protected" claim
protected nothing; only the *method* (`DELETE`/`PATCH`) and *custom headers*
genuinely forced a preflight.

**Corrected impact.** The confirmed cross-origin-executable set included
every consequential POST route:
- **Arbitrary local filesystem indexing** (`POST /api/jobs/index`) — an
  attacker page could cause the operator's own machine to index any
  locally-readable path into a collection. Combined with the absence of an
  allowed-roots restriction (P1-3), this is local data exposure, not merely
  unwanted work.
- **Paid/upstream resource consumption** (`/api/v1/ask`, `/api/v2/ask`,
  `/api/search`, `/api/system/qdrant-cloud-probe`) — billed Gemini
  generation and Qdrant Cloud inference triggered by a third-party page,
  with no rate limit in front of it (OWASP API4, Unrestricted Resource
  Consumption).
- **State changes** — schema sync, job cancellation, and an OS folder-picker
  dialog spawned on the operator's desktop.

Response unreadability (no `Access-Control-Allow-Origin`) mitigated **none**
of this: it prevented the attacker from *reading* results, while every
side effect still occurred. `DELETE /api/collections/:name` and
`PATCH /api/settings` remained protected, but only incidentally, by the
unanswered preflight.

**File:line:** `src/core/http/http.js:8-9` (explicit "no CORS headers"
comment); `src/shared/admin/register-neutral-routes.js:18-19` (design
rationale); `src/shared/admin/router.js` (no `OPTIONS` registration — the
incidental preflight protection); confirmed empirically in
`tests/unit/security/cors-headers.test.js` and
`tests/unit/security/csrf-state-changing-routes.test.js`.

**Exploitation conditions:** the operator's browser can reach Semidex
Lite's origin (true by default) AND the operator visits an
attacker-controlled page in the same browser AND the targeted route is in
the **browser-simple** class above. The attacker must also know/guess the
port — a weak barrier, since `8642` is the documented default.

**Impact:** blind, unauthenticated triggering of the browser-simple
state-changing routes: forced Qdrant schema sync, cancellation of an
in-flight indexing job, and an OS-level folder-picker dialog spawned on the
operator's desktop. No data is readable by the attacker. No collection
deletion and no settings write is achievable through this vector.

**Existing mitigations (pre-fix):** no *intentional* server-side mitigation.
Two incidental ones: (1) absent ACAO blocked response reads — which stopped
disclosure but no side effect; (2) absent `OPTIONS` handling failed
preflights, protecting only `DELETE`/`PATCH`. Neither was a deliberate
control, and both would silently disappear the moment permissive CORS were
added naively — precisely the risk of "fixing" this by adding CORS first.

**Proof:** `tests/unit/security/csrf-state-changing-routes.test.js` and
`tests/unit/security/request-security-policy.test.js` (47 tests between
them). The pre-fix vulnerability was additionally confirmed by direct live
reproduction against a real `createLiteApp()` server: cross-origin
`text/plain` + valid JSON → `POST /api/jobs/index` → **202, indexer spawned
with `args[0]` = the attacker-chosen path**.

### STATUS: FIXED in Phase 1 (2026-08-18)

Two independent layers now close this, deliberately kept separate because
they fail differently:

1. **Origin / Fetch-Metadata enforcement before dispatch** —
   `src/core/http/request-security.js`, called from
   `src/shared/admin/router.js`'s `handleRequest()` ahead of route matching
   and ahead of any body read. `Sec-Fetch-Site: cross-site` / `same-site` is
   rejected; a non-matching or `null` `Origin` is rejected; requests with
   neither header (curl, server-to-server) are allowed, so documented
   integrations keep working.
2. **Content-Type enforcement** — `readJsonBody()` now returns 415 unless the
   request declares `application/json` (charset parameter and `+json` suffix
   allowed). This removes the smuggling shape itself: a CORS-simple content
   type can no longer deliver a parsed JSON payload.

Neither layer is authentication, and this finding is **not** fully retired by
them: they stop *browser* cross-site requests, not a malicious local process
or any non-browser client, which remain unauthenticated. See §10 for the
sequencing that must precede a real credential.

**Remaining fix direction:** unchanged — full authentication is still
required, and CORS must never be introduced as the control (CORS governs
response *readability*, not request *execution*; OWASP's CSRF guidance is
explicit that CORS is not a CSRF defense). `OPTIONS` is deliberately left
unanswered so the incidental preflight protection survives.

### P1-2 — No collection scoping; required before any multi-user or
API-key mode, not a breach of the current single-user contract.

**Contract framing (important).** Semidex Lite's shipped contract today is
explicitly single-tenant and single-operator: one process, one set of
Qdrant credentials, one trusted local user. Under *that* contract, an
unconstrained `collection` parameter is **not a vulnerability** — the caller
is already the owner of every collection the configured credentials can
reach, so there is no privilege for scoping to protect. This finding is
therefore recorded as a **forward-looking security requirement**, not as a
present-tense violation: the moment any of §6's scenarios 2-5 is officially
supported (a wrapper backend serving multiple end-users, an API-key mode, or
one instance serving several assistants), the absence of scoping becomes a
genuine cross-tenant authorization flaw. It is P1 because it is a hard
blocker on those modes, and because retrofitting scoping after an API-key
layer ships is materially harder than designing them together.

**Reachable path:** `POST /api/v1/ask`, `POST /api/v2/ask`,
`POST /api/search`, and every `GET /api/collections/:name/*` route accept
`collection`/`:name` as an unconstrained string, checked only for
existence via `adapter.getCollection()`. There is no concept anywhere in
the codebase of "which collections is this caller allowed to touch" — no
setting, no header, no per-request scoping. Confirmed by reading
`src/core/ask-api/v1/request.js` (only checks non-empty string),
`src/core/ask-api/v2/request.js` (same), and by grepping
`src/core/settings/definitions.js` / `lite-policy.js` for any
allow-list-shaped setting (none exists).

**File:line:** `src/core/ask-api/v1/request.js:48-50`;
`src/core/ask-api/v2/request.js:143-145`;
`src/core/ask-api/v1/route.js:93-94` (existence check only, no ownership
check).

**Exploitation conditions:** requires the single-tenant contract to have
been left behind — i.e. more than one party's data lives in the same Qdrant
project/instance Semidex Lite is configured against, AND more than one
party can reach the API (scenarios 2-5 in §6), AND the caller can name or
enumerate a collection. Under scenario 1 (the supported default) these
conditions cannot be met, and there is no finding.

**Impact (conditional on the above):** cross-tenant data disclosure via
Ask/search, and — for a caller who can also reach the write routes —
cross-tenant modification/deletion.

**Existing mitigations:** none needed under the current contract; none
available for any broader one. The single-tenant assumption is real and
consistent, but it is *assumed*, never *enforced* — nothing in the code
would resist a multi-tenant deployment, and nothing warns the operator that
they have left the supported model.

**Proof:** `tests/unit/security/ask-api-collection-allowlist.test.js` (4
tests, all passing) proves `parseAskRequestV1`/`V2` accept an arbitrary
collection string with no format/allow-list constraint, and that the v1
route forwards it to the coordinator unfiltered.

**Recommended fix direction:** an explicit, opt-in collection allow-list
setting (server-side, not client-suppliable) is the minimum viable fix for
scenario 5; a real per-caller scoping model (API keys with collection
scopes, mirroring Qdrant Cloud's own granular-access-key model — see §11
sources) is the complete fix.

### STATUS: PARTIALLY FIXED (2026-08-18) — Integration surface only

§12e's bearer-key implementation closes this for `POST /api/v1/ask` and
`POST /api/v2/ask` — the only two routes classified `audience: integration`
(§12d). Every key carries an explicit `collections` scope (`"*"` must be
written out, never implied by an empty list — see §12e), enforced by
`authorizeCollection` at router stage 2, after the body is parsed and before
`adapter.getCollection()` is called. An out-of-scope collection and a
nonexistent one are indistinguishable from outside, so this closes the
enumeration/disclosure risk this finding describes, for Ask specifically.

**Not closed by this:** `POST /api/search` and every
`GET /api/collections/:name/*` read route remain classified
`audience: admin` (§12d's own inventory — `/api/search` is deliberately
Admin, being the dashboard's own unversioned internal endpoint). Admin
routes never invoke the integration policy at all, so these routes perform
exactly zero collection-level scoping today — the same absence this finding
originally described, just narrowed to a smaller route set. Under the
single-trusted-operator contract (§6 scenario 1) this is correct, not a
regression; it becomes a real gap the moment any of §6 scenarios 2-5 apply
to a caller reaching these specific routes. The optional global
allow-list mentioned in the original recommended fix direction (defense in
depth beyond per-key scopes) has not been added.

**Proof:** `tests/unit/security/integration-audience-scoping.test.js` and
`tests/unit/security/collection-authorization.test.js` (per-key scope
enforcement); `tests/unit/security/ask-api-collection-allowlist.test.js`
still passes unmodified and still proves what it always proved — that
`parseAskRequestV1`/`V2` themselves place no scope constraint on
`collection` — but that parse-level absence is no longer the whole story:
its second describe block constructs a router via `createRouter()` with
**no** `integrationPolicy` supplied, which is what actually produces the
unscoped pass-through it demonstrates. `createApp()`/`createLiteApp()`
resolve a real, scope-enforcing policy by default in production
(`core/auth/resolve-policy.js`) — a caller that wants scoping bypassed has to
deliberately omit it, as this one test does, not merely reach the route.

### P1-3 — Unscoped local filesystem indexing

### STATUS: FIXED (2026-08-19)

`POST /api/jobs/index` is now fail-closed behind `INDEX_ALLOWED_ROOTS` in
both Full and Lite. No configured valid roots means HTTP/dashboard indexing
returns 403 before registry, subprocess, Ollama, Qdrant, or other external
work. Direct trusted CLI indexing remains outside this HTTP boundary.

**Framing note.** This is deliberately *not* labelled "path traversal."
There is no sandbox or intended root to escape from — the API's designed
behaviour is "index the local path the operator names," and under the
single-trusted-operator contract (§6 scenario 1) that is correct and not a
flaw: the operator already has full filesystem access by other means, so
the API grants no privilege they lack. The finding is that this behaviour
is **deployment-dependent**: its risk is created entirely by *who can reach
the route*, not by anything wrong in the route itself.

> **CORRECTION (2026-08-18) — this was reachable from the browser.** The
> earlier revision treated the cross-origin route to this finding as
> hypothetical ("*if* a JSON body ever becomes deliverable cross-origin").
> It was not hypothetical: because `readJsonBody()` ignored `Content-Type`,
> a `text/plain` CORS-simple POST carrying valid JSON reached this route in
> full. Confirmed live — **202, with a real indexer subprocess spawned
> against an attacker-chosen local path**. So before Phase 1, any page the
> operator visited could make their own machine index arbitrary
> locally-readable files into a collection. That is local data exposure via
> the browser, not merely a deployment-shape risk.

Post-Phase-1 the browser vector was closed by P1-1's Origin and Content-Type
layers. The remaining non-browser gap is now closed by the allowed-roots
guard described below.

**Current path:** `POST /api/jobs/index` → `parseIndexJobRequest()` →
instance-scoped `createAllowedRootsGuard().checkTarget()` →
`registry.startIndexJob()` →
`spawnIndexer({ args: [path], env })` (both `spawn-indexer-lite.js:14-16`
and `spawn-indexer-full.js`) → `node index-{lite,full}.js <canonical-path>`.
The guard resolves configured roots and the target through `realpath`,
requires a regular file or directory, and performs component-aware
containment before the registry receives the canonical target.

**Implementation:** `src/shared/admin/jobs/allowed-roots-guard.js`,
`src/core/security/allowed-roots.js`,
`src/core/security/path-containment.js`, and the route wiring in
`src/shared/admin/api/jobs.js`.

**Pre-fix exploitation conditions:** the caller could reach `POST /api/jobs/index`
at all (any deployment scenario where the API is reachable and unauthenticated
— i.e. every scenario in §6 except a genuinely single-user loopback machine
where this is a non-issue since the user already has that FS access
anyway).

**Pre-fix impact:** in a scenario where the API caller had *less* filesystem access
than the Semidex Lite process itself (e.g. a wrapper backend running as a
different, more-privileged OS user, or a multi-tenant setup where "index
this path" is meant to be scoped to a per-tenant upload directory), this
let a caller index — and thereby exfiltrate into Qdrant, then read back
via Ask/search — any file or directory the Semidex Lite process can read,
regardless of what directory the caller was "supposed" to be limited to.
Confirmed **not** a shell-injection vector: `spawn()` is called with an
argv array (`[INDEXER_ENTRY, ...args]`), never a concatenated shell
string, and the `shell` option is never set — so metacharacters in `path`
are passed as one literal argv element, not interpreted by a shell (this
was explicitly checked against Node's own CVE-2024-27980, which requires
spawning a `.bat`/`.cmd` file; `spawnIndexer` always spawns
`process.execPath`, the Node binary itself, so that CVE class does not
apply here).

**Current guarantees:** an empty/malformed root configuration never means
unrestricted access; nonexistent, inaccessible, unsupported, broken-link,
and out-of-scope targets share a generic denial; symlink and Windows
junction escapes are rejected after canonical resolution; the folder picker
cannot widen the allow-list; changes apply immediately and guards are
instance-scoped.

**Proof:** `tests/unit/security/spawn-indexer-path-validation.test.js` and
`tests/unit/security/path-containment.test.js` cover route ordering,
canonical forwarding, POSIX/win32/UNC component semantics, malformed
configuration, real files/directories, symlink/junction escape, and
instance isolation. The registry's argv-array shape remains unchanged, so
this fix neither introduces nor relies on shell interpretation.

**Residual limitation:** this is canonical containment at check time, not a
race-proof filesystem sandbox. A co-resident actor with write access to an
allowed tree could replace an entry after validation but before the child
indexer opens it (TOCTOU). Operators must not grant untrusted writers access
to allowed roots when that threat model matters.

### P2-1 — No rate limiting anywhere; Ask's single-flight lock throttles
concurrency, not request rate.

**Reachable path:** every route. Ask specifically:
`createSingleFlightGate()` (`src/core/ask/coordinator.js:309-318`) allows
exactly one in-flight `ask()` call at a time and returns
`{status:'busy'}` → HTTP 429 for a second concurrent call — but nothing
prevents an attacker from firing a new request the instant the previous
one's 429 (or successful completion) returns, at whatever rate the network
allows.

**File:line:** `src/core/ask/coordinator.js:309-318` (single-flight gate,
concurrency not rate); no rate-limiting middleware/token-bucket exists
anywhere under `src/core/http/` or `src/shared/admin/` (confirmed by
reading both directories' full contents — no file references a request
counter, sliding window, or token bucket).

**Exploitation conditions:** API reachable at all.

**Impact:** unbounded Gemini API cost (every accepted Ask request is a
billed Gemini call, gated only by the 1-concurrent-request lock, not a
per-time-window cap); unbounded Qdrant Cloud query volume against
`POST /api/search`.

**Existing mitigations:** the single-flight lock (real, but addresses a
different problem — correctness/consistency of concurrent generation, not
cost/DoS); the 1MB JSON body cap (`http.js:62`, generic, not
Ask-specific); Ask v2's own fixed protocol ceilings (200 messages,
50k chars/message — bounds the *size* of an accepted request, not its
*rate*).

**Proof:** by absence — no test is needed to prove a negative this
structural; confirmed by exhaustive reading of `src/core/http/`,
`src/shared/admin/`, and `src/core/ask/` for any rate-limiting primitive.

**Recommended fix direction:** a token-bucket or sliding-window limiter at
the HTTP layer, tunable per-route (Ask needs a much tighter cap than
`GET /api/health`), direction only.

### STATUS: PARTIALLY FIXED (2026-08-18/19) — Integration surface only

`src/core/auth/rate-limiter.js` (instance-scoped token bucket, no
timers — refill computed on each `consume()` call, lazy idle-bucket sweep
piggybacked on real traffic) is wired into the router as **stage 1.5**:
immediately after a successful bearer-key authentication, still before the
body is read and before stage 2 (collection authorization) — so a token is
spent even by a request that later turns out malformed or out-of-scope.
Defaults: 30 requests/minute, burst 5, both overridable per key
(`semidex-lite key add --requests-per-minute/--burst`, clamped to
`[1, 6000]`/`[1, 1000]` so a typo cannot hand a key an effectively unbounded
rate). A denied request gets `429 rate_limited` with an integer
`Retry-After` in seconds. This closes the cost-exposure half of this
finding (unbounded billed Gemini/Qdrant-Cloud-Inference calls) for
`POST /api/v1/ask` and `POST /api/v2/ask` — the only `audience: integration`
routes (§12d).

**Not closed by this:** every `audience: admin` route — settings, jobs,
collections (including `DELETE`), `POST /api/search`, schema sync, the
Qdrant Cloud probe — never invokes the integration policy at all (§12d's own
design: the admin surface stays credential-free by construction), so none of
it carries any rate limit. The single-flight Ask lock (still real, still
distinct from rate limiting per the framing above) is unaffected by this
fix and remains a concurrency guarantee, not a rate one. A coarse per-caller
cap for the admin surface, as this finding's "What rate/body-size/
concurrency limits does the MVP need?" answer in §12 already called for,
remains unbuilt.

**Proof:** `tests/unit/security/rate-limiter.test.js` (token-bucket
arithmetic, per-key override validation, lazy sweep) and
`tests/unit/security/integration-rate-limit-http.test.js` (429 + Retry-After
over a real HTTP round-trip, per-key bucket isolation, stage ordering
relative to authentication and collection authorization).

### UPDATE (§12m, 2026-08-24) — the spend/token-cost half of this finding is now also closed for the Integration surface

The original finding's title names two distinct concerns: request **rate**
(closed above, 2026-08-18/19) and **cost** — "one Ask v2 request may invoke
the generation provider for query rewriting, the final answer, and summary
compaction," so bounding request count alone does not bound billable work.
That second half is now closed too: a request-scoped ledger
(`src/core/ask/budget-ledger.js`) shared across every generation call one
Ask v1/v2 request can make, a provider-neutral hard output-token cap
mapped to each backend's official request option (Gemini
`generationConfig.maxOutputTokens`, Ollama `options.num_predict`), and a
per-key aggregate rolling token budget (`src/core/auth/token-budget.js`,
structurally mirroring this same rate limiter) layered on top of the
existing per-key identity, independent of and unaffected by it. Full
design record, enforcement order, and named MVP limitations (process-local
only — resets on restart, not shared across replicas):
`docs/security/ask-spend-token-budget-design-2026-08.md`.

**Not closed by this either:** same admin-surface gap as above —
`/api/search` and the rest of the Admin surface never invoke a generation
provider, so a spend ceiling has no meaning for them, but they still carry
no request-rate limit of any kind.

**Proof:** `tests/unit/security/token-budget.test.js`,
`tests/unit/security/ask-budget-ledger.test.js`,
`tests/unit/security/ask-spend-token-budget-http.test.js`,
`tests/unit/core/ask/budget-wiring.test.js`.

### P2-2 — `settings.json` written with default OS file permissions; no
`mode` hardening.

**Reachable path:** not HTTP-reachable — a local-filesystem finding,
included because Settings API's secret handling (P1-safe boundary, §8)
only protects the HTTP response; the underlying file is a second,
independent exposure surface.

**File:line:** `src/core/settings/settings-store.js:29-33`
(`writeFileSync`/`renameSync`, no `mode` argument — defaults to the
process umask, typically `0644`/world-readable on POSIX, no ACL
restriction on Windows either).

**Exploitation conditions:** another local account on a genuinely
multi-user machine (undercuts scenario 1's "single trusted user" framing
if the machine itself is shared).

**Impact:** disclosure of `QDRANT_KEY`/`GEMINI_API_KEY` (both stored in
`settings.json` when configured via the Settings API rather than `.env`)
to any other local account with read access to `SEMIDEX_HOME`.

**Existing mitigations:** none observed in `settings-store.js`.

**Proof:** by code reading only (`settings-store.js:29-33`); not
independently re-tested since `fs.writeFileSync`'s default-mode behavior
is standard, well-documented Node.js behavior, not something this
codebase implements incorrectly relative to a spec — it simply never
opts into stricter permissions.

**Recommended fix direction:** pass an explicit restrictive `mode`
(`0o600` on POSIX) to `writeFileSync`/equivalent on Windows ACL handling;
direction only.

### STATUS: FIXED on POSIX; deliberately unaddressed on Windows (2026-08-21)

`writeSettingsFileAtomic()` (`src/core/settings/settings-store.js`) now
mirrors `core/auth/key-store.js`'s own `persist()` exactly — the same fix
already shipped for `integration-keys.json`, applied here to the other file
holding the same secret class (`QDRANT_KEY`/`GEMINI_API_KEY`): the tmp file
is created with `{ mode: 0o600 }` and then explicitly `chmodSync`'d to
`0o600` (the `writeFileSync` `mode` option alone is subject to the process
umask; the follow-up `chmodSync` is what actually guarantees the bits
regardless of umask), then renamed over the target, then the target itself
is `chmodSync`'d to `0o600` again as a second belt-and-suspenders pass.

**Replaces existing permissive files, not just new ones.** `rename()`
replaces the directory entry — and therefore the inode and its mode —
atomically. There is no window where an old, wider-permission
`settings.json` and new content coexist under the same path; a file that
was `0o644` before this fix is `0o600` after the very next write, verified
directly (`tests/unit/security/settings-store-file-permissions.test.js`
pre-creates a `0o644` file, writes through it, and asserts the result is
`0o600`).

**Windows: honestly unaddressed, not silently assumed safe.** `chmodSync`
on Windows only toggles the read-only attribute — it neither expresses
POSIX group/other bits nor enforces an ACL, and this fix adds no ACL
hardening. Confidentiality of `settings.json` on a shared Windows machine
still depends entirely on the default NTFS permissions of the user's
profile directory, exactly as before. Every chmod call is wrapped so a
failure (expected on Windows, and possible on some POSIX network
filesystems) never aborts the write — the caller still gets the write they
asked for via `writeFileSync`'s own `mode` option, just without the
umask-independent guarantee.

**Fail-safe on error.** If `writeFileSync`, `chmodSync`, or `renameSync`
throws, the tmp file is removed (best-effort) before the error is
re-thrown, so a failed write never leaves a stale `.tmp` file or a
partially-written `settings.json` — verified by forcing each failure mode
independently with injected fs functions.

**Proof:** `tests/unit/security/settings-store-file-permissions.test.js` —
12 tests: 8 with injected fs operations (write/chmod/rename order, chmod
failure does not abort the write, cleanup on write/rename failure, no
cleanup attempted when the tmp file was never created), 2 against a real
temp file (round-trip content, no stale `.tmp` after a second write), and 2
POSIX-only assertions of the actual `0o600` mode (`{ skip:
process.platform === 'win32' }` — not run, not silently assumed passing, on
this Windows development machine).

### P3-1 — No Host-header / DNS-rebinding defense at the application
layer.

**Reachable path:** the HTTP server never inspects `req.headers.host`
(confirmed: zero references to `req.headers.host` anywhere under `src/`).
A DNS-rebinding attack (attacker-controlled DNS name that first resolves
to an attacker server, then — after the browser has cached a same-origin
policy grant for that name — is rebound to `127.0.0.1`) is not defended
against by anything in this codebase; the only defense is whatever the
OS/browser/network layer provides (which is real but outside Semidex's
control, and the task brief explicitly asked this not be hand-waved away).

**File:line:** absence confirmed across `src/shared/admin/router.js`,
`src/core/http/http.js`, `src/shared/admin/register-neutral-routes.js`.

**Exploitation conditions:** classic DNS-rebinding preconditions (attacker
controls a DNS name with a short TTL, victim visits an attacker page while
Semidex Lite is running on loopback) — a known, if increasingly
browser-mitigated, class of attack against "trust loopback" designs
generally, not specific to a bug in this codebase.

**Impact:** if successful, gives the attacker page the same
same-origin-policy standing as a legitimate `127.0.0.1:8642` origin,
which combined with P1-1's total absence of CORS would let the attacker
page both fire *and read the response of* any route.

**Existing mitigations:** none server-side. (Chromium and Firefox both
have partial, evolving built-in DNS-rebinding protections for `localhost`,
but relying entirely on browser-side mitigation for a locally-bound
admin API is exactly the "don't hand-wave it away" case the task called
out.)

**Recommended fix direction:** a Host-header allow-list check
(`127.0.0.1`/`localhost`/configured `ADMIN_HOST` only, reject anything
else with 421) is a small, high-value addition; direction only.

## 8. Confirmed-safe boundaries

- **Secrets never leak through the Settings API.** `GEMINI_API_KEY` and
  `QDRANT_KEY` (both `secret:true` in `definitions.js`, both in Lite's
  exposed allow-list) never populate `configuredValue`/`activeValue` in any
  `GET /api/settings` response — only a `configured:boolean` flag
  (`src/core/settings/service.js:182-184`). This holds through the Lite
  allow-list wrapper too (`service.lite.js` never adds its own value
  passthrough). Proven live:
  `tests/unit/security/settings-secret-redaction.test.js` (5 tests) — the
  fake secret string is confirmed absent from the entire serialized
  `getAll()` JSON body in both the raw and Lite-wrapped service.

- **Error-message redaction is applied consistently at every route that
  can surface a raw provider error**, not just Ask: `api/health.js:16-18`,
  `api/generation.js:25-28`, `api/generation-models.js:32-45`,
  `ask-api/v1/route.js:40-42`, `ask-api/v2/route.js:21-23`, and the
  router's own uncaught-exception catch-all
  (`src/shared/admin/router.js:78-86`, which explicitly documents the one
  historical case — `collections.js`'s sync-schema route — where an
  unredacted Qdrant error reached a client, now fixed at the catch-all
  level as defense-in-depth for any future route that forgets its own
  redaction). `sanitiseErrorMessage()` (`doctor-checks.js:29-50`) strips
  both literal key values and any URL with embedded credentials/query
  strings.

- **Full/Lite composition split is real, not just documented.** See §4's
  route-parity section — structurally impossible for Full-only routes to
  register in Lite (no import path exists), and now behaviorally verified
  by `tests/unit/security/lite-full-route-parity.test.js`.

- **Lite hard-pins are enforced at more than one layer.** `applyLiteHardPins()`
  (`hard-pins.js:26-31`) sets env vars unconditionally before bootstrap;
  independently, `service.lite.js`'s `setMany()` rejects any settings key
  outside `LITE_SETTINGS_KEY_SET` (which excludes every local-provider key —
  `TAG_PROVIDER`, `OLLAMA_URL`, `ONNX_EXECUTION_PROVIDER`, etc., all marked
  `excluded(LOCAL_RUNTIME)`/`excluded(LOCAL_MODEL)` in `lite-policy.js`), so
  even a caller that reaches `PATCH /api/settings` directly cannot
  re-enable a local provider through the HTTP API — confirmed by reading
  `lite-policy.js`'s exhaustive, test-enforced classification
  (`tests/unit/core/settings-lite-policy-completeness.test.js`, pre-existing,
  not added by this audit).

- **Static UI serving has a real traversal guard.**
  `resolveStaticPath()` (`static.js:32-38`) normalizes the joined path and
  rejects anything that doesn't stay prefixed under `UI_DIR`, plus an
  extension allow-list (only `.html/.js/.css/.svg/.ico`) — a `../../../`
  in the URL cannot escape `dist/admin-ui/`.

- **Ask's single-flight lock genuinely prevents concurrent generation
  races**, and is shared correctly between v1 and v2 through
  `createAskCoordinatorBundle()` (confirmed via `coordinator.js`'s own
  header comment and `register-neutral-routes.js:143-146`) — this is a
  correctness/consistency guarantee, not a security control (see P2-1 for
  why it doesn't substitute for rate limiting), but it is real and worth
  recording as intentional, not accidental.

- **Ask v2's protocol ceilings are enforced at parse time, before any
  retrieval or generation cost is incurred** — 200 messages, 50,000
  chars/message, 8,000-char summary, all fixed and non-configurable
  (`ask-api/v2/request.js:41-44`), rejected with 400 before the request
  reaches the coordinator at all.

- **The indexer subprocess spawn is not a shell-injection vector.**
  Confirmed via `child_process.spawn(execPath, [entry, ...args], opts)` —
  an argv array, `shell` option never set — for both
  `spawn-indexer-lite.js` and `spawn-indexer-full.js`; see P1-3's proof for
  the explicit test confirming this shape.

## 9. Unconfirmed risks / open questions

- **Actual production impact of P1-1 against a real browser** was not
  verified with a live browser. The *server side* is now confirmed by test
  (`csrf-state-changing-routes.test.js`): a browser-simple cross-origin POST
  executes a state-changing handler, and the `DELETE`/`PATCH` preflight path
  404s. What remains unverified is the *client side* — that a real browser
  actually sends the browser-simple request without a preflight against this
  server, and actually refuses to send the `DELETE`/`PATCH` after the 404
  preflight, in each current mainstream engine. The route-class split in
  P1-1's table is derived from the Fetch/CORS specification plus the
  server's observed behaviour, not from a live browser reproduction. A
  headless-browser test per state-changing route would close this; note that
  the preflight-protection half is the one worth confirming hardest, since
  the audit currently *relies* on it to downgrade `DELETE
  /api/collections/:name` and `PATCH /api/settings` out of the exploitable
  set.

- **DNS-rebinding exploitability (P3-1) against current mainstream
  browsers** was not verified live — browser-side mitigations have evolved
  and this audit did not attempt a live rebinding attack. The absence of
  server-side defense is confirmed; whether it is currently exploitable
  end-to-end against, say, current Chrome depends on browser internals out
  of this codebase's control and changes over time.

- **Whether a real reverse-proxy misconfiguration in a specific deployer's
  stack (nginx/Caddy/Traefik/etc.) would forward Origin/Host headers in a
  way that defeats even a future Host-header check** is deployment-specific
  and cannot be confirmed in the abstract — this would need to be verified
  per actual deployment topology once such a check exists.

- **File-permission behavior of `settings.json` on Windows** (P2-2) —
  updated 2026-08-21: the POSIX half of this finding is now fixed and
  verified by test (`chmodSync(..., 0o600)`, confirmed on-disk). The Windows
  half remains exactly as originally noted: `chmodSync` there only toggles
  the read-only attribute, expresses no POSIX group/other bits, and enforces
  no ACL — no Windows-specific hardening was added, and none was
  independently tested beyond confirming the chmod call does not throw or
  abort the write on this Windows development machine. POSIX-mode
  assumptions still do not translate to Windows ACL semantics, and that gap
  would need separate, dedicated work if Windows multi-user isolation
  becomes a real target scenario.

- **Real-world Qdrant Cloud / Gemini rate-limit behavior under a
  Semidex-Lite-side flood** (i.e. whether Qdrant/Gemini's own upstream
  rate limiting would absorb some of P2-1's impact in practice) was not
  tested against live services, per the task's explicit "no live
  Qdrant/Gemini calls" constraint.

## 10. Prioritized implementation plan for the MVP security pass

> **Sequencing constraint — do not start with a global shared secret.**
> The obvious first move ("add one API key, check it at
> `handleRequest()`") is rejected as step 1 of this plan. Semidex Lite
> serves its own browser dashboard from the same origin and the same
> process as its integration API, and that dashboard is currently
> credential-less by design. A single process-wide secret forces an
> immediately-unpleasant question with no good answer at MVP scale: **how
> does the dashboard obtain and present that credential?** Every cheap
> option is a new finding — embedding it in the served HTML/JS makes it
> readable by any local process and by anything that can induce the browser
> to load that page; putting it in `localStorage` and attaching it via
> `fetch` makes it XSS-exfiltratable and does nothing about P1-1 unless an
> Origin check ships anyway; putting it in a cookie reintroduces exactly
> the ambient-authority CSRF problem P1-1 describes, now with real
> privileges attached. Deciding this *after* shipping the secret means
> retrofitting the answer under compatibility pressure. So the split below
> comes first, and the credential model follows from it.

1. **Host-header allow-list check** (P3-1 fix direction) — smallest,
   lowest-risk change; add before anything else since it costs almost
   nothing and closes a real gap. Effort: small. Risk: near-zero (only
   rejects requests with an unexpected Host header, which no legitimate
   client sends today).
2. **Explicit `Origin`/`Sec-Fetch-Site` rejection on state-changing
   routes** (P1-1) — ship this *before* any auth work. It is small,
   requires no credential-distribution design at all, needs no client
   change (same-origin dashboard requests pass; the browser-simple
   cross-origin vector is closed), and it is the only step here that
   improves security without first answering the credential question. Keep
   `OPTIONS` unanswered (or explicitly denied) so the incidental
   preflight protection documented in P1-1 survives. Effort: small. Risk:
   low.
3. **Separate the admin API from the integration API — a prerequisite for
   authentication, not a later nicety.** These two surfaces have genuinely
   different callers, threat models, and credential needs, and conflating
   them is what makes the single-shared-secret design collapse:
   - *Integration API* (`/api/v1/ask`, `/api/v2/ask`, `/api/search` as
     planned here — **as actually shipped, §12d kept `/api/search` Admin**,
     deliberately; see that section):
     called server-to-server by someone else's backend. A bearer
     API key is the natural fit — no browser holds it, so there is no
     distribution problem and no ambient-authority/CSRF exposure. This is
     where per-key **collection scopes** belong (closing P1-2 properly
     rather than via a global allow-list).
   - *Admin API* (settings, jobs, collections, system probes, static UI):
     called by the operator's browser on the same origin. This surface
     should stay **loopback-bound and unexposable**, with its protection
     coming from bind address + Origin/Host checks rather than from a
     secret the page must somehow carry. If it ever needs to be remotely
     reachable, it needs a real session model (login → `HttpOnly`,
     `SameSite=Strict` session cookie + CSRF token), which is a much
     larger piece of work that should not be smuggled in via an API key.

   Decide and document this boundary before writing the auth code; the
   scopes, the credential formats, and the exposure rules all fall out of
   it. Effort: medium (design-led). Risk: medium — but far lower than
   retrofitting a split after a shared secret is in the wild.
4. **Authentication, implemented along the split from step 3**: bearer API
   keys with collection scopes on the integration API; no new credential
   on the admin API beyond the bind/Origin/Host controls, unless and until
   remote admin access is an explicit product requirement. Effort: medium.
   Risk: medium (must not break the existing loopback single-user
   workflow — the admin surface should keep working with no credential at
   all in scenario 1).
5. **Collection scoping enforced server-side** against `collection`/`:name`
   on every route that accepts it (P1-2) — per-key scopes on the
   integration API, plus an optional global allow-list for defence in
   depth. Effort: small once step 4 exists; medium standalone.
6. **Rate limiting** (P2-1), tunable per-route, with Ask/search
   specifically capped tighter than read-only admin routes. Effort:
   medium.
7. **Indexing-path allow-list** (P1-3) — an explicit "allowed roots"
   setting checked before `startIndexJob()`. Effort: small.
8. **CORS policy** — only once the step-3 split exists, add an explicit
   `Access-Control-Allow-Origin` allow-list (never `*`, never with
   credentials) for the *integration* surface if a deployment legitimately
   needs browser-based cross-origin access. Do not apply it to the admin
   surface. Effort: small.
9. **`settings.json` file-mode hardening** (P2-2). Effort: trivial.
10. **Security headers** (`X-Content-Type-Options: nosniff` at minimum for
    the static UI/JSON responses; CSP for the dashboard HTML). Effort:
    small. Risk: low, but must be tested against the dashboard's own asset
    loading (inline scripts, etc. — not audited here) before shipping a
    strict CSP.

## 11. Acceptance criteria for the future security refactor

- [ ] The admin/integration API split from §10 step 3 is decided and
      documented, and each route in the §4 inventory is explicitly assigned
      to one surface — before any credential is introduced.
- [ ] Every route in the §4 inventory has an explicit, tested
      authentication requirement appropriate to its surface (or an
      explicit, documented, security-reviewed exception — e.g. a
      health-check route intentionally left open).
- [ ] `tests/unit/security/csrf-state-changing-routes.test.js`'s current
      "browser-simple cross-origin POST executes the handler" assertion is
      replaced with one proving the request is now rejected on Origin, and
      its "preflight-protected" assertions still pass (i.e. the fix did not
      introduce permissive CORS that removes the incidental preflight
      protection).
- [ ] `tests/unit/security/cors-headers.test.js`'s current
      "no CORS headers anywhere" assertions are replaced with assertions
      matching the new, explicit CORS policy (allow-list, never wildcard
      with credentials) — and the Lite composition is asserted separately
      from Full, as it is today.
- [ ] A Host-header check rejects any request whose Host doesn't match the
      configured bind host/an explicit allow-list, with a regression test.
- [ ] `tests/unit/security/ask-api-collection-allowlist.test.js`'s
      "any collection string is accepted" assertions are replaced with
      assertions proving an allow-list/scope check actually rejects an
      out-of-scope collection for a given caller identity.
- [ ] `tests/unit/security/spawn-indexer-path-validation.test.js`'s
      "arbitrary path accepted" assertions are replaced with assertions
      proving a path outside the configured allowed roots is rejected
      before `spawnIndexer` is ever called.
- [ ] A rate-limit test suite exists proving a per-route/per-caller cap is
      enforced (not just Ask's single-flight concurrency lock).
- [ ] `settings.json` is written with a restrictive mode; a test (or
      documented platform-specific verification) confirms it.
- [ ] The README's security/limitations section (see §12) is updated to
      match what actually shipped, not left describing the pre-fix state.
- [ ] `tests/unit/security/lite-full-route-parity.test.js` and
      `tests/unit/security/settings-secret-redaction.test.js` still pass
      unmodified — these are confirmed-safe boundaries the refactor must
      not regress.
- [ ] Every finding in §7 has a corresponding closed issue/changelog entry
      citing this document's finding ID.

## 12. Required decisions (with justification)

**Should Semidex Lite stay loopback-only by default?** Yes — keep the
current default and the `ADMIN_ALLOW_REMOTE=1` opt-in, but make the opt-in
noisier: today it's a one-time startup check
(`server.js:23-28`) with no ongoing signal that the server is running in a
riskier mode. Given §7's findings (especially P1-1, which doesn't actually
require crossing the loopback boundary to matter), loopback-only is
necessary but was already shown to be insufficient on its own — it should
stay the default while the real fix (auth) is built independently, not be
treated as "good enough."

**Where should authentication live — in Semidex itself, in a wrapper
backend, or both layers?** Both, but Semidex's own layer is the one
currently entirely missing and should ship first — with the sequencing
caveat in §10: "first" means first among the *auth* work, after the
admin/integration split is decided, and after the two credential-free
controls (Host check, Origin check) that need no distribution design.
A wrapper backend
(scenario 2) can and should add its own end-user auth, but it cannot
protect Semidex's *other* callers (anything else on the same loopback/LAN/
proxy) unless Semidex also has its own check — the wrapper's auth and
Semidex's auth solve different problems (who is this end user vs. is this
caller allowed to talk to Semidex at all) and neither substitutes for the
other, per §6 scenario 2's analysis.

**Does the embedded server need API keys/scopes?** Yes, for any deployment
beyond scenario 1 (single trusted user, single OS account) — and scenario 5
(multi-tenant) specifically requires *scoped* keys (per-collection), not
just a single shared secret, mirroring the model Qdrant Cloud's own
granular-access API keys already use for the same problem at the storage
layer (see §13 sources) — reusing that mental model keeps Semidex's own
scoping story consistent with the datastore it sits in front of.

**Should admin API and integration (Ask) API be split?** Yes — they have
fundamentally different risk profiles (admin routes are
destructive/configuration-changing; Ask routes are billed/generative but
non-destructive) and, per §6 scenario 2, a wrapper backend's own end users
should very plausibly be allowed to call Ask but never the admin routes.
Splitting them onto different auth scopes (not necessarily different
ports/processes) is the natural fix and aligns with the "Should admin API
and integration API be split?" framing already implicit in this codebase's
own `LITE_JOB_POLICY`/`FULL_JOB_POLICY` pattern (different capability sets
per composition — the same pattern extends naturally to per-caller scopes).

**Which endpoints must never be exposed to an untrusted client?**
`PATCH /api/settings` (can rewrite `QDRANT_URL`/`QDRANT_KEY` to point at an
attacker-controlled Qdrant instance, silently redirecting all future
reads/writes), `DELETE /api/collections/:name`, `POST /api/jobs/index`
(P1-3's arbitrary local-path read), and `POST /api/system/qdrant-cloud-probe`
(triggers a real, potentially billed Qdrant Cloud Inference round-trip on
demand) are the highest-severity admin routes; all four should require the
strongest auth scope in any tiered model.

**Is a collection allow-list needed?** Yes — see P1-2 and scenario 5;
without it, "one instance serving multiple users" is not a supportable
configuration at all, only an accident waiting to happen.

**What rate/body-size/concurrency limits does the MVP need?** Body size:
the existing generic 1MB JSON cap (`http.js:62`) is a reasonable floor but
should be tunable per-route (Ask's `conversation.recentMessages` alone can
legitimately approach several hundred KB under the existing 200-message/
50k-char protocol ceilings). Concurrency: Ask's existing single-flight lock
should stay (it's a correctness feature), but needs a genuine *rate* limit
layered on top, per P2-1. Admin routes (settings/jobs/collections) need at
minimum a coarse per-caller rate cap to prevent accidental or malicious
hammering, even though they're not billed like Ask.

**What security headers and CORS defaults are needed?** CORS: default to
no allow-list (deny all cross-origin reads) until a deployer explicitly
configures one — never ship a wildcard default. Headers: `X-Content-Type-Options:
nosniff` on every response (cheap, closes a MIME-sniffing class of issue);
a CSP for the dashboard HTML specifically, scoped after auditing the
dashboard's actual script/style sources (not done in this pass — the
dashboard's client-side code was out of scope here beyond confirming
server-side route enforcement).

**How should a third-party backend safely use Ask v2?** The existing
README section (`packages/lite/README.md:458-604`, "Backend integration:
multi-turn Ask") already documents this well: the caller owns all
conversation state, Semidex never persists it, and the caller must treat
`conversation.summary`/`recentMessages` as untrusted context, never as
retrieval evidence or an override of Semidex's system instructions. This
existing guidance should be extended (not replaced) with an explicit
statement that the *caller's own backend* must independently authorize
which `collection` an end user's Ask request is allowed to target, since
Semidex itself performs no such check (this is the missing half of the
existing documentation, and it's exactly what P1-2 formalizes).

**What should the README honestly disclose about current limitations
BEFORE full protection ships?** A new, explicit "Security status" section
stating plainly: no built-in authentication, no CORS/CSRF protection, no
rate limiting; loopback-only by default is necessary but not sufficient
(with the CSRF-shaped same-machine-browser caveat spelled out, not
hand-waved); any deployment beyond a single trusted user on a single OS
account is not currently a hardened configuration and the wrapper backend
must fully mediate access to every route, not just the ones that look
dangerous. This should land before any change described in §10 ships, not
after — operators deploying today deserve the accurate picture now.

## 12h. Response security headers — IMPLEMENTED (2026-08-21)

Closes §10 step 10 and the `Content-Security-Policy`/`X-Frame-Options`/
`Referrer-Policy` half of the OWASP REST Security Cheat Sheet source cited
in §13. `X-Content-Type-Options: nosniff` already shipped before this phase
(§8) and is unchanged here — this phase adds the remaining headers and,
critically, closes the gap where they applied.

**One function, one dispatch point per composition, no per-route
opt-in.** `applySecurityResponseHeaders()` (`src/core/http/
request-security.js`) sets `Vary: Origin, Sec-Fetch-Site` (pre-existing),
`X-Content-Type-Options: nosniff` (pre-existing), `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and `Content-Security-Policy` (below). It is
called from exactly three places, chosen so nothing can respond without it:
`router.js`'s `handleRequest()` (every API response — success, error, 404,
and a request rejected pre-dispatch by the Origin/Host policy, since the
call happens before that check runs), `static.js`'s `handleStatic()` (every
static-UI response — 200, 404, 405, 503), and the one raw pre-router
Host-rejection branch in `register-neutral-routes.js` that serves a plain-
text 400/403 for a static-path request and never reaches `handleStatic()`
at all. Both Full and Lite funnel through the same `createHttpServer()`/
`createRouter()` in `src/shared/admin/`, so the two compositions cannot
carry different header policies.

**The policy:**

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self';
  connect-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'
```

Derived from the actual built output (`dist/admin-ui/`), not written
speculatively:

- **`script-src 'self'`, no `unsafe-inline`/`unsafe-eval`.** The built
  bundle (`dist/admin-ui/assets/*.js`, `index.html`) was grepped directly —
  zero inline `<script>` tags, zero `javascript:` URIs. The one `<script>`
  element is `type="module" src="/assets/<hash>.js"`, same-origin.
- **`style-src 'self' 'unsafe-inline'` — a genuine, checked UI dependency,
  not a default-to-permissive shortcut.** The shared modal templates
  (`src/shared/admin/ui-src/partials/shared/templates/{delete,operation}-
  modal.html`) and two Lite-only partials
  (`src/shared/admin/ui-src/partials/lite/{settings-shell,index-view}.html`)
  ship static `style="display:none"`/`style="margin-top:…"` attributes. CSP's
  `style-src` governs the `style` attribute itself, not only `<style>`/
  `<link>` elements, so a strict `style-src 'self'` would silently break the
  modals' default-hidden state and a few spacing rules — confirmed by
  reading the shipped markup, not assumed. `script-src` needed no equivalent
  exception (previous bullet), so the relaxation is scoped to styles only.
- **`default-src 'self'` covers img/font/connect with no broader
  allow-list.** The built CSS/JS were grepped for `url(`, `@font-face`, and
  absolute `http(s)://` references; the only hit is a plain `<a href=
  "https://github.com/...">` navigation link in the JS (an "About" credit),
  which CSP does not govern (top-level navigation isn't a `default-src`
  concern). No CDN, no external font, no external `fetch()`/`XMLHttpRequest`
  target.
- **No `Strict-Transport-Security`.** This server is plain HTTP by default
  (loopback, or fronted by a reverse proxy that terminates TLS itself).
  HSTS on a listener that is not itself serving HTTPS is a no-op at best,
  and actively wrong if the same hostname is ever also reachable over plain
  HTTP. A TLS-terminating deployment should set HSTS at the proxy — the
  layer that actually holds the certificate. This is a deliberate,
  documented limitation, not an oversight (§13's OWASP REST Cheat Sheet
  citation is updated to say so explicitly).
- **`Cache-Control` is a SEPARATE policy, shipped in §12i below.** Not
  covered by `applySecurityResponseHeaders()` — that function is deliberately
  the SAME header set for every response regardless of route, and
  `Cache-Control` is the one header that genuinely needs to differ (API vs.
  static HTML vs. a fingerprinted asset), so it lives in its own module
  (`core/http/cache-policy.js`) rather than being force-fit into this one.

**Applies uniformly, including to rejected/error responses.** A request
rejected by the Origin/Host policy, a 404, a 415, a 500 — all carry the same
header set as a 200, because the call happens once per response at the
shared dispatch point rather than being threaded through every individual
handler.

**Proof:** `tests/unit/security/response-security-headers.test.js` — 14
tests (7 assertions × Full and Lite), covering API success
(`GET /api/health`), API 404, an API error (malformed percent-encoding),
a request rejected pre-dispatch by the cross-site policy, and the static UI
shell's 200/404/405 paths, for both compositions.

## 12i. Cache-Control policy — IMPLEMENTED (2026-08-21)

Closes the `Cache-Control: no-store` gap §12h explicitly left open, and the
matching OWASP REST Security Cheat Sheet citation in §13.

**One module, two call sites, route-aware.**
`src/core/http/cache-policy.js` is the single place that decides
`Cache-Control` for every response this process sends — never a per-handler
header, never a pathname check scattered through a route file. It exports
three functions:

- `applyApiCacheHeaders(res)` — unconditional `Cache-Control: no-store`.
  Called from `router.js`'s `handleRequest()` at the same point
  `applySecurityResponseHeaders()` is called (before route matching, before
  the pre-dispatch Origin/Host verdict), so a rejected request, a 404, a
  handler error, and a genuine 200 all carry it. Every route this router
  serves is `/api/**` (`createHttpServer()` in `register-neutral-routes.js`
  is what actually branches API vs. static by pathname; the router is never
  reached for anything else), so this one call covers the entire API
  surface.
- `applyStaticCacheHeaders(res, { immutable })` — defaults to `no-store`;
  `{ immutable: true }` sets `public, max-age=31536000, immutable`. Called
  from `static.js`'s `handleStatic()` at the same early point as its own
  `applySecurityResponseHeaders()` call, so 405/503/404/200 all start from
  the conservative default. The immutable directive is only ever applied
  a second time, later in the SAME request, inside the 200 branch — and
  only once `readFile()` has already succeeded against a real file on disk.
  A request for a plausible-looking but nonexistent hashed path (e.g.
  `/assets/index-NOTAREAL.js`) 404s with the conservative default; the
  regex match alone is never sufficient (see `isFingerprintedAssetPath()`'s
  own comment for the two-gate rationale). The one raw pre-router
  Host-rejection branch in `register-neutral-routes.js` (same branch §12h
  covers for the security-header set) applies the conservative default too,
  for the same reason `static.js`'s 405/503/404 do.
- `isFingerprintedAssetPath(pathname)` — matches `/assets/<name>-<hash>.js`
  or `.css` only. This is Vite's actual default `assetFileNames`/
  `chunkFileNames`/`entryFileNames` output shape (neither `vite.config.js`
  nor `vite.config.lite.js` overrides those options, or `hashCharacters`,
  or `assetsDir`) — a description of what the build already does, not a
  guessed hash format. Deliberately narrower than the full set of servable
  extensions (`static.js`'s `CONTENT_TYPES` also allows `.svg`/`.ico`):
  those, if ever shipped, would be copied from a `public/`-style source
  directory unhashed, so the pattern does not extend immutable caching to
  them.

**The policy matrix:**

| Response | Cache-Control |
| --- | --- |
| Every `/api/**` response (success, error, 404, pre-dispatch rejection) | `no-store` |
| `POST /api/v1\|v2/ask` streamed (SSE) response | `no-store, no-cache, no-transform` |
| Static HTML shell (`GET /`, `/index.html`) | `no-store` |
| Fingerprinted asset (`/assets/<name>-<hash>.js`/`.css`) that resolves to a real file | `public, max-age=31536000, immutable` |
| Any other static asset (non-fingerprinted, e.g. a future unhashed `.svg`/`.ico`) | `no-store` |
| Static 404 / 405 / 503 (including a path shaped like a fingerprinted asset that names no real file) | `no-store` |
| Static pre-dispatch Host rejection | `no-store` |

**Why the HTML shell is `no-store`, not `no-cache`/`must-revalidate`.** This
server emits no `ETag`/`Last-Modified` on any static response, so there is
nothing for a cache to revalidate against. `no-cache` with no validator
either degrades to "effectively uncacheable" (the honest outcome, but then
`no-store` says the same thing more plainly) or, on a less careful cache
implementation, invites reuse on a heuristic — a real risk for a shell that
reflects `ADMIN_ALLOWED_HOSTS`/security-relevant UI state and must never be
served stale after a config or rebuild changes it. `no-store` is simplest
and says exactly what is true.

**Why the fingerprinted-asset immutable directive is safe.** The filename
itself changes whenever the content does (Vite's content hash), so caching
one exact URL forever is correct by construction — and, as above, it is
only ever granted after a real file has actually been read from disk at
that exact path, never from the URL shape alone.

**Why the SSE Ask stream needed its own fix, not just the router's
`no-store`.** `sse.js`'s `startSse()` calls `res.writeHead(200, { ... })`
with its own `Cache-Control` entry (`no-cache, no-transform`, the
conventional EventSource-compatible directives). Node's
`res.writeHead(status, headers)` **replaces**, not merges with, any
individual header already set via `res.setHeader()` — so before this phase,
a streamed `/api/v1|v2/ask` 200 silently dropped the router's `no-store`
and carried only `no-cache, no-transform`. `startSse()` now sets
`Cache-Control: no-store, no-cache, no-transform` itself, combining both:
`no-store` for the same reason every other `/api/**` response needs it,
`no-cache`/`no-transform` for their pre-existing streaming reasons.

**Why no HSTS change here.** Unchanged from §12h — this server is plain
HTTP by default, and `Strict-Transport-Security` on a listener that is not
itself serving HTTPS is a no-op at best and actively wrong at worst. This
phase only ever touches `Cache-Control`; HSTS remains a proxy-layer
decision, not something either edition's own code should set.

**Full and Lite are identical.** Both compositions share `router.js`,
`static.js`, and `register-neutral-routes.js` via `createHttpServer()`; the
new `uiDir` parameter threaded through `createApp()`/`createLiteApp()` (for
deterministic test fixtures, see Proof below) is optional DI that defaults
to each edition's own real build output and changes no runtime behavior.

**Proof:** `tests/unit/security/response-cache-headers.test.js` — 29 tests
(a shared assertion suite × Full and Lite, plus one Full-only SSE
regression) covering: API 200/404/malformed-request/pre-dispatch-rejection
all `no-store`; the HTML shell `no-store`; a real fingerprinted JS and CSS
asset immutable; a non-fingerprinted asset, a static 404, a static 405, and
a static 503 all conservative; the fail-safe "looks fingerprinted but names
no real file" 404 case explicitly; HEAD/GET parity for both the shell and a
fingerprinted asset; and the streamed Ask response's `no-store`. Static
fixtures are deterministic temp directories built per test (via the new
`uiDir` DI parameter), not the real `dist/admin-ui/` — verified separately,
by hand, against a real `npm run admin:build` output for both editions.

## 12e. Integration API authentication — IMPLEMENTED (2026-08-18)

Closes **P1-2** (no collection scoping) for the Integration surface, and
closes the "no authentication anywhere" half of **P1-1** for Ask.

- **Bearer keys.** `Authorization: Bearer sdx_v1_<keyId>_<secret>` (RFC 6750).
  256-bit secret; only a SHA-256 digest is persisted; the raw token is shown
  once at creation. Never accepted from a query string, cookie, or body.
- **Key store.** A dedicated versioned file under `SEMIDEX_HOME`
  (`integration-keys.json`), never `settings.json` — which is served to the
  browser through `GET /api/settings`. Atomic temp-file+rename writes, 0600
  attempted. A corrupt, unreadable or unknown-schema store **fails closed**
  and is never read as "empty".
- **Fail-closed default.** With no keys configured, Ask returns
  `503 integration_auth_not_configured`. Every credential failure — missing,
  malformed, unknown keyId, wrong secret, revoked, expired — returns a
  byte-identical `401`, and an unknown keyId still performs a dummy
  constant-time comparison, so key ids cannot be enumerated.
- **Scopes.** Per-key `collections` and `operations`. Exact matching; `"*"`
  must be explicit; an empty scope is rejected at creation rather than
  silently meaning "everything". An out-of-scope collection and a nonexistent
  one are indistinguishable from outside.
- **Admin is untouched.** Admin routes never invoke the policy, so a missing
  or broken key store costs Ask, never the dashboard. Verified by test.
- **No Qdrant/Gemini work on denial.** Stage 1 rejects before the body is
  read; stage 2 rejects before `adapter.getCollection()`. Both assert
  `qdrant: 0, gemini: 0, embed: 0`.
- **CLI.** `semidex-lite key add|list|revoke` and `npm run key -- …` share one
  implementation. Revocation and creation take effect without a restart (the
  store is re-read per request).

**Deliberate breaking change:** existing unauthenticated Ask callers get 503
until they create a key. Migration note is in both READMEs.

**Correction (2026-08-21):** this section originally closed with "Rate
limiting remains unimplemented." That went stale within the same
implementation phase — per-key rate limiting shipped alongside this work
(token-bucket, stage 1.5 of the router, see P2-1's STATUS update). The
admin surface still has no rate limiting at all; only Ask v1/v2 do.

## 12d. Admin/Integration boundary — IMPLEMENTED (2026-08-18)

§10 step 3's prerequisite is done. **At the time this section shipped, it
added no authentication, no scopes and no rate limiting** — it made the
boundary those things require explicit, machine-readable and fail-closed.
Public route behavior was unchanged by this step alone.

> **Status update:** authentication, per-key collection scopes, and per-key
> rate limiting shipped on top of this boundary shortly after — see §12e and
> the STATUS updates on P1-2/P2-1 below. They apply to the `integration`
> audience (`POST /api/v1/ask`, `POST /api/v2/ask`) ONLY, exactly as this
> boundary's own design intended. Every `admin` route below still has none
> of the three, by design — that has not changed since this section shipped.

**What shipped:**

- `src/core/http/route-audience.js` — the metadata vocabulary
  (`audience`, `operation`, `resourceType`, `collectionSource`, `costClass`,
  `edition`) and a validator that throws on anything missing or unknown.
- **Fail-closed registration** — `router.get/post/patch/delete` now require
  metadata. A route with no `audience` throws at registration, surfacing at
  server construction and in tests. There is deliberately **no default**:
  defaulting to `admin` would hide a genuinely public endpoint behind the
  wrong policy, defaulting to `integration` would expose a management
  endpoint. A startup error is safer than either.
- **`router.listRoutes()`** — machine-readable inventory, also exposed on the
  server object, so the classification is asserted against what real
  composition roots actually register rather than a hand-kept list.
- **Two-stage policy seam**, instance-scoped via
  `createRouter`/`createApp`/`createLiteApp` (`integrationPolicy`), with no
  process-global state and no authorization logic of its own today:
  - **Stage 1** `authorizeRequest({ req, route, params })` — after route
    match, before the handler, before any body read. For authentication and
    coarse rate limiting. Returns `{ ok: true, principal }`.
  - **Stage 2** `authorizeCollectionAccess(auth, { req, collection })` —
    after the route parses its body, before `adapter.getCollection()`. For
    object-level authorization (OWASP API1:2023). Stage 1 cannot do this:
    the collection identifier is in the body, and a body is a single-use
    stream.
  - Both stages are **fail-closed** (only an explicit `{ ok: true }` allows;
    `undefined`/`null`/`false`/`{}`/an unknown shape/a thrown error all
    deny), the two halves are **atomic** (supplying one without the other
    throws at construction, since authentication without collection scoping
    is a BOLA bypass), the principal is passed through a **deeply frozen
    `auth` context** rather than a mutated `IncomingMessage`, and stage 2
    reads `operation` from **route metadata** rather than a duplicated
    literal.
  - **The policy applies to `audience: integration` routes only.** Admin
    routes never invoke either stage and receive an auth context with no
    principal and no stage-2 hook. This is what keeps the Admin API
    loopback-bound and credential-free: without it, the planned "zero keys ⇒
    `503 integration_auth_not_configured`" rule would take down the whole
    dashboard rather than just Ask.

**The boundary as implemented** (verified against live registries — 29 routes
in Lite, 33 in Full, zero unclassified):

| Audience | Count (Lite) | Routes |
|---|---|---|
| `integration` | 2 | `POST /api/v1/ask`, `POST /api/v2/ask` |
| `admin` | 27 | settings, collection CRUD + schema sync, indexing jobs, operations, health/capabilities, generation status/models, folder picker, Qdrant Cloud probe, skeleton/chunk/document/assembly/node reads, **and `POST /api/search`** |

**`/api/search` is Admin, deliberately.** It is unversioned and consumed only
by the dashboard's own `ui-src/search.js`; it appears in no README or public
API documentation, unlike the versioned `/api/v1/ask`. Publishing a stable
application-facing search API is a product decision that should introduce a
versioned path (`/api/v1/search`), not silently reclassify an internal one.
Recorded as an open question in the design note.

**Handoff (at the time of this section):** [`integration-api-auth-design-note.md`](./integration-api-auth-design-note.md)
carried the decision matrix for the next phase (bearer keys, scopes,
collection authorization, rate limiting) — that phase has since shipped; see
§12e.

## 12c. Next-phase design — status matrix (originally written as "NOT
implemented"; corrected 2026-08-21)

This section was written as a forward-looking design doc before any of
§12d-§12h shipped, under the heading "NOT implemented — follow-up work
only." That heading is no longer accurate for several of the items below —
some have since shipped, in whole or in part. Each item is now tagged with
its real status; nothing here should be read as "planned" without checking
its tag first.

**Status legend:** 🟢 SHIPPED — 🟡 PARTIALLY SHIPPED — 🔵 OPERATOR-CONTROLLED
(available today, outside Semidex's own code) — ⚪ OPEN (still exactly as
originally planned, nothing built).

**1. 🟢 SHIPPED (§12d, 2026-08-18) — Split Admin API from Integration API.**
Shipped almost exactly as planned, with one correction: `/api/search` was
kept **Admin**, not moved to Integration (§12d's own "`/api/search` is
Admin, deliberately" note) — it is unversioned, dashboard-internal, and
publishing it as a stable Integration endpoint was treated as a separate
product decision, not bundled into this split. Admin = settings, jobs,
collections, system probes, static UI, **and `/api/search`**. Integration =
`/api/v1/ask`, `/api/v2/ask` only.

**2. 🟡 PARTIALLY SHIPPED (§12e, 2026-08-18) — Scoped bearer keys on the
Integration API.** Per-key `collections` scopes shipped as planned. Per-key
`operations` scopes shipped, but narrower than originally planned: the only
supported operation value is `generate` (`src/core/auth/key-store.js`'s
`SUPPORTED_OPERATIONS`) — there is no `search` operation, consistent with
item 1's correction that `/api/search` stayed Admin and never became a
scopable Integration operation. Keys are stored hashed (SHA-256 digest
only), with expiry and revocation; no key is ever placed in HTML, static JS,
URL parameters, or `localStorage`. **Rotation** (issuing a replacement for
an existing key without a gap in service) is not a distinct CLI operation —
an operator revokes and creates a new key.

**3. 🔵 OPERATOR-CONTROLLED, unchanged — Qdrant granular keys underneath.**
Independently of Semidex's own keys, the Qdrant credential Semidex holds
should itself be a granular JWT key scoped read or read-write to specific
collections, so a Semidex compromise cannot exceed the storage-layer grant.
Available today directly from Qdrant Cloud (see §13) — this was never
something Semidex's own code needed to ship, and still isn't; it is an
operator configuration choice.

**4. 🟢 SHIPPED (2026-08-19) — Indexing allowed roots.**
`INDEX_ALLOWED_ROOTS` is checked before `startIndexJob()` and resolved with
`realpath`, so ordinary symlink/junction escapes are rejected.
Component-aware win32/UNC semantics are covered by platform-independent
tests; residual TOCTOU is documented in P1-3 rather than hidden behind a
sandbox claim.

**5. 🟡 PARTIALLY SHIPPED (§12m, 2026-08-24) — Per-key and per-route
limits.** Per-key **request-rate** limiting (token bucket, `429` +
`Retry-After`, defaults 30 req/min burst 5, overridable per key) shipped
for the Integration surface only (P2-1's STATUS update, §12e's
correction). A **token budget/spend ceiling** — what OWASP API4's own
worked example is actually about — has now also shipped for the
Integration surface: a per-request ledger shared across every generation
call one Ask request can make, a provider-neutral hard output-token cap
mapped to each backend's official option, and a per-key aggregate rolling
token budget (`key add --token-budget-per-hour/--token-budget-burst`),
process-local, layered on top of the existing rate limiter without
changing it. See §12m and
`docs/security/ask-spend-token-budget-design-2026-08.md` for the full
design and named MVP limitations (process-local, not durable/distributed).
Still ⚪ OPEN: any rate limiting or spend ceiling at all for the **Admin
surface** (`/api/search` included — it has none; it never invokes a
generation provider, so a spend ceiling has no meaning there, but a
request-rate limit still would). Ask's single-flight lock remains a concurrency guarantee only, never a
rate or spend one — unchanged by this update. The spend ceiling's own
reservation check runs *inside* the lock's critical section (same as
every other askCore step), so it still costs one generation "slot" to be
denied; it is layered on top of the lock, not a replacement for it.

**6. 🟡 PARTIALLY SHIPPED (§12j, 2026-08-21) — SSRF/egress restrictions.**
Originally written as "OPEN, unchanged"; that went stale the same day this
correction was made. `evaluateEgressUrl()` now rejects a non-`http(s)`
scheme, embedded userinfo, and a well-known cloud-metadata literal
(`169.254.169.254` and its documented IPv6 forms,
`metadata.google.internal`) for both Qdrant and Ollama URLs before a client
is constructed or a network call fires, and `PATCH /api/settings` accepts a
`QDRANT_URL`/`OLLAMA_URL` change only from a direct loopback connection,
independent of `ADMIN_ALLOW_REMOTE`. See §12j for the full shape and what it
deliberately does not cover — it is not a generic private-network/DNS-based
SSRF defense, and a compromised or careless settings write can still target
any loopback, RFC1918, LAN, or Docker-internal address, which remains
intentional (self-hosted Qdrant/Ollama on those addresses is the supported
deployment shape), not an oversight.

**7. 🟡 PARTIALLY IMPLEMENTED (§12l, 2026-08-23) — RAG-specific threats.**
Originally written as "OPEN, unchanged." Indirect prompt injection and
retrieval poisoning via indexed documents is now exercised as a tested
security property against a named attack corpus (see §12l, and the
dedicated `docs/security/rag-prompt-injection-threat-model-2026-08.md`,
for the full scope, the four real gaps it found and fixed, and exactly
what "tested" does and does not mean here) — it is not, and cannot be,
eliminated by any text-based instruction. Two residual risks are named
explicitly, not left implicit: citation validation proves a citation was
retrieved for this request, never that it semantically supports the claim
it's attached to; and document-body content (not just metadata) can still
visually forge a fake evidence header line. Provenance tracking, a
groundedness/entailment check, and a systematic multi-model red-team
evaluation remain ⚪ OPEN. "Safe rendering of model output" turned out to
already be out of scope for the server itself — see §12l for why.

**8. ⚪ OPEN, unchanged — Structured security audit logs.** Auth decisions,
rejections, and administrative changes — with document contents and secrets
excluded by construction, not by redaction after the fact. Nothing in
§12d-§12h adds structured logging of this kind (the integration policy's
`logger` hook, where present, is diagnostic, not a security audit trail).

## 12b. Phase 1 — what actually shipped (2026-08-18)

Credential-free browser boundary. No authentication, no rate limiting, no
collection scopes — all deferred to the phases in §10, in that order.

| Part | Change | Files |
|---|---|---|
| B | Origin / `Sec-Fetch-Site` rejection before route dispatch | `src/core/http/request-security.js` (new), `src/shared/admin/router.js` |
| C | `Content-Type: application/json` required for JSON bodies (415 otherwise) | `src/core/http/http.js` |
| D | `X-Semidex-Request: admin` sent by the dashboard's central API helper | `src/shared/admin/ui-src/api.js` |
| E | Host allow-list / DNS-rebinding defense, fail-closed in remote mode | `src/core/http/request-security.js`, `src/shared/admin/server.js` |
| F | No CORS added — deliberately unchanged | (none) |
| G | Request-ingestion timeouts + header ceilings | `src/shared/admin/register-neutral-routes.js` |

Both composition roots resolve the policy through the single shared helper
`resolveRequestSecurityPolicy()`, so Full and Lite cannot drift apart.

### Phase 1 review round 2 — three defects found and fixed (2026-08-18)

Post-implementation review found three real gaps in the first cut. All were
reproduced before fixing and now carry regression tests.

| # | Defect | Why it happened | Fix |
|---|---|---|---|
| P1 | **Duplicate `Host` header not rejected** — a request with two `Host` headers returned 200 | The check used `Array.isArray(req.headers.host)`, but node collapses repeated `Host` to the **first value** there, making the branch dead code. Both values are visible via `req.headersDistinct.host` / `rawHeaders`. | Count `Host` occurrences via `headersDistinct` (with a `rawHeaders` fallback) and reject >1 with 400. Duplicate `Host` is a request-smuggling / proxy-disagreement primitive: an intermediary may route on one value while the origin validates the other. |
| P1 | **`Origin` check was not exact-origin** — two bypasses: (a) `Sec-Fetch-Site: same-origin\|none` returned early and skipped `Origin` validation entirely, so any client able to set that one header defeated the check; (b) comparison used host only, so `https://127.0.0.1:8642` matched a plaintext HTTP server | Fetch Metadata was treated as authoritative-and-sufficient. It is unforgeable *by page JavaScript*, but trivially forgeable by any non-browser client — it may narrow a decision, never widen one. | Evaluate **both** signals whenever both are present; a same-origin claim paired with a non-matching `Origin` is a contradiction and is rejected. Compare full origin (**scheme + host + port**) via `URL.origin`. Added `ADMIN_ALLOWED_ORIGINS` for TLS-terminating reverse proxies, since `X-Forwarded-Proto` is attacker-controlled on a directly reachable listener. |
| P2 | **Static UI bypassed Host validation** — `handleStatic()` ran before any security check | `createHttpServer()` branched to static before reaching the router, and the policy lived only inside the router. | `createHttpServer()` now takes the policy and applies `evaluateRequestSecurity()` to static requests too. No secret leaked previously (the API was always checked), but the DNS-rebinding boundary was incomplete and contradicted this document's own "every GET is Host-validated" claim. |

Verified fixed by direct reproduction: two `Host` headers → 400 (API and
static); foreign `Origin` + `Sec-Fetch-Site: none`/`same-origin` → 403;
`https` `Origin` vs http server → 403; static path with foreign `Host` →
403; and all legitimate paths (same-origin dashboard, curl, configured proxy
origin) still succeed.

### Phase 1 review round 3 — one further defect fixed (2026-08-18)

| # | Defect | Why it happened | Fix |
|---|---|---|---|
| P2 | **`ADMIN_ALLOWED_ORIGINS` accepted entries it then silently widened.** `new URL(x).origin` discards userinfo, path, query and fragment, so `https://user:pass@semidex.example.com/admin` was stored as `https://semidex.example.com` — every path on that host, no credentials needed. Non-HTTP schemes (`ftp://host`) were also stored verbatim, where they could never match a real browser `Origin`. | The allow-list was built with the `URL.origin` getter, which is the right thing to compare *against* a browser `Origin` but the wrong thing to *parse operator config* with: it normalizes rather than validates. | Validate strictly before storing: scheme must be `http:`/`https:`, no username/password, `pathname === '/'`, no `search`, no `hash`. Anything else is rejected at construction with an error naming the entry and showing the correct form. One bad entry rejects the whole config — never silently dropped. |

The security impact was limited (an operator had to write such an entry
themselves, and the widened rule still only matched origins they had named a
host for), but the failure mode was the dangerous kind: **config that looks
more restrictive than it is**. An operator writing a credentialed, path-scoped
URL would reasonably believe they had restricted access to that path and to
authenticated callers; they had restricted neither.

**Breaking change — `ADMIN_ALLOW_REMOTE=1` now requires
`ADMIN_ALLOWED_HOSTS`.** Startup fails with an actionable message rather
than silently disabling Host validation in the one mode where it matters
most. Migration:

```bash
ADMIN_ALLOW_REMOTE=1
ADMIN_ALLOWED_HOSTS=semidex.example.com,192.168.1.10:8642
```

Loopback deployments are unaffected: `127.0.0.1`/`localhost`/`[::1]` on the
listening port are allowed by default, and a server bound to an ephemeral
port is additionally matched against its real listening port.

### What Phase 1 does NOT do

Scoped to Phase 1 (2026-08-18) as shipped, at that date. Later phases closed
some of this for the Integration surface only — see §1's status table and
each item's own `STATUS` note in §7 for what is actually true today; this
list is not re-verified against current state.

- It is **not authentication.** Any local process, any curl, any
  server-to-server client still reached every route unauthenticated at this
  point. (Now: Ask v1/v2 require a bearer key — §12e. Every other route is
  still exactly as this bullet describes.)
- It does **not** close P1-2 (collection scoping) or P1-3 (unscoped local
  filesystem indexing) for non-browser callers, as of this phase. (Now: P1-3
  is fully closed; P1-2 is closed for Ask v1/v2 only — see each finding's
  `STATUS` note.)
- It does **not** add rate limiting, so API4 cost exposure (P2-1) was open
  as of this phase. (Now: per-key rate limiting exists for Ask v1/v2 only —
  P2-1's `STATUS` note.)
- `trustProxy` is hard-off; reverse-proxy header forwarding is unhandled.
  (Unchanged — still true today.)

### Manual browser acceptance scenario (not automated)

No real-browser test was run — Playwright was deliberately not added for a
single security test (decision recorded 2026-08-18). The HTTP-level tests
prove server behaviour; they do **not** prove browser behaviour end-to-end.
To confirm manually before relying on this:

1. `npx semidex-lite serve`, then open `http://127.0.0.1:8642` and confirm
   the dashboard still loads, lists collections, saves a setting, and can
   start/cancel an indexing job.
2. Save this as `attack.html` **on a different origin** (e.g. serve it from
   `python -m http.server 9000` and open `http://localhost:9000/attack.html`
   — a different port is a different origin):
   ```html
   <script>
   fetch('http://127.0.0.1:8642/api/jobs/index', {
     method: 'POST',
     headers: { 'Content-Type': 'text/plain' },
     body: JSON.stringify({ collection: 'x', path: 'C:/Users' })
   }).then(r => console.log('status', r.status)).catch(e => console.log('blocked', e));
   </script>
   ```
3. Expected: no job appears in the dashboard's job list. In DevTools the
   request shows as failed/403. Before Phase 1 this returned 202 and
   started a real indexing job.
4. Repeat with `'Content-Type': 'application/json'` — the browser should
   now send a preflight `OPTIONS`, which is unanswered, so the POST is
   never sent at all.

## 12j. Egress/SSRF policy for Qdrant and Ollama URLs — PARTIALLY IMPLEMENTED (2026-08-21)

Closes part of §12c item 6 ("SSRF/egress restrictions"), which this same
correction pass found still marked "OPEN, unchanged" after the mitigation
below had already shipped. Read the scope carefully: this is a narrow,
value-shape check on operator-supplied destination URLs, not a general
SSRF/private-network defense.

**What shipped.** `src/core/security/network-egress-policy.js` exports one
pure function, `evaluateEgressUrl(rawUrl, opts)`, wrapped by two
instance-scoped factories with no shared module state —
`createQdrantEgressPolicy()` (`qdrant-egress-policy.js`) and
`createOllamaEgressPolicy()` (`ollama-egress-policy.js`). Both reject a URL
that:

- uses a scheme other than `http:`/`https:` (OWASP's SSRF guidance notes
  `file:`/`ftp:`/`gopher:` and similar are in scope, not just HTTP);
- carries embedded userinfo (`user:pass@host`) — never a legitimate
  `QDRANT_URL`/`OLLAMA_URL` shape in this codebase, and a known
  parser-confusion vector across HTTP clients/proxies;
- resolves, after WHATWG URL parsing plus explicit `domainToASCII()`
  Punycode canonicalization, to an exact-match well-known cloud-metadata
  literal: `169.254.169.254`, its IPv4-mapped-IPv6 and native-IPv6 AWS/GCP
  forms, or `metadata.google.internal`. Matching is exact-string, never a
  suffix/substring test, so an attacker-chosen name like
  `metadata.google.internal.attacker.example` cannot slip through.

`getQdrantClient()` (`src/core/qdrant/client.js`) calls
`createQdrantEgressPolicy().assertAllowed(url)` before constructing a
client or making any network call; every exported function in
`src/local/core/ollama.js` that performs a `fetch()` does the same through
`createOllamaEgressPolicy()`. A blocked URL throws a typed
`EgressPolicyError` that never echoes the rejected URL itself, so a
credential or secret-bearing query string embedded in a misconfigured value
cannot leak into an error message or log line.

**Write-side boundary, not just a read-side check.** `PATCH /api/settings`
(`src/shared/admin/api/settings.js`) additionally requires a **direct
loopback connection** — checked via
`evaluateDirectLoopbackConnection()` (`src/core/security/
direct-loopback-request.js`) — before accepting any change to `QDRANT_URL`
or `OLLAMA_URL`, regardless of `ADMIN_ALLOW_REMOTE`. This is deliberately
keyed on the key's presence in the request body, not on whether the new
value differs from the current one, so it cannot be bypassed by
round-tripping through a no-op value. `evaluateDirectLoopbackConnection()`
treats the mere *presence* of any of eleven common proxy-forwarding headers
(`x-forwarded-for`, `forwarded`, `x-real-ip`, `via`, `cf-connecting-ip`,
etc.) as disqualifying — never their value, which is attacker-controlled —
alongside a real loopback-range check on `req.socket.remoteAddress`
(`127.0.0.0/8`, `::1`, and the IPv4-mapped-IPv6 dual-stack form).

**What this does NOT provide — read before relying on it:**

- **No generic private-network/SSRF blocking.** Loopback, RFC1918 LAN
  ranges, and Docker-internal hostnames (`host.docker.internal`) are
  deliberately never rejected — self-hosted Qdrant/Ollama on those
  addresses is the documented, supported deployment shape (audit §5), not
  an attack to defend against. A careless or compromised settings write can
  still redirect Semidex at any address in those ranges; only the specific
  cloud-metadata literals above are blocked.
- **No DNS resolution or TOCTOU protection.** The check inspects the URL's
  literal hostname string; it does not resolve DNS and cannot detect a
  hostname that resolves to a blocked address only at request time (classic
  DNS-rebinding-shaped SSRF). This mirrors P3-1's own scope limitation for
  the Host-header check.
- **The loopback write boundary has the same residual gap
  `direct-loopback-request.js` documents for itself:** a bare TCP-level/L4
  passthrough proxy that relays bytes without adding any request header is
  indistinguishable from a genuine local caller by this or any means
  available to a plain `node:http` server. Full Admin authentication, or
  not fronting this endpoint with such a proxy, is required to close that
  residual case.
- **`QDRANT_ALLOW_METADATA_EGRESS=1`/`OLLAMA_ALLOW_METADATA_EGRESS=1`** are
  explicit, off-by-default escape hatches for a controlled test against a
  metadata-shaped mock. Documented as test-only; never set in a real
  deployment.
- **Composition note:** `qdrant-egress-policy.js` and
  `network-egress-policy.js` are shared (reachable in both Full and Lite);
  `ollama-egress-policy.js` is Full-only (Lite has no `OLLAMA_URL` setting
  and no Ollama code path at all), verified in
  `scripts/audit/full-lite-module-classification.json`.

**Proof:** `tests/unit/security/network-egress-policy.test.js` (39 tests —
scheme/userinfo rejection, the metadata block list including Punycode/IDN
canonicalization, every documented-legitimate deployment shape confirmed
still allowed, error-message sanitization, instance isolation between the
two factories), `tests/unit/security/qdrant-client-egress-integration.test.js`
(8 tests — a blocked URL throws before `QdrantClient` construction and
before any network call), `tests/unit/security/
ollama-egress-network-integration.test.js` (14 tests — a blocked
`OLLAMA_URL` prevents every guarded function's `fetch()` from firing,
allowed destinations still make a real call, module-level default-URL
call sites are guarded too), and `tests/unit/security/
settings-sensitive-destination-loopback-boundary.test.js` (24 tests — pure
`evaluateDirectLoopbackConnection()` cases plus real HTTP-server tests
proving a same-host, forwarding-header-bearing request cannot write
`QDRANT_URL`/`OLLAMA_URL`, that unrelated settings are unaffected, and that
two app instances do not share policy state).

## 12k. Structured security audit logging — IMPLEMENTED (2026-08-23)

Closes the "structured security audit logs for auth decisions,
rejections, and administrative changes" item from the roadmap's "P0.
Public-facing hardening" track. Full design record, event taxonomy,
privacy model, and operator reference:
`docs/security/audit-logging-design-2026-08.md`.

**What shipped.** An instance-scoped `AuditSink` contract
(`src/core/audit/sink.js`) with a no-op default and a local JSONL
implementation (`src/core/audit/jsonl-sink.js`, non-blocking/queued for
the server process, a synchronous variant for the one-shot `key`
CLI), plus an allow-listed event schema
(`src/core/audit/event.js`) that constructs every event from named,
typed fields only — never from a request object, exception, or settings
snapshot that would then need after-the-fact redaction. Wired into the
existing request pipeline (`src/shared/admin/router.js`,
`src/core/http/authorize.js`) and administrative routes
(`src/shared/admin/api/{jobs,settings,collections}.js`,
`src/shared/admin/jobs/registry.js`, `src/core/auth/key-cli.js`) with no
change to response status codes, error bodies, or the existing stage
ordering (Host → Origin/CSRF → auth → rate limit → collection scope →
handler) documented elsewhere in this file. Both composition roots
(`src/admin/server-full.js`'s `createApp()`,
`src/admin/composition/lite.js`'s `createLiteApp()`) resolve their own
instance-scoped sink via `resolveAuditSink()`
(`src/core/audit/resolve-sink.js`), mirroring how `resolveIntegrationPolicy()`
is already resolved in both files — same "instance-scoped, fresh per
composition root, no module-level mutable state" contract this document's
own P1-1/§10 sequencing work already established for the key store and
rate limiter.

**Coverage:** Host/Origin/CSRF denial (`request.host_rejected`,
`request.origin_rejected`), Ask bearer-key accept/deny and rate-limit
denial (`auth.integration_accepted`, `auth.integration_denied`,
`auth.rate_limited`), collection-scope denial
(`authz.collection_denied` — this document's own P1-2/§12e finding),
the `INDEX_ALLOWED_ROOTS` boundary and job lifecycle
(`index.root_denied`, `index.job_started`, `index.job_cancel_requested`,
`index.job_cancelled`, `index.job_succeeded`, `index.job_failed` — this
document's own P1-3 finding), and administrative mutations
(`admin.settings_changed` — field name + action only, never the value;
`admin.collection_schema_synced`; `admin.collection_deleted`;
`admin.key_created`; `admin.key_revoked`).

**Privacy contract (see the design doc §3 for the full reasoning):**
collection names are logged in full (operator-chosen resource
identifiers, already visible throughout the existing Admin UI and job
records — not secret content); local filesystem paths are never logged in
full, only as a 16-hex-char one-way hash (`pathHash`); settings changes
record the field name and set/delete action only, never the old or new
value; bearer tokens, key digests, `QDRANT_KEY`/`GEMINI_API_KEY`, Ask
question/answer text, and raw provider errors are never accepted as event
fields in the first place (the schema has no field for them) — this is
allow-listing at construction, not redaction after the fact, per the
task's own explicit requirement. Auth-denial granularity matches
`key-store.js`'s own deliberate anti-enumeration collapse
(`AUTH_RESULT.INVALID` covers unknown/wrong/revoked/expired alike,
unchanged by this work) — the audit event is exactly as coarse as the
policy decision it records, not finer.

**Explicitly not implemented, matching the task's own scope boundary:**
no PostgreSQL or other database adapter (the `AuditSink` contract is
designed to admit one later without changing any call site); no
telemetry or network export; no tamper-evidence/signing; no cross-process
log aggregation for multiple replicas. See the design doc §9 for the
complete, undiluted limitations list.

**Proof:** `tests/unit/core/audit/{event,jsonl-sink,resolve-sink}.test.js`
(schema validation and allow-list enforcement, deterministic JSONL
encoding, newline safety, rotation/retention, flush/shutdown, injected
I/O-failure handling, two-instance isolation) and
`tests/unit/security/audit-logging-behavioral.test.js` (an event is
emitted at each of the coverage points above, through the real router/
route-registration code paths — not a reimplementation of them — plus
negative-sentinel tests placing a unique bearer token, a secret-looking
settings value, and an identifying path fragment directly in the request
inputs and proving none of them appear in any emitted record).

## 12l. RAG-specific threats (indirect prompt injection / retrieval poisoning) — PARTIALLY IMPLEMENTED (2026-08-23)

Addresses item 7 above and the roadmap's "P0. Public-facing hardening"
bullet asking for "an evaluation of RAG-specific threats ... as a tested
security property, not only a mitigated-by-system-prompt best effort."
**Full trust-boundary/attack-path/control inventory, including exactly
which controls are deterministic vs model-dependent, and the complete
residual-risk list:**
`docs/security/rag-prompt-injection-threat-model-2026-08.md`. This
summary does not repeat that document in full — read it before treating
this section as the complete picture, especially §5 ("residual risk"),
which explicitly covers two things this summary only mentions in brief:
citation validation proves retrieval membership, never semantic support
(a compromised or merely wrong model can attach a syntactically valid
`[1]` to a false claim and no control here catches it), and document BODY
content (as opposed to metadata) can still visually forge a fake evidence
header line with no code-level backstop.

This does not claim prompt injection is eliminated — no purely text-based
instruction can eliminate it, since the same channel that carries evidence
to the model also carries any attacker text embedded in it (`prompt.js`'s
own header comment says this explicitly, and still applies). What changed
is that the specific defenses already in place — system/user channel
separation, the citation and `[node: path]` allow-lists, the deterministic
zero-evidence refusal, and the refusal-sentinel streaming guard — are now
exercised end to end against a named attack corpus covering all three Ask
LLM calls (final answer, v2 query rewrite, v2 summary compaction), and
four real gaps found while building that corpus were closed.

**What was already true before this pass (unchanged, just now corpus-tested
instead of only unit-tested in isolation):** `buildSystemPrompt()`
(`src/core/ask/prompt.js`) frames evidence as untrusted data and instructs
the model never to follow directives found inside it; `validateCitations()`
(`src/core/ask/citations.js`) only ever treats a citation number or
`[node: path]` marker as valid if it matches a source that was actually
retrieved for *this* request, so a model that is fooled by injected text
into citing a fabricated source or referencing an out-of-scope node still
produces output the code marks invalid/strips, never something a caller
receives as if it were grounded; zero retrieved evidence refuses
deterministically before the generation provider is ever called, so no
injected instruction can reach the model at all in that case;
`createSentinelGuard()` (`src/core/ask/coordinator.js`) prevents the
refusal sentinel from ever reaching the client even one character at a
time.

**Four real gaps found and fixed while building the corpus:**

1. **Evidence-header forgery via document metadata.** `formatSourceHeader()`
   interpolated `source.sourceFile`/`source.section` — text that comes
   directly from the indexed document itself (a heading's text, or, on
   some ingestion paths, a filename) — without stripping line breaks. A
   heading or filename containing an embedded line break could forge what
   looked like a second `[n] (...)` header line inside a real source's own
   header, making a fabricated evidence block visually indistinguishable
   from a genuine one. Fixed by collapsing CR/LF and the Unicode
   LINE SEPARATOR/PARAGRAPH SEPARATOR code points to a single space before
   interpolation (`src/core/ask/prompt.js`, `sanitizeHeaderField()`) — a
   structural fix, not a model instruction, so it holds regardless of what
   any model does with the result.
2. **No untrusted-history framing on the Ask v2 query-rewrite call.**
   `buildSystemPrompt()`'s `hasHistory` rule already tells the main answer
   model to treat conversation history as untrusted context — but
   `QUERY_REWRITE_SYSTEM_PROMPT` (`src/core/ask/query-rewrite.js`), which
   consumes the exact same summary/recentMessages input for its own
   separate generation call, had no equivalent rule. A calling application
   that stores and replays Semidex's own prior answers as conversation
   history could unknowingly re-feed content an earlier turn's poisoned
   evidence had injected into that answer back into the rewrite call — a
   second-order/replay path for indirect prompt injection, distinct from
   evidence poisoning the current turn's own answer, and capable of
   silently hijacking what gets retrieved (the rewritten query has no
   content validation beyond an emptiness/length check). Closed by adding
   the same untrusted-context rule to `QUERY_REWRITE_SYSTEM_PROMPT`.
3. **No untrusted-data framing on the Ask v2 summary-compaction call.**
   `compactSummaryIfNeeded()` (`src/core/ask/summary-compaction.js`) is a
   SEPARATE LLM call from the main answer, consuming `conversation.summary`
   (the prior summary this same function returned on an earlier turn — and
   which may itself already have absorbed attacker text, since an earlier
   turn's summarization input can include an earlier turn's poisoned
   retrieved evidence once that evidence shaped a stored assistant answer)
   and `conversation.recentMessages` (the same caller-replayed raw history
   §2 above already flags as untrusted). `SUMMARY_COMPACTION_SYSTEM_PROMPT`
   had no untrusted-data framing at all before this pass — closed by adding
   the same pattern used for the rewrite call: an explicit instruction
   never to follow directives embedded in the prior summary or conversation
   messages, and to output only the bounded summary text itself. Regression
   tests use malicious prior-summary and malicious-message fixtures and
   confirm (a) the malicious text reaches the model only as literal prompt
   DATA, never altering the actual system prompt sent, and (b) a
   summarizer that fully "complies" with an embedded directive is still
   only bounded by the same output-length cap as any other output — the
   system-prompt instruction is documented as a defense-in-depth request,
   not a code-enforced content guarantee (see the threat model doc §3.2,
   §5.4).
4. **Evidence-header forgery via `nodePath` (found while regression-testing
   fix #1, not by the corpus itself).** `formatSourceHeader()`
   (`src/core/ask/prompt.js`) interpolated `source.nodePath` into
   `[node: <path>]` for any structural-typed (table/code_block/checklist)
   source unconditionally — the identical class of gap as fix #1, but for
   `nodePath` metadata rather than `sourceFile`/`section`. A `nodePath`
   containing an embedded line break could forge a second `[n] (...)`
   header line the same way; a non-string `nodePath` (malformed retrieval
   metadata) would interpolate whatever raw shape it arrived in. Unlike
   `sourceFile`/`section`, this could NOT be fixed the same way —
   `validateCitations()` matches a model's `[node: path]` marker against
   `source.nodePath` by EXACT string equality, so collapsing/rewriting the
   path would silently make a legitimately retrieved structural node
   un-citable. Fixed instead with a renderability GATE, not a rewrite:
   `isRenderableStructuralNode()` (`src/core/ask/prompt.js`) — one shared
   predicate, exported from `prompt.js` and imported by `citations.js`
   rather than each module keeping its own copy of the structural-type
   check — decides whether a source's `nodePath` is a non-empty string free
   of CR/LF/U+2028/U+2029. A source that fails this check never gets its
   marker rendered in the header and never enables the node-marker
   system-prompt instruction unless another source in the request has a
   safe path; the same predicate also excludes it from `citations.js`'s
   allow-list, so a marker reproducing the unsafe path verbatim (e.g.
   forged in document BODY text by an attacker who already knows it) still
   never validates. A safe `nodePath` continues to render byte-for-byte,
   unchanged from before.

Separately, but discovered and fixed in the same pass:
`sanitizeHeaderField()` (`src/core/ask/prompt.js`) previously assumed
`sourceFile`/`section` were always strings; a malformed or hand-crafted
Qdrant payload carrying a non-string value (object, array, `null`, number,
boolean) would throw on `.replace()`, failing the whole evidence set for
one bad point. Hardened to coerce number/boolean safely and treat any
other non-string shape identically to a missing field — an availability/
robustness fix with a minor injection-surface benefit (never reflecting a
raw object/array shape into rendered evidence text), not itself a new
prompt-injection defense.

**Proof:** `tests/unit/security/rag-retrieval-poisoning.test.js` — a named
attack corpus (role override/jailbreak, system-prompt exfiltration attempt,
forged fake evidence block, forged `[node:]` marker to an out-of-scope
path, refusal-sentinel bypass instruction, sentinel spoofing, citation-
omission request, zero-width-character obfuscation, fake embedded role
turn) run through the real `buildEvidence()` → `buildPromptParts()`
pipeline, plus a "compromised model" section that runs `createAskCore()`
with a fake generation provider that behaves exactly as an attacker would
want a successfully jailbroken model to behave, and asserts the structural
defenses hold regardless: a forged citation number is flagged invalid, not
trusted; a forged node marker to an out-of-scope path is stripped, never
rendered; zero evidence never invokes the model at all; a real sentinel
never reaches the client even when evidence tried to talk the model out of
emitting it. The same file adds a dedicated "retrieval poisoning via
document METADATA (nodePath)" section (fix #4) end to end through
`buildEvidence()`: a newline-embedded `nodePath` never reaches the rendered
prompt as a marker and never forges a second header line; a non-string
`nodePath` never throws; and a compromised model that emits a marker
reproducing the unsafe path verbatim through `createAskCore()` still has it
stripped, proving the shared predicate closes the loophole in
`validateCitations()` too, not just in `prompt.js`'s own rendering. The
same file also adds: a "v1/v2 parity" section proving both versions share
the one `createAskCore()` instance (via `createAskCoordinatorBundle()`)
and therefore enforce identical final-answer citation validation, with v2
additionally threading its `hasHistory` system-prompt rule whenever real
conversation context is supplied; and a "residual risk, documented not
fixed" section that proves — as a deliberately negative-outcome test, not
a passing defense — that a forged header line embedded in document BODY
text (as opposed to metadata) still reaches the rendered prompt
line-initial, exactly as §5.1 of the threat model doc describes.
Regression coverage for the four fixes lives alongside the modules they
fixed: `tests/unit/core/ask/prompt.test.js` (header-forgery collapsing
including the Unicode separator case, the malformed/non-string metadata
coercion tests, and a dedicated section proving a newline, CR, U+2028/
U+2029, or non-string `nodePath` omits the `[node: ...]` marker entirely,
byte-for-byte preservation of a safe `nodePath`, and that the node-marker
system instruction only turns on when at least one source in the set has a
safe path), `tests/unit/core/ask/citations.test.js` (a source with an
unsafe `nodePath` is never a valid citation target, for both the
newline-embedded and non-string cases),
`tests/unit/core/ask/query-rewrite.test.js` (the untrusted-history rule
text, and a poisoned-history rewrite call that still produces a plain
query string), and `tests/unit/core/ask/summary-compaction.test.js` (the
untrusted-data rule text, a malicious prior-summary/malicious-message
call that never alters the real system prompt, and the bounded-output
test for a fully compliant compromised summarizer).

**Explicitly still open, matching the roadmap item's remaining scope (full
detail: threat model doc §5, §7):** citation validation proving retrieval
membership rather than semantic support, with no groundedness/entailment
check between a claim and its citation; document-body delimiter/header
spoofing (§5.1 above), left unfixed on purpose because a snippet-text
rewrite would invalidate `evidence.js`'s exact token-budget accounting;
provenance tracking (there is no mechanism today for an operator or caller
to distinguish "this indexed content came from a verified/trusted source"
from "this indexed content came from an arbitrary uploaded document"); and
a systematic evaluation across multiple real generation models/providers
(this corpus tests the code-level defenses deterministically via a fake
provider standing in for a worst-case compromised model; it is not a
red-team/eval harness measuring how often a *real* model actually falls
for a given attack). "Safe rendering of model output" was audited and
found to already be structurally out of scope for the server itself:
neither Ask API surface renders HTML or Markdown server-side — v1/v2 both
return plain JSON/SSE text fields (`src/core/ask-api/v1/route.js`,
`src/core/ask-api/v2/route.js`), and the admin UI never renders an Ask
answer at all (Ask has no admin UI view) — so unsafe rendering of a
model's answer, if it happens, happens in the calling application, not in
Semidex; that responsibility is the integrating application's, the same
way it is for any other text an LLM API returns.

## 12m. Ask spend/token budget ceiling — IMPLEMENTED (2026-08-24)

Closes the cost half of P2-1 (§7) and item 5 of the recommendations status
matrix (§12c) for the Integration surface: request **rate** was already
bounded (§12e/P2-1 STATUS, 2026-08-18/19), but the billable generation
**work** a single accepted request can cause was not — one
`POST /api/v2/ask` request can invoke the generation provider up to three
times (query rewrite, final answer, summary compaction), and nothing
previously bounded how much output any one of those calls could produce or
how much a bearer key could spend in aggregate over time.

**What shipped:**

- **One request-scoped ledger** (`src/core/ask/budget-ledger.js`),
  constructed per HTTP request and threaded through every generation call
  that request can make — v1/v2's shared final-answer call
  (`src/core/ask/coordinator.js`), v2's query rewrite
  (`src/core/ask/query-rewrite.js`), v2's summary compaction
  (`src/core/ask/summary-compaction.js`). Reservation happens **before**
  each provider call with a conservative worst-case estimate (measured
  input tokens + that call's hard output cap); reconciliation happens
  **after**, and only ever refunds — never charges more than reserved,
  never un-denies a prior rejection, and never refunds at all when
  provider-reported usage is absent or ambiguous.
- **A provider-neutral hard output-token cap**
  (`options.maxOutputTokens` on the `GenerationProvider` contract), mapped
  to each backend's own official request-time option: Gemini
  `generationConfig.maxOutputTokens`, Ollama `options.num_predict`. A
  configured provider that cannot enforce this
  (`capabilities().hardOutputCap !== true`) causes the call to be denied
  closed, never run uncapped — no shipped provider is in that state today,
  but the check exists for any future one. A local stream cutoff was
  deliberately never treated as a substitute spend control, since the
  provider may already have generated (and, for Gemini specifically,
  already billed) more output than this process chooses to keep reading.
- **A per-key aggregate rolling token budget**
  (`src/core/auth/token-budget.js`), structurally mirroring
  `rate-limiter.js` (same clock-injection/atomicity/lazy-sweep contract,
  generalized from a fixed 1-unit cost to a caller-supplied variable
  cost), layered onto the existing bearer-key identity independent of the
  request-rate limiter. Configurable per key
  (`key add --token-budget-per-hour/--token-budget-burst`, same
  optional/null-default/fail-closed-on-malformed contract as
  `--requests-per-minute/--burst`); a legacy key predating this feature
  gets the real, finite tracker default, never "unlimited."
- **One typed error-code family** (`budget_exceeded` 429 retryable,
  `budget_limit_exceeded` 429 not retryable, `budget_unenforceable` 503 not
  retryable), identical in `v1/contract.js`
  and `v2/contract.js`. A budget denial for the shared final-answer call
  always surfaces as a clean pre-stream JSON error — never a partial SSE
  stream that starts and then fails — because the `sources` SSE event is
  now only emitted after the reservation succeeds. v2's rewrite/compaction
  denials degrade silently, exactly like an existing timeout already did;
  only the final-answer call's denial fails the request.
- **One new allow-listed audit event type**,
  `budget.reservation_denied` (`src/core/audit/event.js`), following the
  exact same allow-list/fail-closed/no-success-event pattern as
  `auth.rate_limited`.

**Process-local, not durable — named explicitly.** The per-key aggregate
tracker's state is an in-memory `Map`, exactly like the request-rate
limiter's own buckets: it resets on process restart and is never shared
across replicas. This is a local-process guard against runaway per-key
spend within one running instance, not a durable account quota or
distributed billing system — a multi-replica deployment gets, in effect,
`replicaCount × tokenBudgetBurst` of real aggregate headroom per key, not
one globally enforced ceiling. A PostgreSQL/Redis-backed distributed quota
service was an explicit non-goal.

**Not closed by this:** the Admin surface (`/api/search` included) never
invokes a generation provider, so a spend ceiling has no meaning there —
but it still has no request-rate limit of any kind either (unchanged gap,
same as P2-1's own residual). Ask's single-flight lock is unaffected and
remains a concurrency guarantee only; the spend ceiling's reservation
check runs inside that lock's own critical section, layered on top of it,
not a replacement for it.

**Full design record:**
`docs/security/ask-spend-token-budget-design-2026-08.md` (enforcement
order, the exact reservation/reconciliation contract, provider capability
differences, legacy-key policy, the full error-contract rationale,
configuration surface, audit fields, and every named MVP limitation).

**Proof:** `tests/unit/security/token-budget.test.js` (tracker atomicity,
per-key/per-instance isolation, legacy defaults),
`tests/unit/security/ask-budget-ledger.test.js` (reserve/reconcile
contract, per-request ceilings, conservative refund rule),
`tests/unit/core/ask/budget-wiring.test.js` (rewrite/compaction budget
wiring in isolation), `tests/unit/security/ask-spend-token-budget-http.test.js`
(full HTTP path: v1 answer consumption, v2 shared-ledger denial ordering,
retry non-bypass, the stable typed failure shape, audit negative
sentinels, Full/Lite and v1/v2 parity), and
`tests/unit/security/integration-key-store.test.js`'s new "Per-key token
budget" describe block (legacy/malformed persisted-field policy).

## 12n. Search v1 joins the Integration API surface (2026-08-24)

Extends the Integration API from "Ask v1/v2 only" to "Search v1 and Ask
v1/v2" — the classification note in §12d/§10 step 3 and the §12e/§12m
findings above described Ask as the entire Integration surface; that is no
longer accurate, corrected here rather than by editing that dated prose.

**What shipped:** `POST /api/v1/search` — a versioned, authenticated
counterpart to the Admin dashboard's own unversioned `POST /api/search`,
reusing the exact same retrieval implementation
(`src/core/retrieval/search.js`, `src/core/retrieval/search-request.js`) so
the two surfaces cannot drift in ranking/filter/window semantics. `/api/search`
itself is unchanged — still unauthenticated, loopback-only, no public
compatibility promise (see §12d's own classification note, which still
holds for it specifically).

- **Same stage 1/1.5/2 policy as Ask, not a parallel implementation.**
  `POST /api/v1/search` is declared `audience: integration` (route-audience.js),
  so it is authenticated, rate-limited, and collection-scoped by the exact
  same router seam (`src/shared/admin/router.js`) and policy
  (`src/core/auth/integration-policy.js`) Ask v1/v2 already use — no new
  auth code path exists for Search specifically.
- **Operation vocabulary extended, existing keys NOT silently widened.**
  `SUPPORTED_OPERATIONS` (`src/core/auth/key-store.js`) grew from
  `['generate']` to `['generate', 'search']`. `createKey()`'s own default
  operations list (used when `key add` is called with no `--operation`
  flag) is unchanged (`['generate']`), so a key created before this phase —
  or a new key created without `--operation search` — receives
  `403 forbidden` from `/api/v1/search` until it is (re-)created with that
  scope explicitly. Verified by test
  (`tests/unit/security/integration-search-http.test.js`, "an EXISTING
  generate-default key … is never silently widened to cover search").
- **One shared rate-limit bucket per key across all three endpoints.**
  Search and Ask consume from the SAME per-key token bucket
  (`principal.keyId`-keyed, `src/core/auth/rate-limiter.js`) — calling
  Search does not grant extra effective throughput beyond what Ask already
  consumed this window, and vice versa. Verified by test ("Search and Ask
  requests from the SAME key share one bucket").
- **No spend/token budget ledger for Search** — deliberate, not an
  oversight: Search never calls a generation provider (Gemini/Ollama), so
  there is no billable generation work for §12m's ledger to bound. Its
  `costClass` is `qdrant`, not `llm` (`route-audience.js`).
- **No collection allow-list, same documented limitation as Ask.** Search
  inherits the same per-key `collections` scope Ask already has (§12e) —
  it does not add a NEW, separate collection-authorization mechanism, so
  the "single trusted user" caveat already on Ask v1/v2's collection
  scoping (see the collection-allowlist characterization test) applies
  identically here.
- **Public contract narrower than the internal Chunk shape.**
  `src/core/search-api/v1/contract.js`'s `projectResult()` is an explicit
  field allow-list (`sourceFile`, `chunkIndex`, `totalChunks`, `section`,
  `text`, `context`, `tags`, `score`, `nodeId`, `nodePath`, `nodeType`,
  `isMatch`, `windowChunks`) — a spread/passthrough was deliberately
  avoided so a future internal-only field added to the adapter's Chunk
  shape does not silently reach this public response just because it
  exists on the object, mirroring how Ask v1's own `projectSource()`
  (§12e) already does this for evidence sources.

**Proof:** `tests/unit/security/integration-search-http.test.js` (Full/Lite
parity, stage 1 auth, stage 1 operation scope including the legacy-key
non-widening case, stage 2 collection scope, stage 1.5 shared rate limit,
validation, retrieval/capability error-code mapping, window expansion),
`tests/unit/security/route-audience-classification.test.js` (updated —
`POST /api/v1/search` is now part of the exhaustive integration-route
list, classified `operation: search`/`costClass: qdrant`, never `generate`/
`llm`), `tests/unit/core/search-api/v1/contract.test.js` and
`request.test.js` (pure contract/parsing unit tests), and
`tests/unit/admin/search.test.js` (unchanged — proves the Admin
`/api/search` route and its tests were not weakened by the shared-module
extraction).

## 13. Sources used

- OWASP API Security Top 10 (2023 edition) — used to frame API4 (Unrestricted
  Resource Consumption → P2-1), API8 (Security Misconfiguration → P1-1
  CORS absence), and the general "no authentication" framing (API2, Broken
  Authentication, applies here as "no authentication at all" rather than a
  broken implementation of one). Checked 2026-08-17.
  https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP Cheat Sheet Series — Cross-Site Request Forgery Prevention — the
  primary source for the Phase 1 design. Used for P1-1's framing that CORS
  is not itself a CSRF defense (response readability vs. request execution),
  and for three implementation choices verified against it directly:
  (a) **Fetch Metadata is endorsed as a primary lightweight mechanism** —
  "Servers can use these headers … as a lightweight and reliable method to
  block obvious cross-site requests", with >98% browser coverage and an
  Origin/Referer fallback required, which is exactly the layering
  `request-security.js` implements; (b) **custom request headers are an
  effective mitigation** because "all modern browsers designate requests
  with custom headers as 'to be preflighted'" and an attacker cannot add
  them cross-origin — the basis for `X-Semidex-Request` (Part D), and the
  reason it is documented as preflight-forcing rather than as a secret;
  (c) Origin/Referer is a **defense-in-depth layer, not a primary defense**,
  and the guidance is to **block** when neither header is present — Semidex
  deliberately diverges here (it *allows* requests with neither header) and
  that divergence is stated explicitly in `checkCrossSite()`'s own comment,
  because this API's documented server-to-server integrations are exactly
  the callers that legitimately send neither. Checked 2026-08-18.
  https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP Cheat Sheet Series — REST Security — the direct basis for Part C's
  Content-Type enforcement: "Reject requests containing unexpected or
  missing content type headers with HTTP response status `406 Unacceptable`
  or `415 Unsupported Media Type`" (Semidex returns 415), and for the
  `X-Content-Type-Options: nosniff` response header now set on every
  response. Its `Content-Security-Policy: frame-ancestors 'none'`
  recommendation shipped 2026-08-21 (§12h), alongside `X-Frame-Options:
  DENY` and `Referrer-Policy: no-referrer`. `Cache-Control: no-store`
  shipped 2026-08-21 (§12i), route-aware (API `no-store`, fingerprinted
  static assets `immutable`, everything else conservative `no-store`).
  `Strict-Transport-Security` remains deliberately NOT implemented (see
  §12h/§12i: this server is plain HTTP by default, and HSTS on a
  non-HTTPS listener is a no-op at best). Checked 2026-08-18.
  https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption —
  the framing for treating cross-origin-triggered Ask/search/cloud-probe as
  a *cost* attack and not merely unwanted load. The standard explicitly
  covers paid per-request third-party integrations and recommends spending
  limits/billing alerts; its worked example is an attacker driving a
  third-party SMS provider to "thousands of dollars in a matter of
  minutes." Semidex's equivalent exposure is billed Gemini generation and
  Qdrant Cloud inference. Per-key request-RATE limiting shipped for
  `POST /api/v1/ask`/`POST /api/v2/ask` (P2-1's STATUS update) — what OWASP's
  worked example is really warning about, a per-key/per-caller SPEND or
  token-budget ceiling, is not implemented for any route, and neither is any
  rate limiting at all for the Admin surface (`POST /api/search` included).
  Both remain open. Checked 2026-08-18.
  https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/
- Qdrant — Authentication / database API keys with granular access control —
  the model the §I follow-up phase should mirror for Semidex's own
  integration-API keys: JWT-based keys carrying read vs. read-write
  permissions scoped to individual collections, enabled by default on
  Qdrant Cloud (v1.11.0+), with recommended expiry and rotation. This is
  directly relevant twice: it is the pattern for Semidex's own per-key
  collection scopes (P1-2's real fix), and it is an immediately available
  mitigation operators can apply *today* at the storage layer, independent
  of Semidex shipping anything. Checked 2026-08-18.
  https://qdrant.tech/documentation/cloud/authentication/
  https://qdrant.tech/documentation/security/
- OWASP — Cross Site Request Forgery (CSRF) overview page — general
  background for the same-origin-policy-exempt "simple request" framing
  used throughout P1-1. Checked 2026-08-17.
  https://owasp.org/www-community/attacks/csrf
- Node.js Security Releases blog — CVE-2024-27980 (Windows
  `child_process.spawn`/`spawnSync` batch-file command injection) — used
  to explicitly rule out shell-injection as a P1-3 concern, since this
  codebase's spawn calls never target a `.bat`/`.cmd` file. Checked
  2026-08-17.
  https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
- Qdrant — Cloud Security / Authentication documentation — used for the
  "granular access API keys with per-collection scoping" model cited in
  §12's API-keys-and-scopes decision, as prior art for how the datastore
  Semidex sits in front of already solves the same scoping problem.
  Checked 2026-08-17.
  https://qdrant.tech/documentation/cloud-security/ and
  https://qdrant.tech/documentation/cloud/authentication/
- Google AI for Developers — Using Gemini API keys — used to confirm
  `GEMINI_API_KEY` handling guidance (server-side only, never
  client-exposed) that this codebase's existing design already follows
  (the key never leaves the Semidex process — see §8's confirmed-safe
  Settings API redaction finding). Checked 2026-08-17.
  https://ai.google.dev/gemini-api/docs/api-key
