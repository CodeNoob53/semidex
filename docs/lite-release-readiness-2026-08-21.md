# Semidex Lite — release-readiness checklist (2026-08-21)

Status: point-in-time gate report for the next `semidex-lite` release, run
against the current `main` working tree. This is a checklist, not a design
document — see `docs/en/roadmap.md` for product direction and
`docs/security/semidex-lite-public-api-audit-2026-08.md` for the full
security posture. Nothing in this file changes the package version, creates
a tag, or publishes anything; it only records what was verified and what
still needs a human/live step before either happens.

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
the loop, and were deliberately **not** attempted:

- [ ] `npx semidex-lite doctor --probe-inference` against a real Qdrant
      Cloud cluster (live embedding round-trip through a disposable
      collection).
- [ ] A live end-to-end pass: `serve`, index a real document, `key add`, call
      `POST /api/v1/ask` and `POST /api/v2/ask` against real Gemini and
      Qdrant Cloud credentials.
- [ ] The manual browser acceptance scenario documented in the audit's §12b
      ("Manual browser acceptance scenario (not automated)") — a real
      cross-origin `fetch()` from a second-origin page, confirmed blocked in
      DevTools. The HTTP-level tests prove server behavior; they do not
      prove real-browser behavior.
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
