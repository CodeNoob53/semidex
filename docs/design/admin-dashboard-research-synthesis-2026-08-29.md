# Admin dashboard research synthesis — 2026-08-29

> Status: synthesis document. Inputs are five external research reports supplied
> for this design pass; the source corpus is intentionally not committed because
> it contains tool-specific citation tokens and unverified claims. This document
> does **not** design the dashboard — it records what the reports got right, what
> they got wrong, and which claims survive contact with the repository. The
> design itself lives in `admin-dashboard-v2-plan-2026-08-29.md`.

---

## 1. Methodology and evidence hierarchy

Five independent reports were produced from the same brief, without repository
access. None of the five read the code. This synthesis re-derives every
Semidex-specific claim from the repository and keeps the reports only for what
they can legitimately supply: external product/standard references, and design
reasoning that does not depend on knowing our API.

**Evidence hierarchy used throughout, strongest first:**

| Tier | Source | Treatment |
|---|---|---|
| 1 | Semidex source code in this repository | Authoritative. Overrides every report. Cited by file path. |
| 2 | Semidex design/security docs in `docs/` that are themselves consistent with the code | Authoritative for intent; re-checked against code before being called "current". |
| 3 | External primary sources with a direct, canonical URL (spec, repo, vendor docs) | Usable as external fact, marked as not re-fetched in this pass. |
| 4 | Report-internal reasoning that does not assert a Semidex fact | Usable as a design argument on its merits. |
| 5 | Opaque research citations (`turn15search0`-style tokens), bare product names, assumed licenses, SEO listicles, interview-question pages, unverified screenshots | **Discarded.** Not repository-quality evidence. |

Tier-5 discards are not a formality. Report 01 carries roughly 90 `citeturn…`
tokens that resolve to nothing outside the tool that produced them; report 04's
source list includes `medium.com/…/frontend-framework-innovation-20-best-tools`,
`upgrad.com/blog/frontend-frameworks/`, `quartzdevs.com/…best-frontend-frameworks-2026`,
`goodspace.ai/interview-questions/lit` and `getclaudeskills.com/skills/…` as
support for architectural claims. Those citations were dropped and the
underlying claims re-evaluated on their own merits or rejected.

**Three-way fact separation.** Every claim below is filed as one of:
`[EXT]` external fact (tier 3), `[REPO]` repository-confirmed fact (tier 1–2),
or `[REC]` design recommendation. Section 8 collects the separation explicitly.

**One reviewer correction applies to the whole corpus.** Report 02 states that
`github.com/CodeNoob53/semidex` could not be found publicly and builds its
"Open questions" section on that premise. This is false: the repository is
public and is this working copy's own `origin`
(`https://github.com/CodeNoob53/semidex.git`). Every "must be verified against
the real code" caveat in report 02 — and the equivalent 18-row open-questions
table in report 01 §"Open questions" — was answerable by reading the code.

---

## 2. Comparison of the five reports

No score, no ranking. Each report has a distinct centre of gravity, and the
useful output is the union of four of them plus a hard filter.

| | 01 chatgpt | 02 claude | 03 deepseek | 04 gemini | 05 kimi |
|---|---|---|---|---|---|
| Length | 693 lines | 301 | 968 | 375 | 1168 |
| Centre of gravity | Contract/trust/lifecycle discipline | Threat model + license register | Breadth of analogues + concrete code | Framework advocacy + LLM-specific threats | Reference breadth + phase plan |
| Invents Semidex API? | No — refuses explicitly | No, but assumes a BFF | Yes (SSE event names, conversation CRUD) | Partially (SSE progress, provider fallback) | Yes (event names, heartbeat/reconnect, conversation CRUD) |
| Distinguishes fact vs recommendation? | Yes, per-row `Статус` column | Yes, per-row `Тип` column | No | Yes, per-recommendation table | Yes, in a closing methodology note |
| Licenses treated as a risk register? | Yes, most precise | Yes, second most precise | No (asserts "Dify Apache 2.0") | No | Partly (flags Open WebUI/Dify as non-OSI) |
| Weakest section | Length; some author guardrails read as requirements | Builds a whole architecture on a false "repo not found" premise | Threat table is generic; proposes stack traces in UI | Vector-inversion threat section is off-target for a UI | Invents the most protocol behaviour |

**Where all five agree** (and the repository supports them): operator console
over SaaS dashboard; keep Vite + ES modules rather than migrate a framework
"first"; centralized API client; `AbortController`-scoped lifecycle; bounded
stream parsing for Ask; frontend validation is not a security boundary; WCAG
2.2 AA; no bearer key in the browser.

**Where they diverge, and who is right:**

- *Framework.* 01/02/03/05 say stay vanilla; 04 recommends migrating the UI
  layer to Lit. 04's argument rests on tier-5 citations and asserts benefits Lit
  does not provide (see §5, `REJ-06`). 01's framing — spike only, after a
  representative vertical slice, judged on measured defect data — is the one
  adopted.
- *Event architecture.* 03 recommends a centralized event bus as the default;
  01 explicitly argues against an application-wide bus and for local DOM
  events/direct calls with a bus reserved for genuinely cross-cutting contracts;
  05 lands close to 01. 01 is adopted.
- *Delegation scope.* 02/04 phrase delegation as "one listener on the container
  instead of thousands"; 01 is the only report that names the correct scope —
  a stable owning view/component root, neither `document` nor per-row. 01 is
  adopted.
- *Cancellation.* Only 01 states that `AbortController` alone does not prevent a
  stale commit and pairs it with a request-generation/ownership check. Adopted.
- *Streaming accessibility.* 03/05 put the streaming container in
  `aria-live="polite"` and let it announce continuously; 05 additionally moves
  focus after completion. 04 proposes announcing only a final hidden block. 01
  proposes batched visual updates plus a separate status region announcing
  meaningful units. 01 is adopted; 05's focus move is rejected.
- *Virtualization.* 03 (>1000 rows), 04 ("must implement"), 05 (>100 rows) all
  make it a build requirement. 01 alone calls it a rendering optimization that
  must follow backend paging and a measured DOM bottleneck. 01 is adopted.
- *Trust model.* 02/03/05 and 04 all require a **separate** BFF process with
  cookie sessions; 01 describes the same shape but as a same-origin admin
  bridge. The repository already has the same-origin server; see `REJ-01`.

---

## 3. Unique useful findings, per report

Findings recorded here are ones that only one report produced and that survive
repository review.

**01 (chatgpt)**

- The distinction between *reference UX* and *reusable code* as two separate
  registers, with per-product license provenance attached to the second.
- Attu ≥ 2.6.0 moved to a proprietary license; older ≤ 2.5.12 files would need
  provenance review. No other report noticed this.
- Two independent state planes: `configuration/readiness` (configured →
  validating → ready/degraded/unavailable) and `operation state` (idle →
  pending → running/streaming → completed/failed/cancelled), with `partial` a
  first-class result rather than a flavour of success. This maps cleanly onto
  our real split between `GET /api/generation/status` (readiness, never an HTTP
  error) and `GET /api/operations` (operation state).
- The SSE test corpus (report 01, "SSE test corpus" block) — arbitrary chunk
  boundaries, split multibyte, CRLF/LF/CR, event without final blank line,
  unknown event, valid-then-malformed, duplicate terminal, disconnect at 0
  bytes, disconnect after partial answer, abort racing completion, old stream
  finishing after a new Ask, citation index out of range. This is the single
  most directly reusable artifact across all five reports.
- Build-time-compiled validators (Ajv standalone) as the CSP-compatible way to
  do runtime response validation: a runtime schema compiler needs `Function`
  construction, which our shipped `script-src 'self'` forbids. This is a real,
  non-obvious constraint that no other report identified.
- "Do not serialize Ask prompts / search text / paths into the URL" as an
  exposure decision (history, copy/paste, screen sharing), separate from any
  claim about how sensitive our data is.

**02 (claude)**

- The most careful license register per product, including the exact Open WebUI
  branding clause wording and the ≤50-users/30-day condition, and the note that
  Dify's license adds a multi-tenant restriction on top of Apache 2.0.
- The observation that Qdrant Web UI moved visualization server-side (Distance
  Matrix API) specifically to stop shipping raw vectors to the browser — a
  concrete "aggregate on the server" precedent.
- Explicitly labelling `draft-bertocci-oauth2-tmi-bff` as an individual
  Internet-Draft, not an approved RFC. Correct scepticism, even though the
  conclusion it supports is rejected here.

**03 (deepseek)**

- `rag-web-ui`-style async ingestion UX (submit → Job ID → status polling →
  Processing/Completed/Failed) named as the closest analogue to our indexing
  jobs. Our `GET /api/operations` already implements the server half of this.
- Langfuse's Table/Chart toggle and compact metric strip above a list. Recorded
  as future; there is no metrics API.
- The only report to state plainly that the admin UI has no multi-user model,
  which is correct today.

**04 (gemini)**

- `TextDecoder('utf-8', { stream: true })` named specifically for Cyrillic/emoji
  correctness at chunk boundaries. Our shipped SDK parser already does this
  (`packages/lite/lite-src/client/sse.js:85`, plus the terminal `decoder.decode()`
  flush at line 125) — the report independently arrived at the property our
  implementation has.
- Markdown-sanitization throughput as a main-thread risk during streaming, with
  batched DOM updates as the mitigation. Correct concern, correct direction.
- Middle-ellipsis for long paths with full-value copy — a small, concrete
  affordance for our very long `sourceFile` values.
- The only report to argue *against* telemetry for a local-first operator tool.

**05 (kimi)**

- The broadest reference set, including RAGFlow's citation-to-source-layout
  linking and n8n's scoped execution logs.
- A per-screen Definition of Done that includes Full/Lite parity as an explicit
  checkbox.
- Explicit "no Semidex capabilities were invented" claim in the closing note —
  which is, in fact, contradicted by its own §5.1, §9.2, §9.6 and Phase 4 (see
  `REJ-03`, `REJ-10`, `REJ-11`). Recorded because the failure mode is
  instructive: a self-declaration of restraint is not evidence of restraint.

---

## 4. What the repository actually is (tier-1 baseline)

This section exists because none of the five reports had it, and because every
decision in §5 depends on it.

**Route surface and audience metadata.** Every route must declare
`{ audience, operation, costClass, … }` at registration or registration throws
(`src/core/http/route-audience.js:136`, enforced in `src/shared/admin/router.js:66`).
`audience: integration` is the only surface the bearer-key policy runs on
(`src/shared/admin/router.js:198`); admin routes are deliberately credential-free
so a missing integration key cannot take down local administration.

*Integration surface (bearer):* `POST /api/v1/search`
(`src/core/search-api/v1/route.js:113`), `POST /api/v1/ask`, `POST /api/v2/ask`
(`src/core/ask-api/v2/route.js:200`).

*Admin surface (loopback, no credential):* `/api/health`, `/api/capabilities`,
`/api/settings` (GET/PATCH), `/api/collections` (+ `:name`, `sync-schema`,
DELETE), `/api/collections/:name/{documents,chunks,assembly,skeleton,
skeleton/node,skeleton/children,skeleton/anchor,node}`, `POST /api/search`,
`/api/generation/{status,models}`, `/api/jobs` (+ `index`, `:id`, `:id/cancel`),
`/api/operations` (+ `:id`), `POST /api/system/pick-folder`,
`POST /api/system/qdrant-cloud-probe`; Full-only: `GET /api/system/ollama-status`,
`POST /api/system/onnx-probe`, `GET /api/system/onnx-managed-runtimes`,
`GET /api/ollama-models`.

**Security already implemented at the server.** Host/DNS-rebinding validation
including duplicate-Host detection (`request-security.js:265`), cross-site
rejection combining `Sec-Fetch-Site` and exact-origin comparison
(`request-security.js:362`), JSON `Content-Type` enforcement
(`request-security.js:471`), and a uniform response header set — `CSP`
(`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`),
`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Vary` — applied to API *and* static responses (`request-security.js:535-567`).
HSTS is deliberately absent and the reason is documented in that same block.

**Integration auth.** Hashed key store with `collections` and `operations`
scopes (`operations` supports `generate` and `search` —
`src/core/auth/key-store.js:69`), collapsed 401 for every credential failure,
503 when no keys are configured, per-key token-bucket rate limiting as router
stage 1.5 (`src/shared/admin/router.js:291`), per-request and per-key aggregate
token budgets (`src/core/auth/token-budget.js`, `src/core/ask/budget-ledger.js`).

**Egress and filesystem policy.** `evaluateEgressUrl()` rejects non-`http(s)`
schemes, embedded userinfo, and well-known cloud-metadata literals, and
**deliberately does not block loopback/RFC1918/Docker addresses** — self-hosted
Qdrant/Ollama on those addresses is the supported shape
(`src/core/security/network-egress-policy.js:44-55`). `INDEX_ALLOWED_ROOTS` is
realpath-resolved and checked before any subprocess spawn
(`src/core/security/allowed-roots.js`, `src/shared/admin/api/jobs.js:264`).
Changing `QDRANT_URL`/`OLLAMA_URL` additionally requires a direct loopback
connection (`src/shared/admin/api/settings.js:17,52`).

**Settings redaction.** `GET /api/settings` returns a typed inventory; a
`secret` entry exposes only `configured: boolean` and never a value
(`src/core/settings/service.js:183-188`). Provenance is explicit
(`configuredSource`/`activeSource`/`pendingRestart`).

**Ask v2 wire contract.** `POST /api/v2/ask`, SSE events `sources`,
`answer_delta`, `done`, `error` (`src/core/ask-api/v2/contract.js:11`). The
server writes `: keep-alive` SSE comments every 15 s
(`src/core/http/sse.js:7,19`) and sets `X-Accel-Buffering: no`. There is **no**
`id:` field, no `Last-Event-ID` handling, and no resume semantics anywhere in
the transport. `conversation` is client-supplied and bounded by fixed protocol
constants (`request.js:41-44`: 50 000 chars/message, 200 recent messages, 8 000
chars summary, 256-char id) with roles restricted to `user`/`assistant`.
Semidex stores nothing between requests
(`docs/design/ask-v2-conversational-context.md` §1).

**Existing admin UI.** `src/shared/admin/ui-src/` — hash router
(`routes.js:23`), one fetch choke point (`api.js`), one shared mutable
(`state.js`), a single operation poller at 1500 ms active / 5000 ms idle
(`operation-store.js:16`), template-clone + `textContent` rendering
(`dom.js:18-32`), and a curated `unified`/`remark-gfm`/`highlight.js` structural
renderer (`structural-renderer.js`). Theme tokens are dark-only, amber-accented,
IBM Plex Mono/Sans (`app.css:6-24`); `:focus-visible` and
`prefers-reduced-motion` are already handled. **There is no Ask UI at all** — no
module under any `ui-src/` references `/api/v1/ask` or `/api/v2/ask`.

---

## 5. Decision register

Status vocabulary: **ACC** accepted; **ACC*** accepted with modification;
**REJ** rejected; **FUT** future capability, explicitly not current; **VER**
requires verification before it can be relied on.

### 5.1 Accepted

| ID | Decision | From | Rationale |
|---|---|---|---|
| ACC-01 | Operator console, resource-oriented IA; no SaaS card grid, no vanity metrics, no chat-first navigation | all five | Converges independently in five reports; consistent with `docs/design/admin-ui-ux-and-ask-plan.md` §3A, already shipped as sidebar + single content surface |
| ACC-02 | Split-pane workbench (list/table + context inspector) on Search, Documents, Operations, Ask | 01 | The existing file/section reader is already a two-surface layout; this generalizes it rather than replacing it |
| ACC-03 | Persistent global status region driven by real endpoints, colour never the only signal | 01, 02, 04, 05 | `GET /api/health` and `GET /api/generation/status` already return exactly the readiness shape needed |
| ACC-04 | Keep Vite + ES modules; architectural reset inside the current stack; no framework migration as a precondition | 01, 02, 03, 05 | No measured defect data justifies a rewrite; a migration would fork the UI while the old one must stay usable |
| ACC-05 | One centralized API client owning base URL, headers, timeout, `AbortSignal`, HTTP parsing, response validation, and a normalized error type | 01, 02, 03, 05 | `api.js` is already the single choke point; it currently lacks abort, timeout and validation |
| ACC-06 | Feature-owned modules; no feature writes into another feature's DOM; one owner per DOM subtree | 01, 02, 03, 05 | Directly addresses the current `router.js` ↔ `search.js` ↔ `file-view.js` coupling |
| ACC-07 | View-scoped `AbortController` covering both listeners (`addEventListener(…, { signal })`) and in-flight requests, released by an explicit `dispose()` | 01, 02, 04, 05 | Platform-native; no dependency |
| ACC-08 | Request generation/ownership check **in addition to** abort, before any commit to the DOM | 01 | Abort alone does not prevent a response that resolved before the abort from committing |
| ACC-09 | Event delegation at a stable owning view/component root — not `document`, not per row | 01 | The two extremes are both wrong; per-row listeners leak, document-wide listeners hide ownership |
| ACC-10 | Ask uses `fetch` + a bounded stream decoder, never `EventSource` | all five | Ask v2 is POST with a JSON body; `EventSource` is GET-only |
| ACC-11 | Every accumulator is bounded; bounds derived from protocol constants where they exist, otherwise labelled provisional | 01, 04, 05 | `request.js` already fixes message/summary/count ceilings that the client can mirror exactly |
| ACC-12 | Ask run state machine with `partial` and `refused` as first-class terminal states | 01 | `refused` is a real protocol outcome (`done` with `refused: true` + `refusalReason`), not an error |
| ACC-13 | Untrusted by default: `textContent` first, raw HTML off, only the explicitly supported Markdown subset rendered | 01, 02, 04 | Matches the existing `dom.js`/template discipline; CSP stays defence in depth, never the primary control |
| ACC-14 | Frontend validation is preflight/UX only; backend validation and policy are authoritative | all five | Already true structurally — the router validates before dispatch and before any body read |
| ACC-15 | Destructive confirmation names the resource, the consequence and requires typed confirmation for collection deletion | 01, 04, 05 | `DELETE /api/collections/:name` intentionally has no typed-confirmation body; the UI owns this |
| ACC-16 | Backend pagination/filtering and real API limits before any virtualization | 01 | Virtualization is a DOM optimization; it cannot fix a response that already loaded everything |
| ACC-17 | WCAG 2.2 AA as a per-screen acceptance gate, not a closing audit | 01, 02, 04, 05 | The existing UI already ships `:focus-visible` and reduced-motion handling; the gate formalizes it |
| ACC-18 | Streaming accessibility: batched visual updates + a separate status region announcing meaningful units; never announce every token, never steal focus on completion | 01 | Token-level announcement makes output unusable; a completion focus jump interrupts the operator |
| ACC-19 | Test gates: contract tests, an aggressive SSE corpus, security corpus, a11y scan, lifecycle/leak soak | 01, 02, 03, 05 | The SSE corpus in report 01 is adopted essentially verbatim |
| ACC-20 | Per-screen Definition of Done, checked before merge | 01, 02, 04, 05 | 01's is the most operational and becomes the base |
| ACC-21 | "Reference UX" and "reusable code" are separate registers; code import requires recorded provenance | 01, 02 | See §6 |
| ACC-22 | Composition driven by backend-supplied capability, not scattered edition checks | 01, 04 | Accepted as a principle; the endpoint to supply it does not exist yet — see `GAP-01` in the plan |

### 5.2 Accepted with modification

| ID | Report proposal | Modification | Rationale |
|---|---|---|---|
| ACC*-01 | "No bearer key in the browser" implemented via a new BFF process (02, 03, 05) or a new admin bridge component (01) | Keep the invariant; drop the new component. The existing same-origin admin server **is** the bridge | Admin routes never see an integration principal (`router.js:198`); the browser calls only admin routes and never holds a key. A new process, cookie session and CSRF token set would be new authentication surface with no current requirement |
| ACC*-02 | Mandate DOMPurify (02, 03, 04) | Sanitizer becomes a decision, not a default. Default is raw HTML off + template/`textContent`; a sanitizer is added only if a Markdown subset that needs one is actually shipped | The repository currently has no sanitizer dependency and no raw-HTML sink; adding one before there is HTML to sanitize adds a dependency and a false sense of coverage |
| ACC*-03 | Mandate Zod (02, 03, 05) or Ajv (01) for runtime validation | Validation is mandatory; the mechanism must not require runtime `Function` construction under `script-src 'self'`. Hand-written validators or build-time-compiled schemas only | 01's CSP observation is correct and is the deciding constraint |
| ACC*-04 | Provisional numeric guardrails (64 KiB line / 256 KiB event / 1 MiB buffer, 01; 1 MB/64 KB, 03/05) | Kept, but labelled provisional and superseded by protocol constants where they exist | `PROTOCOL_MAX_MESSAGE_CHARS`/`PROTOCOL_MAX_RECENT_MESSAGES` are real contract values; a guessed number should never override a known one |
| ACC*-05 | Full/Lite differences shown as disabled rows with an explanation (01, 05) rather than hidden | Adopted at **control granularity** — a field/option inside a screen this edition serves is disabled with a reason. It does **not** extend to whole screens whose routes the edition never registers; those are omitted from navigation, with edition disclosed globally. Also corrected: this is an *edition/capability* disclosure, not a switch the operator can flip | See `REJ-19`; plan §6 |

### 5.3 Rejected

| ID | Rejected claim | Where | Why |
|---|---|---|---|
| REJ-01 | A separate BFF/OAuth/HttpOnly-cookie-session process is required | 02 §9, 03 §9.5, 04 §6.3, 05 §9.8, 01 `R-BRIDGE` | The invariant it protects is already satisfied; see `ACC*-01`. Inventing a session system also invents CSRF-token machinery that the current cookie-free, Origin/Fetch-Metadata-checked design does not need |
| REJ-02 | "The Semidex repository could not be found publicly" | 02 §1 | False. `origin = https://github.com/CodeNoob53/semidex.git` |
| REJ-03 | Persistent conversation list with rename/delete, server-side conversation IDs, cross-session history | 03 §5.1/§9.1, 05 §4.1/§5.8/Phase 4 | Semidex is stateless between requests; `conversation.id` is a client-supplied correlation id echoed back, never a stored entity (`ask-v2-conversational-context.md` §1, `src/core/ask-api/v2/request.js:62`). → moved to `FUT-01` |
| REJ-04 | wouter as the router | 03 §7.1/§14 | React/Preact-oriented; not applicable to a vanilla ES-module UI |
| REJ-05 | Petite-Vue as the reactive layer | 05 §14.1 | Aimed at progressive enhancement, and its expression compiler uses `new Function()`, which the shipped `script-src 'self'` forbids |
| REJ-06 | Migrate the UI layer to Lit | 04 §5.1 | Rejected as a baseline. 04 credits Lit with "automatic cleanup on unmount" and "typing" — it provides neither: it does not cancel fetches, clear timers, or remove listeners registered on `window`/`document`, and it is not itself a type system. It remains available as a measured spike after a representative vertical slice |
| REJ-07 | Selecting a framework/reactive layer by counting report votes | implicit across the corpus | Four reports agreeing that they lack our defect data does not constitute data |
| REJ-08 | A centralized application-wide event bus as the default communication mechanism | 03 §8.1 (with a full implementation) | Makes the dependency graph invisible. Local DOM events and direct calls first; a bus only for genuinely cross-cutting, versioned contracts |
| REJ-09 | One listener on `document` / one listener per repeated row | 02 §8, 04 §5.2 (phrasing), 05 §8.1 | Both extremes rejected; see `ACC-09` |
| REJ-10 | Client heartbeat expectations, automatic reconnect, `Last-Event-ID`, resume, or automatic retry of a generation | 05 §9.2 ("client waits 60 s → reconnect"), 03 §9.3 ("timeout: automatic retry, max 3"), 01 (correctly warns against it) | The server emits `: keep-alive` comments (`src/core/http/sse.js:7`) — that is a transport liveness aid a client must *tolerate*, not a protocol to build reconnect on. There is no event `id:`, no resume, and Ask is not idempotent: a re-issued request re-runs retrieval and re-generates tokens, spending budget twice. Our own SDK enforces exactly this (`retry.js` header; `markCommitted()` in `index.js:528`) |
| REJ-11 | Automatic provider fallback on generation failure | 05 §9.6 | No such capability. One generation runtime resolves one provider per process (`src/core/generation/runtime.js`); a failure is reported as `dependency_unavailable`, not routed elsewhere |
| REJ-12 | Show stack traces in the admin error state | 03 §4.4 | Contradicts the redaction posture: `sanitiseErrorMessage()` is applied at every error boundary (`router.js:366`, `ask-api/v2/route.js:25`, `api/health.js:17`) precisely so raw messages carrying URLs/keys never reach a client |
| REJ-13 | Block private/internal IP ranges for Qdrant/provider destinations | 04 §8.4, 05 §11.6 | Directly contradicts the repository's destination policy, which permits loopback/RFC1918/Docker as the supported self-hosted shape (`network-egress-policy.js:44-48`) |
| REJ-14 | HSTS; browser certificate pinning; Unix chroot/jail as cross-platform requirements | 05 §11.3/§11.5/§11.9 | HSTS on a plain-HTTP loopback listener is a no-op at best and wrong at worst (documented at `request-security.js:528`); browsers do not expose certificate pinning to applications; the project targets win32 as a first-class platform |
| REJ-15 | Table virtualization as a build requirement | 03 §7.7, 04 §5.3, 05 §7.2 | See `ACC-16`. Also a measurable accessibility risk for keyboard/screen-reader users |
| REJ-16 | Arbitrary thresholds stated as requirements: 5 s job auto-refresh, 30 s first-chunk / 10 s inter-chunk timeouts, 1000-message cap, ≤100–200 DOM rows, Lighthouse > 90, > 80 % coverage, FCP < 1.5 s / TTI < 3.5 s | 03 §13/§15, 04 §9, 05 §9.5/§12.9/§13 | None derived from Semidex measurements. Our own poller already runs at 1500/5000 ms (`operation-store.js:16`) and disagrees with the proposed 5 s. Retained only as labelled provisional guardrails |
| REJ-17 | Calendar duration estimates ("11–15 weeks"; "2–3 weeks per phase") | 03 §15, 05 §15 | No repository-based evidence. The plan sequences vertical slices without calendar claims |
| REJ-18 | Treating Semidex integration keys as provider (OpenAI/Anthropic) credentials | 04 §6.3 | Two different things. A Semidex integration key authenticates a caller to *us*; provider credentials are settings we hold, exposed only as `configured: true/false` (`service.js:183`) |
| REJ-19 | A user-facing Full/Lite switcher in the global status area | 05 §3.2 | Edition is decided at composition/build time (`src/admin/composition/lite.js` vs `src/admin/server-full.js`) and cannot be toggled at runtime. Edition is *disclosed*, never *selected* |
| REJ-20 | "Lite has limited sparse embeddings" / weaker retrieval | 05 §3.2 | Lite retrieval is hybrid dense + sparse via Qdrant Cloud Inference (`packages/lite/README.md:16-17,121,234`) |
| REJ-21 | MCP server management as an admin screen; "MCP = Full-only feature row" as a UI concern | 03 §3.3, 05 open question 8 | Lite genuinely ships no MCP server (`packages/lite/README.md:163`) and that part is correct — but neither edition exposes any MCP management API, so there is nothing for a screen to talk to. → `FUT-11` |
| REJ-22 | Vector/embedding-inversion (OWASP LLM08) as a frontend requirement | 04 §8.3 | The proposed frontend mitigation ("do not display raw vectors") is vacuous here: no admin endpoint returns raw vectors at all. The backend concern is real but out of scope for this UI |
| REJ-23 | "No Semidex capabilities were invented in this report" | 05 closing note | Contradicted by that same report's conversation CRUD, reconnect protocol and provider fallback. Recorded so the claim is not carried forward as verification |

### 5.4 Future (explicitly not current capability)

| ID | Capability | Blocking reason |
|---|---|---|
| FUT-01 | Conversation persistence (list, rename, delete, server-owned ids, cross-session history) | No storage layer; a deliberate product decision (`ask-v2-conversational-context.md` §1, §11) |
| FUT-02 | File upload / drag-and-drop indexing | `POST /api/jobs/index` accepts a server-side local path only and explicitly rejects URL-shaped inputs (`api/jobs.js:57-65`); there is no upload endpoint |
| FUT-03 | System-log screen | No log API. Job logs exist but are capped at the last 200 lines of one job (`api/jobs.js:24,225`) |
| FUT-04 | Command palette (Ctrl/Cmd-K) | Independent; genuinely useful; not a foundation |
| FUT-05 | Cross-collection / global search | Both search routes are single-collection by contract |
| FUT-06 | Collection create/configure UI | No create endpoint; collections come into existence via an indexing job |
| FUT-07 | Generic "test this URL before saving" for Qdrant/Ollama/provider settings | Probes exist (`/api/health`, `/api/system/qdrant-cloud-probe`, Full-only `/api/system/{ollama-status,onnx-probe}`) but none tests an *unsaved candidate* value |
| FUT-08 | Job retry | Only cancel exists (`POST /api/jobs/:id/cancel`). "Retry" would be a new indexing job with the same parameters, and must be labelled as such if offered |
| FUT-09 | Multi-user, roles, profile, RBAC | No admin authentication exists at all today |
| FUT-10 | Telemetry / usage analytics | Rejected on principle for a local-first operator tool (04 §12.1); recorded as a decision, not an omission |
| FUT-11 | MCP management UI | No MCP management API |
| FUT-12 | Ask-run trace/timeline view (Langfuse-style) | Only `timing.elapsedMs` is returned; there is no per-stage timing contract |
| FUT-13 | Correlation id surfaced to the client | `requestId` exists and reaches the audit sink (`router.js:113`) but is never emitted as a response header; our own SDK reads `x-request-id` and always gets `null` (`client/index.js:215`) |
| FUT-14 | Capability/edition manifest endpoint | `GET /api/capabilities` returns *storage* capabilities only (`capabilities.js:6`); route `edition` metadata exists in-process (`route-audience.js:103`, `router.listRoutes()`) but is not served |
| FUT-15 | History-API routing | `handleStatic()` has no SPA fallback: an unknown path 404s (`static.js:72`). History routing would break deep-link reload without a server change |
| FUT-16 | uk/en localization of the admin UI | No i18n layer exists; all four reports that raise it are describing a new subsystem |
| FUT-17 | Metrics/dashboard widgets, Table/Chart toggle, vector visualization | No metrics API |

### 5.5 Requires verification

| ID | Claim | Status |
|---|---|---|
| VER-01 | Licenses of every reference product (§6) | Reports contradict each other on Open WebUI, Dify, Sentry and Weaviate. Must be verified per file/version before any code is imported |
| VER-02 | Visual/screenshot evidence for every reference product | **None of the five reports produced a verified screenshot.** All visual claims are textual reconstruction |
| VER-03 | Liveness and content of the external URLs in §6 | Carried over from the reports in canonical form; not re-fetched during this synthesis |
| VER-04 | Popularity/corporate claims (star counts, "ClickHouse acquired Langfuse 2026-01-16", "Supabase bulk editing preview 2026-02", "Langfuse Agent Graph beta 2026-07") | Unverified and design-irrelevant. Do not carry into the plan |
| VER-05 | Browser Local Network Access / CORS-RFC1918 preflight behaviour (04 §8.1) | Spec has churned repeatedly; must never be treated as a control. Our Host allow-list is the actual defence |
| VER-06 | Every performance number | Must be measured against real collection sizes on reference Full and Lite hardware before becoming a gate |
| VER-07 | Whether the browser bundle can import `packages/lite/lite-src/client/sse.js` without violating the Lite package's closure rules | Decides whether the Ask UI reuses the SDK's parser or restates it. See the plan's §9 |

---

## 6. Primary-source reference catalogue

Only direct, canonical URLs are retained. Bare product names, SEO listicles,
interview-question pages and opaque research tokens were dropped. **License and
provenance columns are `VER-01` until independently confirmed; the disagreement
column records where the reports contradict each other, which is itself the
finding.**

| Product | Canonical URL(s) | License as reported | Report disagreement | Use |
|---|---|---|---|---|
| Qdrant Web UI | `https://github.com/qdrant/qdrant-web-ui`, `https://qdrant.tech/documentation/web-ui/` | Apache-2.0 (all five agree) | none | Design inspiration + the only broadly agreed candidate for code reference. React — ideas, not components |
| Langfuse | `https://github.com/langfuse/langfuse`, `https://langfuse.com` | MIT core; 01 adds "except `ee`, `web/src/ee`, `worker/src/ee`" | 03/05 say plain MIT | Drill-down/detail-inspector pattern. Code reference only within MIT paths, after provenance check |
| AnythingLLM | `https://github.com/Mintplex-Labs/anything-llm`, `https://anythingllm.com` | MIT (all agree) | none | Provider-configuration and local-scope disclosure patterns |
| Supabase / Studio | `https://github.com/supabase/supabase`, `https://supabase.com/dashboard` | Apache-2.0 | none | Dense list/detail/editor surfaces. Strongest density reference |
| Open WebUI | `https://github.com/open-webui/open-webui`, `https://openwebui.com` | 02: BSD-3-Clause + branding clause; 04: MIT; 05: custom non-OSI; 01: multi-license | **Direct contradiction** | **Design inspiration only.** Not simply MIT. No code import without file-by-file provenance |
| Dify | `https://github.com/langgenius/dify`, `https://dify.ai` | 01/02/05: modified Apache-2.0 with additional conditions; 03: plain Apache-2.0 | **Direct contradiction** | Design inspiration only (retrieval-testing surface). 03's reading is the unsafe one |
| Sentry | `https://github.com/getsentry/sentry`, `https://sentry.io` | 01: FSL-1.1-Apache-2.0 with future grant; 03: BSL 1.1; 05: BSL → Apache after 3 years | **Direct contradiction; version-dependent** | Design inspiration only. Requires version/file provenance for anything else |
| Attu (Milvus) | `https://github.com/zilliztech/attu` | 01: Apache-2.0 up to 2.5.12; proprietary from 2.6.0 | Only 01 raises it | Design inspiration only. Current code is off-limits |
| Weaviate Console | `https://docs.weaviate.io/cloud`, `https://console.weaviate.cloud` | 03: BSD-3-Clause; 01: no public repo located for the Cloud Console specifically | **Contradiction** | Design inspiration only |
| RAGFlow | `https://github.com/infiniflow/ragflow` | Apache-2.0 (05) | single source | Citation-to-source linking pattern |
| VectorAdmin | `https://github.com/Mintplex-Labs/vector-admin` | MIT (03) | single source | Multi-backend admin pattern; low priority |
| n8n | `https://github.com/n8n-io/n8n` | Sustainable Use License (05) | single source | Execution-log pattern only; license precludes code reuse |
| Grafana | `https://github.com/grafana/grafana` | AGPL-3.0 (05) | single source | Design inspiration only; AGPL precludes reuse here |
| rag-web-ui | `https://github.com/rag-web-ui/rag-web-ui` | not stated (03) | unverified | Async ingestion → job id → polling pattern |
| chromadb-admin (community) | referenced by 01 as a community project | unverified | — | Minimal-benchmark only |

**Standards and platform references retained** (canonical form; `VER-03`):
`https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy`,
`https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model/Events`,
`https://github.com/cure53/DOMPurify`,
`https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html`,
`https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/`,
`https://owasp.org/www-community/attacks/Path_Traversal`,
`https://wicg.github.io/local-network-access/` (see `VER-05`),
`https://github.blog/security/application-security/dns-rebinding-attacks-explained-the-lookup-is-coming-from-inside-the-house/`,
`https://nodejs.org/api/fs.html#fsrealpathsyncpath-options`,
`https://github.com/whatwg/encoding/issues/184`.

The WHATWG HTML server-sent-events section, the DOM standard's `AbortSignal`
listener option, WCAG 2.2 and the WAI-ARIA Authoring Practices Guide are all
relied on in the plan; reports 01, 02 and 05 cite them by name but several of
those citations arrived as tier-5 tokens rather than URLs, so they are recorded
here as named standards to be linked from their canonical W3C/WHATWG locations
when the plan's accessibility and streaming sections are implemented.

**Provenance rule adopted (`ACC-21`).** A product may inform the design with no
license consequence. Importing code requires: a named repository, a named
license *for the specific version and path*, and a recorded provenance note in
the implementing PR. Apache-2.0/MIT products still require notice retention.

---

## 7. What the reports did not cover well

1. **The repository itself.** Zero of five inspected it. Report 01's own
   18-row "open questions that block precise production design" table is a
   complete inventory of things the code answers directly: the admin
   authentication model (there is none, by design), the Ask v2 wire protocol,
   its hard limits, whether resume exists (no), what the conversation API
   returns, which job actions exist (cancel only), collection naming rules,
   filesystem root semantics, whether upload exists (no), the destination
   policy, and how secrets are stored.

2. **Screenshot-level visual evidence.** None. Every "dense 32 px rows",
   "Material-UI padding is excessive", "Linear-style whitespace grouping" claim
   is textual reconstruction. This synthesis and the plan both state plainly
   that they do **not** substitute for looking at the products.

3. **Exact current API contracts.** Reports 03 and 05 invented SSE event names
   (`complete`, `refused`, plain `data` events) that do not exist; our events
   are `sources` / `answer_delta` / `done` / `error`, and refusal is a *field*
   on `done`, not an event. Report 04 assumed indexing progress streams over
   SSE; it is polled JSON (`GET /api/operations`).

4. **What is already implemented.** Large parts of every threat model — Host
   validation, Origin/Fetch-Metadata, CSP, `frame-ancestors 'none'`,
   `X-Frame-Options`, `nosniff`, secret redaction, path-scope enforcement,
   audit logging, integration rate limiting and token budgets — already ship.
   Recommending them as new work obscures the gaps that are real.

5. **The remaining gaps.** Correspondingly under-described: no admin
   authentication of any kind; no per-caller rate limit on the admin surface
   (request *size* is already bounded — every body-reading route uses
   `readJsonBody`'s 1 MB default, `src/core/http/http.js:87`); residual TOCTOU
   between the allowed-roots realpath check and
   the indexer's own file access; `settings.json` permissions unaddressed on
   Windows by explicit decision; the two named residual RAG risks
   (`docs/security/rag-prompt-injection-threat-model-2026-08.md`) — citation
   presence is not semantic grounding, and body text can visually forge an
   evidence header.

6. **The existing UI as a working system.** No report mentions the skeleton
   navigation tree, the assembly/stitched reader, the structural (table/code)
   renderer with its rendered/raw toggle, the shared operation store and modal,
   or the global settings screen — all shipped, all covered by tests under
   `tests/unit/admin/ui-*.test.js`. Four reports implicitly treat the current UI
   as an unstructured prototype. It is not; it is a partly-built version of the
   IA they are recommending.

7. **Accessibility beyond boilerplate.** Only report 01 correctly handles the
   hard case (streaming announcements). The rest restate WCAG success criteria
   without mapping them to a specific surface.

---

## 8. Fact separation

| Claim | Class | Source |
|---|---|---|
| `EventSource` is GET-only and cannot carry a request body or custom headers | `[EXT]` | WHATWG HTML SSE section, cited by 01/02/04 |
| `TextDecoder(…, { stream: true })` is required to avoid splitting multibyte sequences at chunk boundaries | `[EXT]` | WHATWG Encoding; independently confirmed by our own parser at `packages/lite/lite-src/client/sse.js:85` |
| `addEventListener(…, { signal })` removes a listener on abort | `[EXT]` | DOM standard |
| CSP `frame-ancestors` must be delivered as a header, not a `<meta>` tag | `[EXT]` | 02 §11.7; consistent with our header-only delivery |
| Open WebUI's current license is not plain MIT | `[EXT]`, `VER-01` | 01/02/05; 04 disagrees |
| Sentry's license depends on version and file | `[EXT]`, `VER-01` | 01/05 |
| Ask v2 is `POST /api/v2/ask` with SSE events `sources`/`answer_delta`/`done`/`error` | `[REPO]` | `src/core/ask-api/v2/contract.js:9,11` |
| Refusal is `done` with `refused: true` + `refusalReason`, not a separate event | `[REPO]` | `contract.js:110-139`, `route.js:149` |
| Server emits `: keep-alive` SSE comments every 15 s; no `id:`, no resume | `[REPO]` | `src/core/http/sse.js:7,19,87` |
| `conversation` is client-supplied, bounded, and never stored | `[REPO]` | `ask-api/v2/request.js:41-44,62`; `docs/design/ask-v2-conversational-context.md` §1 |
| Only `user`/`assistant` roles are accepted in history | `[REPO]` | `request.js:110` |
| Admin routes are credential-free and never see an integration principal | `[REPO]` | `src/shared/admin/router.js:198` |
| CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Vary` ship on API and static responses | `[REPO]` | `src/core/http/request-security.js:535-567` |
| HSTS is deliberately absent | `[REPO]` | same file, line 528 comment |
| Private/LAN/Docker destinations are deliberately permitted | `[REPO]` | `src/core/security/network-egress-policy.js:44-48` |
| Secret settings expose only `configured: boolean` | `[REPO]` | `src/core/settings/service.js:183-188` |
| Integration key scopes support `generate` and `search` | `[REPO]` | `src/core/auth/key-store.js:69` |
| No collection-create, upload, job-retry, capability-manifest or log endpoint exists | `[REPO]` | `api/collections.js`, `api/jobs.js`, `api/health.js:34` |
| No `X-Request-Id` response header is emitted anywhere | `[REPO]` | repository-wide search; `client/index.js:215` reads it and gets `null` |
| Static serving has no SPA history fallback | `[REPO]` | `src/shared/admin/static.js:72` |
| There is no Ask UI in the admin dashboard today | `[REPO]` | no `ui-src` module references either ask route |
| Current UI theme is dark-only, amber-accented, IBM Plex | `[REPO]` | `src/shared/admin/ui-src/app.css:6-24` |
| Operator console + split-pane workbench is the right visual direction | `[REC]` | synthesis of 01/02/03/04/05 |
| Stay on Vite + ES modules; Lit is at most a post-slice spike | `[REC]` | 01, modified |
| Request-ownership checks must accompany abort | `[REC]` | 01 |
| Delegation belongs at a stable owning root | `[REC]` | 01 |
| Batched streaming updates + separate status announcements | `[REC]` | 01 |
| Backend paging before virtualization | `[REC]` | 01 |
| The initial Ask experience should be ephemeral | `[REC]` | this synthesis; an explicit product/security choice aligned with `[REPO]` server statelessness, not forced by it |

---

## 9. Carry-forward

The design plan (`admin-dashboard-v2-plan-2026-08-29.md`) consumes this register
directly: everything marked ACC/ACC* becomes a design constraint, everything
marked REJ is absent from it by construction, everything marked FUT appears only
in its API-gap register, and everything marked VER is listed as a precondition
rather than a decision.
