# Semidex Lite — Public API Security Audit (2026-08)

Status: **audit only — no mitigations implemented in this pass.**
Scope: the HTTP API surface shipped by Semidex Lite (`packages/lite/`), and
the shared router/route code it composes from `src/shared/`, `src/core/`,
`src/cloud/`, and `src/admin/`. Every claim below is traced to a specific
file and line, or to a characterization test added alongside this document
under `tests/unit/security/`.

## 1. Executive summary

Semidex Lite's HTTP API has **no authentication, no authorization, no rate
limiting, and no Origin/CSRF enforcement** of any kind. (It also sets no
CORS headers — but note that this *absence* currently blocks cross-origin
attackers from reading responses, so it is not itself a weakness; the gap is
the missing server-side Origin check on state-changing routes. See P1-1,
which is deliberately scoped to that distinction.) This is a documented,
deliberate
MVP decision (`src/shared/admin/register-neutral-routes.js:18-19`: *"JSON-only,
localhost-only by default, no CORS, no auth (the loopback bind IS the auth
boundary for MVP)"*), not an oversight — but the loopback bind is a weaker
boundary than the comment implies, for three reasons this audit confirms in
code: (1) the bind address is a single env var (`ADMIN_ALLOW_REMOTE=1`) away
from being exposed to a LAN or the internet with zero other change; (2) even
while bound to loopback, the server has no Host-header or Origin check, so it
cannot distinguish a legitimate same-machine client from a malicious
same-machine *browser tab* running attacker JavaScript against
`127.0.0.1:8642`, or from a DNS-rebinding attack; (3) once *anything* sits in
front of it as a reverse proxy — the exact "Lite behind your own backend"
deployment the product is designed for — the loopback boundary disappears
entirely and nothing inside Semidex Lite itself re-establishes a trust
boundary.

Within that no-auth model, the API is otherwise carefully engineered:
request bodies are strictly validated (unknown-field rejection throughout),
secrets are never echoed back by the Settings API, error messages are
redacted before crossing the process boundary, Ask generation is
single-flight-gated, and the Full/Lite composition split is real and
verified — Full-only local-runtime routes (ONNX, Ollama) do not leak into
the Lite build. The risk is concentrated almost entirely in **the absence of
any caller-identity concept at all**, not in scattered implementation bugs.

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
| `POST /api/jobs/index` | Shared | **Start indexing job → spawns subprocess** | W | body (`collection`,`path`,`options`,`kind`) | filesystem (via spawned indexer), then Qdrant | **Yes** — spawns `node index-{lite,full}.js`, indexes arbitrary local path | single global job slot (409 if busy); `path` validated only against URL-scheme strings — **no traversal/scope guard** (see Finding P1-3) | loopback default |
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

### P1-3 — Unscoped local filesystem indexing: `POST /api/jobs/index`
accepts any path the OS process can read, with no allowed-root restriction.

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

Post-Phase-1 the browser vector is closed (P1-1's Origin + Content-Type
layers), but the underlying gap is **unchanged and still open**: any
non-browser caller who can reach the API — and every caller in §6 scenarios
2-5 — can still index any path the process can read. It stays P1 because
the fix (an allowed-roots allow-list, with realpath/symlink handling) must
be designed before the API is opened to any non-operator caller.

**Reachable path:** `POST /api/jobs/index` → `parseIndexJobRequest()`
(`src/shared/admin/api/jobs.js:56-62,164-174`) → `registry.startIndexJob()`
(`src/shared/admin/jobs/registry.js:213-253`) →
`spawnIndexer({ args: [path], env })` (both `spawn-indexer-lite.js:14-16`
and `spawn-indexer-full.js`) → `node index-{lite,full}.js <path>`. The
**only** validation `path` receives at any layer is a URL-scheme rejection
(`URL_SCHEME_RE` in `jobs.js:54-62`) — no traversal check, no
absolute-path restriction, no "must be under an allowed root" check
anywhere in this chain.

**File:line:** `src/shared/admin/api/jobs.js:56-62` (the only guard);
`src/shared/admin/jobs/registry.js:247,253` (path forwarded unchanged into
`env`/`spawnIndexer` args).

**Exploitation conditions:** the caller can reach `POST /api/jobs/index`
at all (any deployment scenario where the API is reachable and unauthenticated
— i.e. every scenario in §6 except a genuinely single-user loopback machine
where this is a non-issue since the user already has that FS access
anyway).

**Impact:** in a scenario where the API caller has *less* filesystem access
than the Semidex Lite process itself (e.g. a wrapper backend running as a
different, more-privileged OS user, or a multi-tenant setup where "index
this path" is meant to be scoped to a per-tenant upload directory), this
lets a caller index — and thereby exfiltrate into Qdrant, then read back
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

**Existing mitigations:** the URL-scheme check (prevents remote-URL
confusion, not a security boundary for local paths); the collection-name
separator check (`PATH_SEPARATOR_RE`, `jobs.js:37-46`) applies to
`collection`, not `path`, and does not help here.

**Proof:** `tests/unit/security/spawn-indexer-path-validation.test.js` (7
tests, all passing) proves `parseIndexJobRequest` accepts
`../../../etc`-shaped and arbitrary-absolute paths unchanged, and that
`createJobRegistry().startIndexJob()` forwards them to `spawnIndexer`
verbatim with no additional check; also proves the argv-array (not
shell-string) shape that rules out shell injection specifically.

**Recommended fix direction:** an explicit, configurable "allowed indexing
roots" setting, validated server-side before `startIndexJob()` is ever
called — direction only, matching this document's own scope.

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

- **File-permission behavior of `settings.json` on Windows** (P2-2) was
  read from source only (`writeFileSync` default mode) — Windows ACL
  inheritance behavior for a file written by a normal user process was not
  independently tested on this machine; POSIX-mode assumptions in the
  finding may not translate directly to Windows ACL semantics and would
  need separate verification if Windows multi-user isolation is a real
  target scenario.

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
   - *Integration API* (`/api/v1/ask`, `/api/v2/ask`, `/api/search`):
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

## 12d. Admin/Integration boundary — IMPLEMENTED (2026-08-18)

§10 step 3's prerequisite is done. **This adds no authentication, no scopes
and no rate limiting** — it makes the boundary those things require explicit,
machine-readable and fail-closed. Public route behavior is unchanged.

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

**Handoff:** [`integration-api-auth-design-note.md`](./integration-api-auth-design-note.md)
carries the decision matrix for the next phase (bearer keys, scopes,
collection authorization, rate limiting).

## 12c. Next-phase design (NOT implemented — follow-up work only)

Everything below is **planned**, not shipped. Nothing here is a current
protection, and the README's "Security status" section must not describe any
of it as existing until it does.

**1. Split Admin API from Integration API.** The prerequisite for every
credential decision (see §10's sequencing constraint). Integration =
`/api/v1/ask`, `/api/v2/ask`, `/api/search`. Admin = settings, jobs,
collections, system probes, static UI. Admin stays loopback-bound and gets
no bearer credential; Integration becomes the only surface that may be
reachable by a non-operator caller.

**2. Scoped bearer keys on the Integration API.** Scopes by operation
(`ask`, `search`) and by collection. Keys stored **hashed** (never
reversible), with expiry, rotation and revocation. No key in HTML, static
JS, URL parameters, or `localStorage`.

**3. Qdrant granular keys underneath.** Independently of Semidex's own keys,
the Qdrant credential Semidex holds should itself be a granular JWT key
scoped read or read-write to specific collections, so a Semidex compromise
cannot exceed the storage-layer grant. Available today (see §13) — operators
can apply this before Semidex ships anything.

**4. Indexing allowed roots.** An explicit allowed-root list checked before
`startIndexJob()`, resolved with `realpath` and re-checked after resolution
so symlinks/junctions cannot escape. Windows needs explicit handling for
ADS (`file.txt:stream`) and UNC/`\\?\` paths.

**5. Per-key and per-route limits.** Concurrency, request rate, token
budget, and cost ceilings — the API4 answer (§13). Ask's existing
single-flight lock bounds concurrency only, never rate or spend.

**6. SSRF/egress restrictions.** `QDRANT_URL` and any future
provider-URL setting are operator-supplied and currently unvalidated; a
compromised or careless settings write can redirect Semidex at an
attacker-controlled endpoint. Needs an egress allow-list and scheme/host
validation.

**7. RAG-specific threats.** Indirect prompt injection and retrieval
poisoning via indexed documents, provenance tracking, and safe rendering of
model output. The existing Ask system prompt mitigates but does not
eliminate this, and it is not currently tested as a security property.

**8. Structured security audit logs.** Auth decisions, rejections, and
administrative changes — with document contents and secrets excluded by
construction, not by redaction after the fact.

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

- It is **not authentication.** Any local process, any curl, any
  server-to-server client still reaches every route unauthenticated.
- It does **not** close P1-2 (collection scoping) or P1-3 (unscoped local
  filesystem indexing) for non-browser callers.
- It does **not** add rate limiting, so API4 cost exposure (P2-1) is open.
- `trustProxy` is hard-off; reverse-proxy header forwarding is unhandled.

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
  response. Its `Cache-Control: no-store`, `Strict-Transport-Security` and
  `Content-Security-Policy: frame-ancestors 'none'` recommendations are
  NOT yet implemented — tracked as §10 step 10. Checked 2026-08-18.
  https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption —
  the framing for treating cross-origin-triggered Ask/search/cloud-probe as
  a *cost* attack and not merely unwanted load. The standard explicitly
  covers paid per-request third-party integrations and recommends spending
  limits/billing alerts; its worked example is an attacker driving a
  third-party SMS provider to "thousands of dollars in a matter of
  minutes." Semidex's equivalent exposure is billed Gemini generation and
  Qdrant Cloud inference. Still open: see P2-1 (no rate limiting).
  Checked 2026-08-18.
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
