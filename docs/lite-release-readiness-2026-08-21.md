# Semidex Lite — release-readiness checklist (2026-08-21)

Status: point-in-time gate report for the next `semidex-lite` release, run
against the current `main` working tree. This is a checklist, not a design
document — see `docs/en/roadmap.md` for product direction and
`docs/security/semidex-lite-public-api-audit-2026-08.md` for the full
security posture. Nothing in this file changes the package version, creates
a tag, or publishes anything; it only records what was verified and what
still needs a human/live step before either happens.

## Semidex Lite 0.1.7 candidate addendum (2026-08-29)

This candidate adds the expanded `semidex-lite/client` SDK: injected `fetch`,
typed Ask v1/v2 events and guards, `askText()`, conservative operation-aware
retry controls, stricter TypeScript consumer checks, and backend integration
examples that cancel upstream generation when the downstream client
disconnects. The admin-dashboard v2 work in the same development cycle is
documentation and design only; its implementation is not part of 0.1.7.

- Public Search v1 and Ask v1/v2 were exercised offline through the real Lite
  composition root and the shipped client, not matching hand-written mocks:
  **83/83 tests passed**. This includes authentication and collection scope,
  Search result projection, Ask SSE framing, v2 conversation flow, abort/gate
  release, summary compaction, and grounded source/citation projection.
- The complete unit suite passed **4716/4720**, with **0 failures** and the same
  **4 expected skips** for POSIX file-mode behavior on Windows. TypeScript
  consumer checking runs from `pretest` and passed.
- Smoke passed **1316/1316** assertions. Explicit Full and Lite Vite builds
  succeeded with 227 and 226 transformed modules respectively.
- `npm pack --dry-run` built `semidex-lite@0.1.7`; the five-part closure
  validator accepted 161 staged source files. The resulting manifest contains
  184 files (677.5 kB packed / 2.2 MB unpacked), including both backend
  examples, SDK declarations, and retry runtime, with no maintainer harness,
  internal report, local-only runtime, or secret added.
- Packed clean-install acceptance passed **14/14** as part of the complete
  suite. It verifies the installed CLI, read-only package behavior, public
  client export, both shipped backend examples, wire contracts, and package
  boundary from a fresh consumer directory.
- The opt-in packed-artifact live acceptance remains **pending for this
  candidate**. It sends a controlled fixture and prompts to the configured
  Qdrant Cloud and Gemini services, creates one exact-owned disposable
  collection, and removes only that collection. Do not treat the previous
  0.1.6 live result as verification of the new 0.1.7 SDK surface.

The Lite package version is `0.1.7`. References in generated comments and
documentation to a root Semidex `2.0.0` release originated as an AI-generation
error during the early prototype stage and remained as technical debt. The
issue was identified during review and corrected before this release; only the
Lite package has a release version here.

## Semidex Lite 0.1.6 addendum (2026-08-24)

This addendum records the release gate for the Integration Search API and the
public `semidex-lite/client` SDK added after the original checklist below was
written. The historical 2026-08-21 results remain unchanged.

- Packed clean-install acceptance passed **14/14** tests. It verifies the
  package export boundary, installed SDK imports, shipped `.d.ts` and backend
  example, bearer request shape, typed errors without token disclosure,
  redirect rejection, Ask v1/v2 streaming, and the absence of excluded
  Full/local runtime paths, maintainer scripts, reports, and secrets.
- Focused Search/SDK/auth regression passed **68/68** tests. Smoke passed
  **1316/1316** assertions; Full and Lite builds and Lite pack/prepack closure
  completed successfully.
- The full local suite reported one pre-existing Windows working-tree line
  ending mismatch in
  `tests/unit/architecture/shared-cloud-local-manifest.test.js`; no production
  or manifest source changed in this release work. This is recorded rather
  than hidden and must still be green in GitHub Actions before publishing.
- The opt-in packed-artifact live harness was run with real Qdrant Cloud and
  Gemini credentials and returned
  **`SEMIDEX_LITE_RELEASE_LIVE_ACCEPT`**. It clean-installed the tarball,
  passed the Qdrant Cloud inference probe, indexed its owned fixture, created
  separate generate- and search-scoped keys, verified 401/403/429 boundaries,
  exercised Integration Search through the installed SDK, and obtained
  grounded Ask v1/v2 answers with evidence and citations. Ask v1 succeeded on
  attempt 1; Ask v2 succeeded on attempt 2 through the bounded transient retry.
- Cleanup succeeded with HTTP 200 for the exact-owned disposable collection.
  The generated schema-v2 JSON report is stored under ignored `.tmp/` state
  and is not part of the package or Git diff.

The Lite package version is now `0.1.6`.

## How Lite is actually released

From `.github/workflows/publish-lite.yml` (triggered on a published GitHub
release) and `.github/workflows/smoke.yml` (every push/PR): `npm ci` →
`npm run admin:build` → `npm test` → `npm run smoke` → (publish workflow
only) verify the release tag matches `packages/lite/package.json`'s version
→ `npm pack --dry-run` in `packages/lite/` (runs the `prepack` hook:
`npm --prefix ../.. run admin:build:lite && node build.mjs`, which stages a
curated `src/` subset and runs a five-part closure validator against it) →
`npm publish`. This checklist runs every one of those steps except the tag
check and the actual publish.

## Automated gates — run this pass, offline, no live Qdrant/Gemini calls

| Gate | Command | Result |
|---|---|---|
| Unit tests | `npm test` | **Pass** — 4184 tests, 4180 pass, 0 fail, 4 skipped (Windows-only POSIX file-mode assertions, expected on this development machine) |
| Smoke tests | `npm run smoke` | **Pass** — 1316 assertions, 0 failed (embedding/config pipeline logic only, no Qdrant/Ollama connection by design — see `src/smoke.js`'s own header comment) |
| Full admin UI build | `npm run admin:build` | **Pass** — 227 modules, `dist/admin-ui/` built |
| Lite admin UI build | `npm run admin:build:lite` | **Pass** — 226 modules, `dist/admin-ui-lite/` built |
| Lite package closure + pack | `npm pack --dry-run` (in `packages/lite/`) | **Pass** — `prepack` staged 151 files and the five-part closure validator (import/require/dynamic-import resolution, fork/spawn target resolution, declared-dependency check, forbidden-marker scan of the built UI) reported clean; tarball built, 167 files, 575.9 kB packed / 1.9 MB unpacked |
| Focused security regression (subset of the tests above) | egress/loopback-boundary tests in `tests/unit/security/{network-egress-policy,qdrant-client-egress-integration,ollama-egress-network-integration,settings-sensitive-destination-loopback-boundary}.test.js` | **Pass** — included in the `npm test` run above; all assertions green |
| Clean-install acceptance (subset of the tests above) | `tests/unit/lite/clean-install-acceptance.test.js` | **Pass** — included in the `npm test` run above; its `before` hook runs `npm pack` in `packages/lite/`, installs the produced tarball into a fresh, empty temp project outside the repo, makes the installed package directory read-only, then exercises the installed CLI (`--help`, `doctor`, `serve` + `/api/health`) directly against that read-only install |
| Diff hygiene | `git diff --check` | **Pass** — no conflict markers or trailing-whitespace errors; only expected LF→CRLF line-ending notices on Windows |

No live Qdrant, Gemini, or model-download calls were made anywhere in this
pass, consistent with the constraint this checklist was written under.

## Manual / live gates — not run here, needed before an actual release

These require real credentials, a real registry interaction, or a human in
the loop, so they are excluded from CI. Their current manual verification
status is recorded below:

- [x] `npx semidex-lite doctor --probe-inference` against a real Qdrant
      Cloud cluster (live embedding round-trip through a disposable
      collection). Passed as part of the packed-artifact acceptance run on
      2026-08-22.
- [x] Run the packed-artifact live end-to-end harness with real Gemini and
      Qdrant Cloud credentials:
      `SEMIDEX_LITE_RELEASE_LIVE=1 npm run accept:lite-release-live`.
      It packs and clean-installs Lite, runs `doctor --probe-inference`,
      indexes a multilingual fixture, creates scoped keys, starts the
      installed server, checks 401/403/429 plus grounded Ask v1/v2, and
      deletes only its exact-owned disposable collection. This makes real
      provider calls and may incur cost; it is intentionally never run by
      CI. `ACCEPT` requires successful cleanup. The separate
      `scripts/ask-v2-live-acceptance.mjs` remains the source-level,
      multi-turn/compaction acceptance and does not replace this release
      artifact gate. Passed on 2026-08-22 with
      `SEMIDEX_LITE_RELEASE_LIVE_ACCEPT`: clean pack/install, doctor probe,
      indexing, scoped-key 401/403/429 checks, grounded Ask v1/v2 with one
      source/evidence/citation each, and exact-owned collection cleanup all
      succeeded.
- [x] The manual browser acceptance scenario documented in the audit's §12b
      ("Manual browser acceptance scenario (not automated)") — a real
      cross-origin `fetch()` from a second-origin page, confirmed blocked in
      DevTools. The HTTP-level tests prove server behavior; they do not
      prove real-browser behavior. Passed on 2026-08-22 from
      `http://localhost:9000` against `http://127.0.0.1:8642`: both the
      browser-simple `text/plain` request and the JSON/preflight request
      failed in the browser with `TypeError`; the server returned 403 with
      no `Access-Control-Allow-Origin` (and no preflight approval headers),
      while the same direct request without a foreign Origin reached the
      handler and returned 404. No probe job was created.
- [ ] `npm publish --dry-run` from a machine authenticated to the real npm
      registry, or an actual publish, once a version bump and GitHub release
      are decided separately from this task.
- [ ] Release-tag-matches-version check
      (`lite-v$(node -p "require('./packages/lite/package.json').version")"`)
      — only meaningful once an actual tag/release is being cut, which this
      task does not do.

## Blockers

None found. Every automated gate above passed on the first run against the
current working tree; no test, build, or closure-validator failure needs a
fix before the manual/live gates can proceed.

## Non-blocking follow-ups

Real but not release-blocking — safe to schedule as normal roadmap work,
not before this release:

- `packages/lite/README.uk.md` (the Ukrainian README) has been brought back
  in sync for the `QDRANT_URL` egress/loopback-write boundary bullet added to
  the English `README.md`'s Security status section. Two older, pre-existing
  English-only bullets in the same section — the route-aware `Cache-Control`
  policy and the `settings.json` file-permissions note — were already absent
  from the Ukrainian README before this pass and remain so; syncing those is
  still open, non-release-blocking follow-up work.
- The open items already tracked in `docs/en/roadmap.md`'s "Public API
  security hardening" and "P0. Public-facing hardening" sections: structured
  security audit logs, a RAG-specific prompt-injection/retrieval-poisoning
  evaluation, spend/token cost ceilings for billed Ask calls, a real
  session/authentication model for remote Admin access, and the
  versioned-`/api/v1/search` product decision. None of these are new
  findings — they are pre-existing, explicitly open items surfaced again
  here because they bear on what "release-ready" means for a
  public-facing security posture.

## Recommended next action

Proceed to the manual/live gates above when a real release is actually
being cut. Nothing in the automated pass blocks that decision today.
