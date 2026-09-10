# Semidex Lite 0.1.8 candidate verification

Date: 2026-09-10. Local Windows verification with Node 25.2.1 and npm 11.6.2.
Implementation commit: `f519862`; API documentation commit: `723bd0d`.
The package version was already 0.1.8 during this successful run.

## Results

| Check | Result |
| --- | --- |
| `npm test` (including client typecheck) | 5135 tests; 5131 passed, 0 failed, 4 skipped |
| `npm run smoke` | 1316 passed, 0 failed |
| `npm run admin:build` | Passed; 243 modules transformed |
| `npm pack --dry-run` in `packages/lite` | Passed; includes Lite UI build and closure validation |
| Lite UI build | Passed; 242 modules transformed |
| Lite source closure | 171 staged source files; validator passed |
| npm package | `semidex-lite@0.1.8`; 195 files; 730.4 kB packed, 2.4 MB unpacked |
| `git diff --check` | Passed |

The full suite packs and installs the actual tarball into a fresh temporary
directory. Acceptance checks passed for CLI help, doctor without credentials,
server health, read-only package contents, import containment, and exclusion
of local-only dependencies and real environment files. The final dry-run also
includes the agent runtime, typed client, and agent tool-loop example.

The first sandboxed full-suite attempt failed because esbuild could not read
parent directories. The complete suite was rerun with the required process
permissions and passed; no source workaround was made for that restriction.
Raw local logs are not committed.

## Remaining release gates

- Linux/Node 24 CI has not been run by this local verification. The existing
  publish workflow runs tests, smoke and packaging before npm publication.
- No new live provider acceptance run of the final packed artifact was made.
  The earlier native Gemini characterization is recorded in
  [the implementation report](../design/ask-agent-runtime-report-2026-09-10.md).
- No tag, push, GitHub release or npm publication was performed during candidate
  preparation. Publishing a GitHub release with tag `lite-v0.1.8` triggers the
  existing npm publication workflow.

## Branch scope

The retrieval-audit branch includes the benchmark harness and frozen evaluation
fixture commits plus this release's implementation and documentation. The CUDA
and spend-token-ceiling branches were already included in main. Experimental
graph retrieval remains separate. Untracked raw retrieval/chunker audit outputs
remain local and are not release artifacts.
