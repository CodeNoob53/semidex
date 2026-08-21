# semidex-lite

[Українська версія](./README.uk.md)

> [!IMPORTANT]
> **Package status: early MVP.** The previous README was a generated
> placeholder and did not describe the complete purpose, functionality, or
> limitations of `semidex-lite`. The package was initially published for
> personal use, npm distribution testing, and validation of Semidex's cloud
> profile. Its current feature set is limited, APIs and behavior may change,
> and production-ready stability is not guaranteed. Use it cautiously, do not
> rely on it for critical systems, and evaluate it against your own data and
> requirements.

**semidex-lite is the cloud edition of
[semidex](https://github.com/CodeNoob53/semidex), a flexible RAG system for
building knowledge bases from your own documents.** It indexes documents,
finds relevant passages through hybrid search, and generates grounded answers
with source references. semidex-lite uses Qdrant Cloud for storage and
embedding inference, Gemini for answer generation, and provides an HTTP Ask
API, an indexing CLI, and a compact admin dashboard.

### The document-to-answer pipeline included in the package

`semidex-lite` is more than an Ask endpoint or a thin Qdrant client. It runs the
complete cloud RAG path from source documents to grounded answers:

```text
documents
  -> parsing and structure-aware chunking
  -> deterministic context and structural inventory
  -> Qdrant Cloud embedding inference
  -> Qdrant dense + sparse indexing
  -> hybrid retrieval
  -> Gemini answer with source references
```

Markdown is processed with skeleton-first chunking: heading hierarchy and
structural entities such as tables, code blocks, and checklists remain
inspectable instead of being treated as one flat text stream. Navigation nodes
receive a deterministic inventory even when optional LLM summaries are not
used. PDF, plain-text, and supported Pandoc-convertible inputs use the package's
non-Markdown ingestion path and do not yet provide the same structural fidelity
as Markdown.

## What to use semidex-lite for

The package can serve as a cloud RAG core for applications that need to search
their own documents and answer questions from them. Example uses include:

- a documentation or support assistant for a website;
- a Telegram bot or an assistant for another communication channel;
- search and Ask for an internal team or organization knowledge base;
- an educational or research assistant working with private materials;
- a retrieval component in a larger agent system or specialized product.

`semidex-lite` handles indexing, relevant-evidence retrieval, and the Ask
cycle — including, for multi-turn conversations, computing a bounded rolling
summary (`/api/v2/ask`, see [below](#backend-integration-multi-turn-ask-apiv2ask))
when asked to. An application built around it owns everything about the
conversation itself: its own interface, authentication, the full message
history, persisting the summary Semidex returns and applying the compaction
boundary it confirms, memory beyond a single conversation, additional tools,
and business rules. Integrate through the HTTP Ask API behind your own
backend; the current admin server is not intended to be exposed directly to
the public Internet.

The Ask system prompt in this MVP is internal and cannot be changed through the
public API or settings. An outer application can manage context before and
after an Ask call, but changing Gemini's internal instructions currently
requires modifying or forking the package source. A configurable system prompt
may be introduced later, but it is not part of the current public contract.

## How semidex-lite differs from full semidex

| | semidex | semidex-lite |
|---|---|---|
| Storage | Qdrant (local or Cloud) | Qdrant Cloud only |
| Embeddings | Ollama, local ONNX (BGE-M3), or Qdrant Cloud Inference | Qdrant Cloud Inference only |
| Answer generation | Ollama or Gemini | Gemini only |
| Chunk context for non-Markdown files | LLM-generated (Ollama) | Deterministic heading/section text with no LLM calls |
| Tag generation and combined LLM pass | Supported through Ollama or local ONNX | Not available |
| CUDA/DirectML hardware probes | Supported | Not available |
| Package size and install footprint | Includes `onnxruntime-node` and `@huggingface/transformers` | Includes neither, making installation smaller and faster |

Everything else, including hybrid dense+sparse retrieval, deterministic
reranking, skeleton-first Markdown chunking, PDF/Pandoc support, the Ask API,
collection browsing, and dashboard search, works in the same way.

> [!NOTE]
> Full `semidex` is currently available as source code in the
> [GitHub repository](https://github.com/CodeNoob53/semidex), but is not yet
> published as a separate ready-to-use npm package. That package is planned
> after broader testing, installation stabilization, and implementation of
> critical functionality. Until then, install `semidex-lite` from npm and run
> the full edition directly from its repository.

## Installation

### Install in a project (recommended)

```bash
npm install semidex-lite
```

This adds the package to the current project's dependencies and records its
version in `package.json` and the lockfile. It is the recommended option for
applications, containers, servers, and reproducible deployments because each
project uses its own defined `semidex-lite` version.

Run the locally installed CLI through `npx`, for example
`npx semidex-lite doctor`. All commands and their purposes are listed in the
[CLI](#cli) section.

### Install globally (optional)

```bash
npm install -g semidex-lite
```

A global installation adds `semidex-lite` to the system `PATH`, allowing it to
run from any directory without `npx`. This is convenient for personal use on
one computer, educational or research experiments, and manual work with your
own collections. A global version is not pinned per project, so local
installation is preferable for integrations and deployments.

> [!NOTE]
> The current `semidex-lite` package **does not include an MCP server**. It
> provides the HTTP Ask API for integration with websites, bots, and other
> applications. The MCP server is currently available only in full
> [semidex](https://github.com/CodeNoob53/semidex).

semidex-lite never writes into its own installation directory, so it works
with read-only `node_modules/`. All state, including configuration, settings,
and tokenizer cache, is stored in a per-OS application data directory. See
[`SEMIDEX_HOME`](#semidex_home).

## Configuration

Create a `.env` file in the directory from which you will run
`semidex-lite`, then configure:

- `QDRANT_URL`, `QDRANT_KEY` for your Qdrant Cloud cluster;
- `GEMINI_API_KEY` for Ask and generation. It is optional at startup:
  `serve`, `doctor`, and `index` work without it, but Ask requests fail until
  the key is configured.

```bash
QDRANT_URL=https://your-cluster-id.your-region.cloud.qdrant.io
QDRANT_KEY=your-qdrant-cloud-api-key
GEMINI_API_KEY=your-gemini-api-key
```

The package ships a fully-commented `.env.example` covering all optional
settings too, including `QDRANT_CLOUD_DENSE_MODEL`, `ASK_MODEL`,
`ADMIN_HOST`/`ADMIN_PORT`, the Ask v2 compaction settings, and
`SEMIDEX_HOME`. If you installed `semidex-lite` as a project dependency
(`npm install semidex-lite`), that file is at
`node_modules/semidex-lite/.env.example` — there is no copy of it at your
own project root — so either open it there to see every option, or start
from the minimal block above and add options from this README as needed.

Credentials are currently configured outside the dashboard. Add them to a
local `.env` file or operating-system environment variables before starting
`semidex-lite`. OS environment variables take precedence over `.env` values.
The dashboard reports whether credentials are configured, but the current
version cannot add, reveal, or replace `QDRANT_URL`, `QDRANT_KEY`, or
`GEMINI_API_KEY`.

Example for the current PowerShell session:

```powershell
$env:QDRANT_URL='https://your-cluster.cloud.qdrant.io'
$env:QDRANT_KEY='your-qdrant-api-key'
$env:GEMINI_API_KEY='your-gemini-api-key'
npx semidex-lite serve
```

Values set this way apply only to that PowerShell process and programs started
from it. For project-local configuration, prefer a `.env` file excluded from
version control. Never commit API keys.

At startup, semidex-lite unconditionally pins its cloud configuration,
including `DENSE_PROVIDER`, `SPARSE_PROVIDER`,
`SEMIDEX_GENERATION_BACKEND`, `CONTEXT_MODE`, and local-runtime toggles. A
stray local-provider variable left in a full-semidex `.env` cannot re-enable
local code. The Settings API and indexing-job API also reject attempts to
change these values at runtime.

### Qdrant Cloud embedding models

semidex-lite retrieves through two separate vector channels, both computed by
Qdrant Cloud Inference:

- a **dense** model, used for semantic (meaning-based) search;
- a **sparse** model, which adds lexical/keyword retrieval — exact terms,
  identifiers, and other matches that a purely semantic embedding can miss.

`qdrant_search`-style retrieval in semidex-lite is always hybrid: it queries
both channels and combines the results, rather than choosing one or the
other.

The table below lists every model in the current catalog. Only `supported`
models can actually be selected in this version — `dedicated`/`planned`
entries are real, live-verified Qdrant Cloud model IDs, but semidex-lite has
no per-cluster tier detection yet, so they are never selectable and never
used, regardless of what your Qdrant Cloud plan supports.

| Model | Type | Dimensions | Context window | Availability | Notes |
|---|---|---|---|---|---|
| `intfloat/multilingual-e5-small` | dense | 384 | 512 tokens | supported (free tier) | Multilingual (100+ languages, including Ukrainian) |
| `sentence-transformers/all-minilm-l6-v2` | dense | 384 | 256 tokens | supported (free tier) | English-tuned; usable but not optimized for other languages |
| `qdrant/bm25` | sparse | n/a | n/a | supported (free tier) | The only sparse model this build can currently select |
| `mixedbread-ai/mxbai-embed-large-v1` | dense | 1024 | unknown | **planned** (dedicated cluster tier) | Not selectable in this version |
| `prithivida/Splade_PP_en_v1` | sparse | n/a | 128 tokens | **planned** (dedicated cluster tier) | English only; not selectable in this version |

#### Configuring the dense model

Set the dense model for **new** collections with:

```bash
QDRANT_CLOUD_DENSE_MODEL=intfloat/multilingual-e5-small
```

See [Configuration](#configuration) above for how `.env` and OS environment
variables are loaded and prioritized.

#### The sparse model

There is currently only one `supported` sparse model, `qdrant/bm25`, and no
user-facing choice between multiple sparse models. An advanced,
`QDRANT_SPARSE_MODEL` environment variable exists in the codebase for
forward compatibility. When it is unset, Semidex Lite defaults to
`qdrant/bm25`. Setting it to any model that is not marked as `supported`
causes new-collection profile resolution to fail instead of silently falling
back to BM25. The Settings UI shows the active sparse model as read-only
because no second `supported` sparse model exists yet.

#### Choosing the dense model from the dashboard

Open the dashboard (`npx semidex-lite serve`, then
`http://127.0.0.1:8642`) and go to Settings → Embeddings. The "Dense model
(Qdrant Cloud)" field lists every `supported` dense model from the table
above, labeled with its dimensions and context window. It applies to newly
created collections — changing it does not affect collections that already
exist (see [Collection lifecycle](#collection-lifecycle-and-changing-models)
below). Qdrant/Gemini credentials (`QDRANT_URL`, `QDRANT_KEY`,
`GEMINI_API_KEY`) cannot currently be added, revealed, or replaced from the
dashboard — see [Configuration](#configuration) above. No dashboard setting
in this section requires a `semidex-lite serve` restart to take effect.

#### Collection lifecycle and changing models

- The dense/sparse model active at the time a collection is first created is
  recorded in that collection's own embedding-profile metadata in Qdrant.
- Search against a collection automatically uses that collection's own
  recorded profile — never the current global default, and never a model or
  vector dimension other than the one the collection was created with.
- Changing `QDRANT_CLOUD_DENSE_MODEL` (or the dashboard equivalent) only
  affects collections created **after** the change. It never rewrites an
  existing collection's profile or its stored vectors.
- To move an existing collection to a different model, create a new
  collection under the new model and reindex your source documents into it
  (a controlled, full reindex) — there is no in-place model migration.
- Do not edit a collection's vector size or embedding-profile metadata by
  hand. It is derived entirely from the model that created the collection,
  and search depends on it matching the real underlying vector schema.

#### Verifying Cloud Inference works

```bash
npx semidex-lite doctor --probe-inference
```

This performs a real, minimal embedding round-trip against Qdrant Cloud
Inference: it creates a disposable collection, embeds with it, and deletes
the collection immediately afterward. See [`doctor`](#doctor) below for the
full command description.

#### Picking a model

- Ukrainian or other multilingual documents: `intfloat/multilingual-e5-small`
  (E5 Small).
- Primarily English documents, especially with shorter chunks: either model
  works; `sentence-transformers/all-minilm-l6-v2` (MiniLM) is tuned for
  English but has a smaller context window (256 tokens).

Neither model is established as generally "better" — no benchmark comparing
them for this use case exists yet. Pick based on your document language and
verify results against your own data.

## Security status

> [!IMPORTANT]
> **The Integration Ask API is authenticated, but the Admin API is not.**
> Read this section before making any part of `semidex-lite serve` reachable
> beyond your own machine.

What is protected as of this version:

- **Loopback-only by default.** The server binds `127.0.0.1` and refuses a
  non-loopback `ADMIN_HOST` unless you set `ADMIN_ALLOW_REMOTE=1`.
- **Cross-site browser requests are rejected.** Requests a browser marks as
  cross-site (`Sec-Fetch-Site`), or that carry a foreign/opaque `Origin`, are
  refused before any route logic runs. This closes a real issue in earlier
  versions where a page on another site could silently make your running
  instance start an indexing job, run billed Ask/search requests, or change
  collection state — the browser blocked the attacker from *reading* the
  response, but the work still happened.
- **JSON endpoints require `Content-Type: application/json`.** Anything else
  with a body is rejected with `415` before parsing.
- **Host header is validated** against the loopback host/port (or your
  `ADMIN_ALLOWED_HOSTS` list), which blocks DNS-rebinding attacks.
- **Ask v1/v2 require a bearer key.** Integration keys carry explicit
  operation and collection scopes; a missing, expired, revoked, or
  out-of-scope key is rejected before Qdrant or Gemini work begins. With no
  keys configured, the Integration API fails closed with `503`.
- **Ask is rate limited per key.** Both Ask versions share the same token
  bucket for a key. See [Rate limiting](#rate-limiting) below.
- **`QDRANT_URL` cannot be pointed at a cloud-metadata address, and changing
  it over HTTP requires a direct loopback connection.** Every Qdrant client
  construction rejects a non-`http(s)` scheme, embedded userinfo, or a
  well-known cloud-metadata literal (`169.254.169.254` and its documented
  IPv6 forms, `metadata.google.internal`) before any network call. Separately,
  `PATCH /api/settings` accepts a `QDRANT_URL` change only from a direct
  loopback connection to this process — independent of `ADMIN_ALLOW_REMOTE`
  — so a remote caller of an exposed Admin API cannot silently redirect
  Semidex at an attacker-controlled Qdrant endpoint. This does not block
  loopback, LAN, RFC1918, or Docker-internal addresses; self-hosted Qdrant on
  those addresses is a normal, supported target, not a risk this check
  guards against. See the linked audit's §12j for the full scope and its
  limitations.
- **Dashboard/API indexing is scoped to operator-approved directories.**
  `POST /api/jobs/index` resolves the requested path through the real
  filesystem and accepts it only inside `INDEX_ALLOWED_ROOTS`. With no roots
  configured, HTTP/dashboard indexing is disabled. Direct trusted CLI
  indexing is intentionally unaffected.
- Request-ingestion timeouts and header-count ceilings are set.
- **Every response carries security headers**, including a
  `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, and `X-Content-Type-Options: nosniff` — API, static
  dashboard, and error responses alike.
- **Cache-Control is route-aware and fail-safe.** Every `/api/**` response
  (success, error, and the streamed Ask endpoints) is `no-store`. The
  dashboard's HTML shell is also `no-store` — it can reflect security- and
  config-sensitive state, and this server issues no `ETag`/`Last-Modified`
  for a browser to revalidate against, so "never store a copy" is simpler
  and safer than a weaker directive. Only a fingerprinted, content-hashed
  build asset (`/assets/<name>-<hash>.js`/`.css`) gets long-lived
  `immutable` caching, and only once it has actually been served from disk
  — a request for a nonexistent path that merely *looks* fingerprinted
  still gets `no-store`. `Strict-Transport-Security` is intentionally not
  set: this server is plain HTTP by default, and HSTS on a non-HTTPS
  listener is a no-op at best (a TLS-terminating reverse proxy should set
  it itself).
- **`settings.json` is written with restrictive permissions (`0600`) on
  POSIX**, including when replacing an older, more permissive file. Windows
  has no equivalent — see the linked audit for the exact limitation.

What is **not** protected yet — the important part:

- **The Admin API has no authentication or authorization.** Any process on
  the machine can call dashboard, settings, indexing, collection-management,
  and unversioned `/api/search` routes, including destructive ones. Bearer
  keys protect only `POST /api/v1/ask` and `POST /api/v2/ask`; they do not
  turn the Admin API into a remotely safe management surface.
- **Admin routes have no per-caller collection scoping.** Integration keys
  restrict Ask to their exact collection scopes, but Admin routes retain the
  local operator's full access to every configured collection.
- **No rate limiting on the Admin API.** `/api/search` and every other admin
  route are unbounded. Ask rate limiting protects only the Integration
  surface, not the admin/dashboard one.

Practical guidance: treat the Admin surface of `semidex-lite serve` as a
**local, single-trusted-user service**. For a website, bot, or assistant, call
the authenticated Ask API from your own backend and keep end-user identity
and authorization there. If a reverse proxy is used, expose only the required
versioned Ask endpoints; never forward the whole Admin port to the internet
or an untrusted LAN.

For the full analysis, route-by-route inventory, and the planned hardening
sequence, see
[`docs/security/semidex-lite-public-api-audit-2026-08.md`](https://github.com/CodeNoob53/semidex/blob/main/docs/security/semidex-lite-public-api-audit-2026-08.md)
in the repository.

### Allowed indexing roots

Before starting an indexing job from the dashboard or `POST /api/jobs/index`,
configure the directories that the Admin API may read. In an environment
file, use a JSON array (Windows backslashes must be escaped):

```bash
INDEX_ALLOWED_ROOTS=["C:\\Users\\me\\Documents\\knowledge","D:\\shared-docs"]
```

In **Settings → System**, enter one absolute directory per line. The setting
applies immediately to Full and Lite; an empty list fails closed and disables
HTTP/dashboard indexing. The folder picker only fills the target field and
never adds a directory to the allow-list.

Both configured roots and requested targets must exist. Semidex resolves them
with the real filesystem before comparing path components, so a symlink or
Windows junction that resolves outside an allowed root is rejected. This is a
check-time boundary, not a race-proof filesystem sandbox: another local
process able to replace files or directories while the child indexer walks
them can create a time-of-check/time-of-use race. Keep allowed roots writable
only by trusted users.

This restriction applies only to the Admin HTTP route. A local operator who
runs `npx semidex-lite index <path>` directly remains responsible for the path
they choose.

### Exposing the server beyond loopback

If you deliberately set `ADMIN_ALLOW_REMOTE=1`, you must also set
`ADMIN_ALLOWED_HOSTS` to the exact host(s) clients will use. The server
refuses to start otherwise:

```bash
ADMIN_ALLOW_REMOTE=1
ADMIN_ALLOWED_HOSTS=semidex.example.com,192.168.1.10:8642
```

Include the port when clients connect on a non-default one. This is a Host
allow-list, not access control — it prevents DNS-rebinding and Host-header
attacks, and does not make the API safe to expose without your own
authenticated layer in front.

Behind a **TLS-terminating reverse proxy**, the browser's origin
(`https://your-domain`) differs from what this process sees on a plaintext
socket, so also set the exact allowed origin(s):

```bash
ADMIN_ALLOWED_ORIGINS=https://semidex.example.com
```

`X-Forwarded-Proto` and `X-Forwarded-Host` are deliberately not trusted —
they are attacker-controlled on a directly reachable listener — so this must
be configured explicitly rather than inferred.

## CLI

The examples below use the recommended project-local dependency through `npx`.
This ensures that the project runs the `semidex-lite` version pinned in its own
`package.json` and lockfile instead of an arbitrary system-wide version. If you
deliberately installed the package with `npm install -g semidex-lite`, you may
omit `npx` and run the same commands as `semidex-lite ...`.

```bash
npx semidex-lite --help                       # list cloud commands
npx semidex-lite doctor [--probe-inference]   # read-only health check
npx semidex-lite serve                        # start the admin API and dashboard
npx semidex-lite index <path>                 # index a file or folder
```

### `doctor`

Read-only by default. It checks the Node.js version, `.env` presence, Qdrant
Cloud and Gemini credential presence, and Qdrant Cloud reachability through a
cheap request. It does not create, modify, or delete anything.

The `--probe-inference` option performs a real embedding round-trip through a
**disposable** Qdrant Cloud collection. The collection is created and deleted
within the same command. This verifies that Cloud Inference works with the
selected dense model. The command displays a warning before proceeding.

### `serve`

Starts the admin API and dashboard at `ADMIN_HOST:ADMIN_PORT`, defaulting to
`127.0.0.1:8642`. If `QDRANT_URL`, `QDRANT_KEY`, or `GEMINI_API_KEY` is missing
or unavailable, the server starts in a degraded state: the dashboard reports
what is not configured rather than refusing to start. Only dependent
operations, such as search, indexing, or Ask, remain unavailable until the
configuration is corrected.

### `index`

```bash
COLLECTION=my-docs npx semidex-lite index ./docs
COLLECTION=my-docs npx semidex-lite index ./docs --prune-stale
```

In PowerShell, set the collection variable separately:

```powershell
$env:COLLECTION='my-docs'
npx semidex-lite index ./docs
```

Indexes a file or folder into the selected Qdrant Cloud collection. It supports
Markdown, plain text, PDF, and formats that Pandoc can convert. The
`--prune-stale` option deletes points for files that no longer exist under the
specified path. Use it only when indexing the complete source root, never a
subset.

There are no `--onnx-embed`, `--llm-summaries`, or `--tag-gen` options. These
are local features and are not part of this package.

### `key`

Manages **Integration API** keys — the bearer tokens a wrapper backend uses to
call Ask. See [Integration API authentication](#integration-api-authentication)
below for the full model.

```bash
npx semidex-lite key add --name assistant-backend --collection my-docs
npx semidex-lite key list
npx semidex-lite key revoke <id>
```

`key add` prints the raw token **once** — it is never stored (only a SHA-256
digest is) and cannot be shown again. `key list` shows public metadata only,
never a token or digest. `key revoke` takes effect immediately, with no
restart.

## Integration API authentication

> [!IMPORTANT]
> **Migration note for existing Ask API users.** Ask now requires a bearer
> token. Until you create your first key, `POST /api/v1/ask` and
> `POST /api/v2/ask` return **`503 integration_auth_not_configured`**. Create a
> key with `semidex-lite key add …` and send it as
> `Authorization: Bearer <token>`. Nothing else changes: the dashboard,
> settings, indexing and collection browsing keep working exactly as before,
> with no credential.

### Admin API vs Integration API

semidex-lite serves two distinct surfaces, with deliberately different rules:

| | Admin API | Integration API |
|---|---|---|
| Routes | Dashboard, settings, indexing jobs, collections, probes, `/api/search` | `POST /api/v1/ask`, `POST /api/v2/ask` |
| Caller | You, in a browser on this machine | Your own backend, server-to-server |
| Credential | **None** — protected by the loopback bind | **Bearer key, required** |
| Exposure | Never expose beyond loopback | Reachable through your backend |

Admin routes are *never* gated by an integration key: a missing or broken key
store takes down Ask, not your dashboard.

### Creating a key

```bash
npx semidex-lite key add --name assistant-backend \
  --collection my-docs \
  --collection support-docs \
  --expires 90d
```

Options:

- `--name` — a label, required.
- `--collection` — repeatable, **required**. A key with no collection is
  refused: an empty scope must never silently mean unrestricted access. Pass
  `--collection "*"` to grant every collection explicitly.
- `--operation` — defaults to `generate` (what Ask needs).
- `--expires` — an ISO date (`2027-01-01`) or a duration (`90d`, `12h`).
  Omit for no expiry.
- `--requests-per-minute` — sustained rate limit for this key, an integer
  from 1 to 6000. Omit for the default (30/min). See
  [Rate limiting](#rate-limiting) below.
- `--burst` — token-bucket burst capacity for this key, an integer from 1 to
  1000. Omit for the default (5).

The token is printed once. Store it in your backend's secret manager — never
in browser JavaScript, `localStorage`, a URL, or version control.

### Sending the token

```bash
curl -N -X POST "http://127.0.0.1:8642/api/v1/ask" \
  -H "Authorization: Bearer $SEMIDEX_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"my-docs","question":"What are the return conditions?"}'
```

```js
const response = await fetch('http://127.0.0.1:8642/api/v1/ask', {
  method: 'POST',
  headers: {
    // Read from your own secret store — never hard-code a token.
    Authorization: `Bearer ${process.env.SEMIDEX_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ collection, question: userMessage }),
});
```

The token is accepted **only** in the `Authorization` header. It is ignored in
query strings, cookies and request bodies, because those are logged, cached and
shared in ways a credential must not be.

### Scoping a key to collections

A key may only reach the collections it was created with. Matching is exact —
`--collection docs` grants `docs` and not `docs-a`. An out-of-scope collection
and a collection that does not exist return the *same* `403`, so a caller
cannot probe which collections you have.

This is the mechanism to use when one semidex-lite instance serves several
assistants: give each backend its own key, scoped to its own collections.

### Response codes

| Status | Code | Meaning |
|---|---|---|
| `503` | `integration_auth_not_configured` | No keys configured (or the key store is unreadable). Create a key. |
| `401` | `unauthorized` | Missing, malformed, unknown, wrong, revoked or expired token. Deliberately indistinguishable — no key enumeration. |
| `429` | `rate_limited` | Authenticated, but this key has exceeded its rate limit. See [Rate limiting](#rate-limiting) below. |
| `403` | `forbidden` | Authenticated, but this key is not scoped to that collection or operation. |
| `200` | — | Authorized; the SSE stream begins. |

A `401`, `429`, or `403` is decided before any Qdrant query, any embedding,
and any Gemini call — a rejected request costs you nothing. `429` is
decided before `403` too (and before your request body is even parsed): an
authenticated request always consumes one unit of rate limit, even one that
turns out malformed or targets a collection outside the key's scope.

### Rate limiting

Every authenticated Ask request (`/api/v1/ask`, `/api/v2/ask`) is rate
limited per key with a token bucket: **30 requests/minute, burst 5, by
default.** The two endpoints share one bucket per key — calling v1 and v2
alternately does not double your effective rate.

Set a different limit per key at creation:

```bash
npx semidex-lite key add --name high-volume-backend \
  --collection my-docs \
  --requests-per-minute 300 \
  --burst 20
```

`--requests-per-minute` accepts 1–6000; `--burst` accepts 1–1000. A key's
limit is fixed at creation — there is no `key edit` command; revoke and
recreate the key to change it. `key list` always shows each key's
*effective* limit (30/min burst 5 for a key created without these flags),
never a raw unset value.

**On a limit exceeded**, a request returns `429` with
`{ "error": { "code": "rate_limited", "message": "..." } }` and a
`Retry-After` header (an integer number of seconds — wait at least that
long before retrying). No response detail reveals the key's identity or its
configured limit.

**Reset and rotation semantics:**

- Rate-limit state lives only in server memory. **Restarting
  `semidex-lite serve` resets every key's bucket to full** — there is no
  persisted "used this minute" count to carry across a restart.
- **Revoking a key** does not need to clear anything explicitly: a revoked
  token fails authentication (`401`) before the rate-limit stage ever runs,
  so it never touches that key's bucket again. The bucket itself is later
  garbage-collected automatically once idle.
- **Creating a new key** always starts with a full bucket (`burst` tokens
  available immediately) — there is no shared or inherited state between
  keys, even for the same named integration recreated after a revoke.

**Limitations — read before relying on this for capacity planning:**

- **No cross-process/multi-replica sharing.** The limiter is in-process
  memory. If you run multiple `semidex-lite serve` processes behind a load
  balancer, each process enforces the configured limit independently — the
  real aggregate rate for a key becomes `requestsPerMinute × process count`,
  not the number you configured.
- **Not a DDoS defense.** This bounds a legitimate, already-authenticated
  key's request rate. It does not defend against connection floods or
  unauthenticated traffic (rejected earlier, at `401`/`503`, before this
  stage runs) and does not stop someone with operator access from minting
  more keys.
- **No spend guarantee.** A request-count limit is not a cost cap — Ask
  requests vary in Gemini/Qdrant Cloud cost per call. Use your provider's own
  billing alerts for an actual spend ceiling.

### What semidex-lite still does not own

Authentication does not change conversation ownership: **your application
still owns and stores chat history**. semidex-lite persists no conversations
for either endpoint — see
[Backend integration: multi-turn Ask](#backend-integration-multi-turn-ask-apiv2ask).
A key identifies a *calling backend*, not an end user; mapping end users to
permissions remains your backend's job.

Not yet implemented: remote Admin authentication, and key management from
the dashboard.

## Ask: answers grounded in your knowledge base

Ask lets you question one indexed collection and receive an answer generated
by Gemini from passages found in that collection. The model does not receive
the whole collection: semidex-lite first retrieves a bounded set of relevant
sources and only then sends them to Gemini with the question.

### How an answer is produced

```text
User question
  -> embed the query with the model assigned to the collection
  -> hybrid dense+sparse search in Qdrant Cloud
  -> select and number relevant passages
  -> assemble a bounded evidence context
  -> send system rules + evidence + question to Gemini
  -> stream an answer with [1], [2], ... citations
```

The collection profile determines the embedding model used for the query. This
matters because retrieval must not use a different model or vector dimension
from the one used to index that collection.

Ask sends two separate inputs to Gemini:

- a **system prompt** containing behavioral rules;
- a **user prompt** containing numbered retrieved passages and the question.

The system prompt is sent through Gemini's native `systemInstruction`. It
requires the model to answer only from supplied sources, cite factual claims,
respond in the language of the question, ignore instructions embedded in
indexed documents, and refuse to answer when the evidence is insufficient.
This reduces hallucination and prompt-injection risk, but cannot eliminate it:
you should still assess generated output against the cited sources.

In the current version, the system prompt is an internal part of the Ask
runtime. It cannot be changed through the dashboard, `.env`, or an Ask API
request. Safe custom instructions may be added later together with validation
and constraints, but are not currently part of the public contract.

### Integrate Ask through your backend

The primary way to use Ask is from your own assistant backend. This lets a
website, bot, or application choose the appropriate knowledge collection,
authenticate users, manage chat history, and apply its own access rules before
calling Semidex. Ask is available at the versioned `POST /api/v1/ask` endpoint.

After starting `serve` locally, a backend can call it with `fetch`:

```js
const collectionByAssistant = {
  support: 'company-support',
  education: 'course-materials',
};

const collection = collectionByAssistant[assistantId];
if (!collection) throw new Error('Unknown assistant');

const response = await fetch('http://127.0.0.1:8642/api/v1/ask', {
  method: 'POST',
  headers: {
    // Read from your own secret store — never hard-code a token. See
    // "Integration API authentication" above.
    Authorization: `Bearer ${process.env.SEMIDEX_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ collection, question: userMessage }),
});
```

Resolve or allow-list the collection on your backend. Do not let an
unauthenticated browser choose an arbitrary collection name, because that may
give it access to another assistant's knowledge base.

For a manual API check, use `curl`:

```powershell
curl.exe -N -X POST "http://127.0.0.1:8642/api/v1/ask" `
  -H "Authorization: Bearer $env:SEMIDEX_TOKEN" `
  -H "Content-Type: application/json" `
  -d '{"collection":"my-docs","question":"What are the main requirements described in the documentation?"}'
```

Required request fields:

- `collection`: the name of one collection;
- `question`: a non-empty question.

The optional `scope.sourceFile` field limits retrieval to one known file:

```json
{
  "collection": "my-docs",
  "question": "What is the return policy?",
  "scope": {
    "sourceFile": "policies/returns.md"
  }
}
```

The response is streamed as Server-Sent Events (SSE):

- `sources`: passages selected as evidence;
- `answer_delta`: incremental answer text;
- `done`: the final answer, citations, model, token usage, and timing;
- `error`: a structured error.

Ask API v1 is stateless: every request is independent, and `sessionId`, chat
history, and long-term memory are not yet supported. It requires a bearer
token and is rate limited per key (see
[Integration API authentication](#integration-api-authentication) and
[Rate limiting](#rate-limiting) above). Do not expose the admin server port
directly to the Internet. For an external integration, place your own
authenticated backend or reverse proxy with appropriate controls in front of
it.

### Backend integration: multi-turn Ask (`/api/v2/ask`)

`/api/v2/ask` is the **primary way to integrate a multi-turn conversational
assistant** against Semidex Lite — use it whenever a user can ask follow-up
questions. `/api/v1/ask` remains available and is the right choice for
stateless single-turn requests with no conversation history at all (see
[above](#ask-answers-grounded-in-your-knowledge-base)); v2 is additive, not
a replacement. v2 is stateless in exactly the same sense as v1 — the
difference is that on every request, YOUR backend sends a bounded summary and
recent-message window as a `conversation` object, and Semidex uses it for
that one request only: to rewrite ambiguous follow-up questions before
retrieval, to give the model conversational context, and — only when the
history has grown long enough — to return a freshly-recomputed summary for
you to store. **Semidex Lite does not store chats server-side in this
version, for either endpoint.** The dashboard does not currently have an
Ask UI (see below) — it may be added later — so for now `/api/v1/ask` and
`/api/v2/ask`, called directly or through your own backend, are the ways
to use Ask.

```json
{
  "collection": "company-support",
  "question": "What about exceptions to that?",
  "conversation": {
    "id": "conv_123",
    "summary": "Discussed the 14-day return window.",
    "recentMessages": [
      { "role": "user", "content": "How many days do I have to return an item?" },
      { "role": "assistant", "content": "You have 14 days from delivery." }
    ]
  }
}
```

#### Who owns the chat and who manages the context window

Your backend is the source of truth for the conversation. At minimum it should
store an append-only message archive, the current rolling `summary`, and the
index of the first archive message not yet covered by that summary. Before each
request it derives `recentMessages` from that boundary and sends the summary
and bounded view to Semidex. Semidex does not load earlier turns by
`conversation.id` and cannot reconstruct a chat that the caller did not send.

Token-budget management inside one request is handled by Semidex. The caller
does not need to tokenize messages or know the configured Gemini model's exact
context-window size. Semidex:

1. obtains the active generation model's context limit;
2. counts the question, summary, recent messages, prompt overhead, and
   retrieved evidence against one budget;
3. preserves room for evidence and the generated answer;
4. drops the oldest raw messages from the **current prompt only** when all
   supplied history does not fit (the caller's stored archive is untouched);
5. optionally rewrites a contextual follow-up into a standalone retrieval
   query while keeping the original question for the final answer;
6. after a successful answer, attempts summary compaction when the configured
   threshold is reached.

The caller still controls what enters this process: which conversation and
collection are authorized, which saved summary and recent messages are sent,
and whether the returned state is committed. The compaction settings exposed
by Semidex (`ASK_SUMMARY_COMPACTION_THRESHOLD`,
`ASK_SUMMARY_RETAINED_MESSAGES`, and
`ASK_SUMMARY_COMPACTION_TIMEOUT_MS`) tune when and how compaction is attempted;
they do not turn Semidex into a chat database.

- `ASK_SUMMARY_COMPACTION_THRESHOLD` defaults to `8` messages and controls
  when Semidex starts attempting compaction.
- `ASK_SUMMARY_RETAINED_MESSAGES` defaults to `4` and controls how many of the
  newest raw messages remain outside the refreshed summary.
- `ASK_SUMMARY_COMPACTION_TIMEOUT_MS` defaults to `6000`; a timeout leaves the
  current summary and boundary unchanged and does not fail an answer that was
  already generated successfully.

These operational settings are different from the fixed wire-protocol limits
listed below. Raising the compaction threshold does not raise the 200-message
request ceiling.

The lifecycle of a successful turn is therefore:

```text
load archive + summary + boundary in your backend
  -> derive unsummarized recentMessages
  -> POST /api/v2/ask
  -> Semidex budgets context, retrieves evidence, and streams the answer
  -> Semidex may return updatedSummary + compactedMessageCount
  -> atomically append the user/assistant turn and update summary + boundary
```

- **`conversation.id`** — an opaque string YOUR backend generates (e.g. a
  UUID) and controls entirely. Semidex only ever echoes it back in the `done`
  event's `conversation.id` field — it is never used to look up, authorize,
  or persist anything server-side.
- **`conversation.recentMessages`** — the newest `{role, content}` turns from
  your OWN stored history, `role` restricted to `"user"`/`"assistant"`.
  Semidex trims this further against the model's real context window if
  needed, and never persists it or forwards it to any third party beyond
  what serving this one request requires — but "this one request" can
  include up to three separate Gemini calls that each see some or all of
  this content: an optional query-rewrite call (to disambiguate a
  follow-up question before retrieval), the main answer call, and an
  optional summary-compaction call (only once the conversation has grown
  past `ASK_SUMMARY_COMPACTION_THRESHOLD`). None of it is written to disk
  or any datastore by Semidex itself, and none of it survives past this
  one HTTP request in Semidex's own process — but it does leave Semidex's
  process boundary to reach Gemini's API, subject to Google's own
  data-handling terms for that API. If that is not acceptable for your
  data, do not send it as `recentMessages`/`summary` at all.
- **`conversation.summary`** — your previously-saved rolling summary (omit on
  the very first turn of a new conversation). Semidex treats it, like
  `recentMessages`, as untrusted conversational context — never as retrieval
  evidence, never as verified fact, never able to override Semidex's own
  system instructions.
- **`done.conversation.summaryChanged` / `updatedSummary` /
  `compactedMessageCount`** — Semidex only recomputes the summary once the
  conversation has grown past a configurable length
  (`ASK_SUMMARY_COMPACTION_THRESHOLD`), not on every request. When
  `summaryChanged` is `true`: save `updatedSummary` as the new value to send
  next turn, **and** advance your own request-view boundary by exactly
  `compactedMessageCount` — the count of the OLDEST messages, from the
  `recentMessages` you just sent, that are now covered by `updatedSummary`.
  Skipping this step means you keep re-sending messages Semidex has already
  folded into the summary, so compaction never actually shrinks what you
  send and the conversation keeps growing without bound. Do it as one
  atomic update together with saving the summary — e.g.
  `summarizedThroughArchiveIndex += compactedMessageCount` in
  [`examples/conversation-manager.mjs`](examples/conversation-manager.mjs),
  which keeps a full append-only archive and derives the bounded
  `recentMessages` view from that boundary, rather than mutating a single
  array in place. When `summaryChanged` is `false`, keep using the summary
  and boundary you already have — `compactedMessageCount` is absent in that
  case.

**Protocol limits.** These are fixed, non-configurable ceilings enforced by
`/api/v2/ask` at request-parse time — a request that exceeds any of them is
rejected with `400` before any retrieval or generation is attempted:

- `conversation.recentMessages` — at most **200 entries**.
- Each message's `content` — at most **50,000 characters**.
- `conversation.summary` — at most **8,000 characters**.
- `conversation.id` — at most **256 characters**.

**When compaction cannot keep up.** Compaction is best-effort: if the
generation provider is unavailable or repeatedly fails specifically on the
compaction call, `summaryChanged` stays `false` turn after turn, so the
`recentMessages` window your backend keeps sending never shrinks — while
your archive still grows by one turn's worth of messages every time the
*answer itself* succeeds. Eventually that window would exceed the 200-entry
protocol limit above.
[`examples/conversation-manager.mjs`](examples/conversation-manager.mjs)
detects this locally, before sending, and returns a
`client_bounded_context_exceeded` error instead of either silently
truncating history or letting `/api/v2/ask` reject the oversized request.
**An ordinary retry does not recover from this state** — the same
oversized window gets rejected locally again every time, so no request
ever reaches Semidex, and a recovering provider has no request left to
compact. The only ways out are starting a new conversation, or applying
your own manual/out-of-band compaction recovery (summarizing and trimming
the stored archive yourself) — neither is implemented by this demo.

A runnable, dependency-free client and demo are shipped in this package —
see [`examples/ask-v2-sse-client.mjs`](examples/ask-v2-sse-client.mjs) (a
small SSE-streaming client: opens the request, parses `sources`/
`answer_delta`/`done`/`error` correctly even when a frame is split across
network chunks, and returns a plain result object) and
[`examples/conversation-manager.mjs`](examples/conversation-manager.mjs) (a
minimal example of OWNING conversation state around that client). Run the
CLI demo directly against your own running server.

If you cloned this repository or are working inside `packages/lite/`
itself:

```bash
QDRANT_URL=... QDRANT_KEY=... GEMINI_API_KEY=... npx semidex-lite serve &
npx semidex-lite key add --name demo --collection my-docs   # copy the printed token
SEMIDEX_TOKEN=<token> node examples/run-conversation-demo.mjs my-docs "How many days do I have to return an item?" "What about exceptions to that?"
```

If you installed `semidex-lite` as a dependency of your own project
(`npm install semidex-lite`), the example lives inside `node_modules/`, so
the path is different:

```bash
QDRANT_URL=... QDRANT_KEY=... GEMINI_API_KEY=... npx semidex-lite serve &
npx semidex-lite key add --name demo --collection my-docs   # copy the printed token
SEMIDEX_TOKEN=<token> node node_modules/semidex-lite/examples/run-conversation-demo.mjs my-docs "How many days do I have to return an item?" "What about exceptions to that?"
```

There is no dedicated `semidex-lite` CLI subcommand for this demo — it is
example source you run directly with `node`, not a package binary.

The compact shape of what your backend does around that client:

```js
// Your own persistence — NOT part of Semidex. See examples/conversation-manager.mjs
// for a full (in-memory, demo-only) implementation of this shape.
const conversation = await chatStore.loadConversation(conversationId, userId);
const collection = assistantRegistry.resolveAllowedCollection(assistantId); // never trust a browser-supplied collection name
const token = await secrets.getIntegrationApiToken(); // your own secret store — never hard-code or log this
const result = await askV2({ baseUrl, collection, question: userMessage, conversation, token });
await chatStore.commitTurn({
  conversationId, ownerId: userId, expectedVersion: conversation.version,
  messages: [{ role: 'user', content: userMessage }, { role: 'assistant', content: result.answer }],
  // Advancing the boundary is NOT optional — omitting it means every future
  // request keeps re-sending messages Semidex already folded into the
  // summary, and compaction never actually shrinks what you send.
  ...(result.summaryChanged ? {
    updatedSummary: result.updatedSummary,
    summarizedThroughArchiveIndex: conversation.summarizedThroughArchiveIndex + result.compactedMessageCount,
  } : {}),
});
```

**`examples/conversation-manager.mjs` stores state in an in-memory `Map` —
this is a demo, not production persistence.** It is lost on every restart
and never shared across multiple server replicas. A real backend should
replace it with PostgreSQL, Redis, MongoDB, SQLite, or whatever store it
already operates, ideally through one atomic `commitTurn`-shaped write (never
two separate version-checked writes for "append messages" and "update
summary" — if the first call increments the stored version, the second
call's version argument is already stale, and you can end up with messages
persisted without their matching summary).

`/api/v1/ask` remains available, unchanged, for stateless single-turn
requests with no conversation state at all — v2 is additive, not a
replacement.

See
[Ask API v2 — Bounded Conversational Context](https://github.com/CodeNoob53/semidex/blob/main/docs/design/ask-v2-conversational-context.md)
for the full design rationale, the `ConversationStore` contract Semidex is
designed to support in a future release, and the token-budgeting/rewriting/
compaction rules. Design docs are English-only in this repo — this is the
same document regardless of which README (EN or UK) links to it.

### Manual checking without building an integration

The bundled dashboard does not currently have an Ask panel — it may be
added later, but for now it only exposes manual **search** over an indexed
collection (no generation, no citations, no SSE). There is currently no
browser-based way to exercise Ask v1/v2; the `curl` example above and the
runnable client in `examples/` are the ways to check Ask manually before
building a full integration:

1. Configure `QDRANT_URL`, `QDRANT_KEY`, and `GEMINI_API_KEY`.
2. Index a file or folder through `semidex-lite index`.
3. Start the server with `npx semidex-lite serve`.
4. Open `http://127.0.0.1:8642` to browse the collection and try manual
   search, or call `/api/v1/ask` / `/api/v2/ask` directly (`curl`, or
   `examples/run-conversation-demo.mjs`) to check Ask itself.

## Maintainer-only live release acceptance

Repository maintainers can validate the **packed and clean-installed npm
artifact**, rather than the source checkout, with:

```bash
SEMIDEX_LITE_RELEASE_LIVE=1 npm run accept:lite-release-live
```

On Windows PowerShell:

```powershell
$env:SEMIDEX_LITE_RELEASE_LIVE = "1"
npm run accept:lite-release-live
```

This is deliberately not part of `npm test`, CI, or the installed package.
It requires live `QDRANT_URL`, `QDRANT_KEY`, and `GEMINI_API_KEY` credentials,
downloads npm dependencies, performs real Qdrant Cloud inference and Gemini
generation, creates two Integration API keys in an isolated temporary
`SEMIDEX_HOME`, and creates then deletes one uniquely named harness collection
(the doctor probe also manages its own short-lived probe collection). It
refuses a collection-name collision, deletes only the exact
collection owned by that run, never prints bearer tokens or provider keys,
and reports `ACCEPT` only when cleanup succeeds. Its JSON report is written
to `.tmp/semidex-lite-release-live-report.json` by default.

This complements `scripts/ask-v2-live-acceptance.mjs`: that older script
tests richer multi-turn/compaction behavior directly from repository source,
while the release harness tests packaging, clean installation, CLI,
authentication/scoping/rate limiting, and Ask v1/v2 as one shipped product.

## `SEMIDEX_HOME`

Application data, including `config.json`, `settings.json`, and the tokenizer
cache, is stored outside the installed package in the standard directory for
each OS:

- Windows: `%LOCALAPPDATA%\semidex-lite`
- macOS: `~/Library/Application Support/semidex-lite`
- Linux: `$XDG_DATA_HOME/semidex-lite`, or `~/.local/share/semidex-lite` when
  the variable is unset.

Override the location with the `SEMIDEX_HOME` environment variable. This
directory belongs exclusively to Lite and is never shared with full semidex.

## Limitations

- No local embedding or generation providers such as Ollama or local ONNX;
  only Qdrant Cloud Inference and Gemini are supported.
- No tag generation, combined context+tags LLM pass, or CUDA/DirectML probes.
- Advanced chunking and retrieval settings from full semidex are not shown in
  the Settings UI. The dense model and supported non-secret settings are
  configurable, but Qdrant and Gemini credentials must currently be supplied
  through OS environment variables or a local `.env` file.
- The Settings API exposes a smaller allow-list than full semidex. Attempts to
  write unsupported settings return `not_available_in_lite`.

For capabilities outside these limits, use full
[semidex](https://github.com/CodeNoob53/semidex).

## License

MIT
