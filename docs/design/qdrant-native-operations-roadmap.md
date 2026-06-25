# Qdrant Native Operations Roadmap

Status: medium-term design plan, draft for MVP and first demo.

This note records why semidex should add first-class Qdrant support through the
official JavaScript client instead of treating Qdrant as a thin search endpoint.
The goal is not to add UI convenience. The goal is to make indexing,
migrations, backups, and demos operationally safe.

Current local reference version in use: Qdrant `v1.17.1`.
Latest release observed during planning: Qdrant `v1.18.2` (2026-06-25).

---

## 1. Why This Matters

semidex depends on Qdrant for all indexed knowledge. As soon as collections
become large or used in demos, "delete and reindex" is no longer an acceptable
operator story.

Native Qdrant operations unlock:

- safe reindex through aliases;
- snapshots before destructive actions;
- controlled collection creation and deletion;
- payload index management;
- optimizer and collection health checks;
- memory/disk diagnostics;
- future access to newer Qdrant query APIs and vector-management APIs.

This is important for the MVP because skeleton-first indexing and future schema
changes will force reindexing. It is important for the first public demo because
we need a safe story for rollback, repeatability, and operational confidence.

It is also strategically important if semidex requests support or a grant from
Qdrant: semidex should show that it uses Qdrant as a serious infrastructure
layer, not only as a vector-search dependency.

---

## 2. Design Principle

Qdrant control-plane operations must be separated from agent retrieval.

Read-only MCP tools are safe for ordinary agents:

```text
qdrant_search
qdrant_get_chunk
qdrant_get_skeleton
qdrant_get_skeleton_node
qdrant_get_skeleton_children
```

Admin operations are different:

- snapshot;
- restore;
- alias switch;
- collection delete;
- schema migration;
- optimizer trigger.

These should live in CLI commands first. Admin MCP tools, if added later, must
be explicitly named, disabled by default, and guarded against accidental use.

---

## 3. Phase 0 - Upgrade Readiness Check

Before adding SDK features, establish an upgrade routine.

Tasks:

1. Document current Qdrant version in `npm run doctor`.
2. Add a compatibility note for tested Qdrant versions.
3. Snapshot important local collections before upgrading Qdrant.
4. Upgrade local Qdrant from `v1.17.1` to `v1.18.x`.
5. Run:

```bash
npm run doctor
npm run sync
```

6. Verify live search on at least:
   - one legacy collection;
   - one skeleton collection;
   - one large real collection.

Acceptance:

- existing named dense+sparse collections remain searchable;
- payload indexes still match semidex expectations;
- `qdrant_collection_info` reports expected provider metadata;
- no migration is performed silently.

---

## 4. Phase 1 - Official JS Client Integration

Add `@qdrant/js-client-rest` as the canonical internal Qdrant client for
control-plane operations.

Initial scope:

- collection exists / list collections;
- create collection with semidex vector schema;
- create payload indexes;
- delete collection with explicit confirmation at CLI level;
- read collection info and optimizer status;
- create snapshot;
- list snapshots;
- delete snapshot;
- create/delete aliases;
- inspect alias mapping.

Out of scope for Phase 1:

- changing retrieval ranking;
- changing default search behavior;
- adding write-capable MCP admin tools;
- replacing existing working search path unless needed.

Acceptance:

- all new helpers are covered by pure or mocked tests where possible;
- destructive helpers require explicit command-level confirmation;
- remote Qdrant URLs and API keys continue to come from existing env/config;
- no private paths or keys are printed.

---

## 5. Phase 2 - Safe Reindex Workflow With Aliases

Aliases should become the default strategy for risky collection upgrades.

Target model:

```text
logical collection name: docs
physical collection:     docs-v20260625-001
alias:                   docs -> docs-v20260625-001
```

Safe reindex flow:

1. Resolve `docs` alias to current physical collection.
2. Create a new physical collection, for example `docs-v20260625-002`.
3. Index into the new collection.
4. Run validation:
   - collection status green;
   - expected point count;
   - provider/schema metadata;
   - optional smoke search queries.
5. Atomically switch alias:

```text
docs -> docs-v20260625-002
```

6. Keep old physical collection for rollback until user deletes it.

Possible CLI shape:

```bash
npm run qdrant:alias:list
npm run qdrant:alias:switch -- docs docs-v20260625-002
npm run index:safe -- --collection docs --source ./docs
```

Acceptance:

- agents can keep using the stable collection name;
- rollback is possible by switching alias back;
- old collection is never deleted automatically;
- command output clearly shows old target and new target.

---

## 6. Phase 3 - Snapshot and Restore Workflow

Snapshots are the safety net for destructive operations.

Target CLI:

```bash
npm run qdrant:snapshot:create -- docs
npm run qdrant:snapshot:list -- docs
npm run qdrant:snapshot:delete -- docs <snapshot-name>
```

Restore is more dangerous and should not be hidden behind a casual command.
Prefer a documented operator flow first, then a guarded CLI command later.

Use snapshots before:

- prune stale files;
- schema migrations;
- bulk payload rewrites;
- collection deletion;
- Qdrant version upgrade;
- benchmark state preservation.

Acceptance:

- snapshot creation is tested against a local Qdrant instance;
- snapshot names include collection and timestamp;
- command prints restore instructions;
- snapshots are not confused with semidex-generated artifacts.

---

## 7. Phase 4 - Collection Health and Diagnostics

Add Qdrant-native diagnostics to `npm run doctor` and/or a new operator command.

Useful checks:

- Qdrant version;
- collection status;
- optimizer status;
- vector schema;
- named vectors present (`dense`, `sparse`);
- payload indexes present;
- point count;
- segment count;
- memory/disk usage where Qdrant exposes it;
- alias target;
- snapshot count.

Potential commands:

```bash
npm run qdrant:doctor
npm run qdrant:collection:info -- docs
```

Acceptance:

- diagnostics are redacted;
- output tells the operator what to do next;
- remote/cloud Qdrant works the same as local Qdrant where the API supports it.

---

## 8. Phase 5 - Native Query API Evaluation

Only after the control-plane layer is stable, evaluate deeper Qdrant query
features for retrieval.

Candidate areas:

- native dense+sparse prefetch and RRF via Query API;
- formula/rescoring where supported;
- native full-text / payload filtering combinations;
- named vector management for future embedding upgrades;
- quantization options such as scalar/product/binary/TurboQuant where relevant;
- memory and optimizer settings for large local collections.

Rules:

- do not replace a working retrieval path without benchmark evidence;
- compare against current `qdrant_search` on semidex fixtures;
- measure both quality and latency;
- keep fallback paths for older Qdrant versions until support policy is clear.

Acceptance:

- a benchmark report exists before defaults change;
- version requirements are documented;
- behavior is gated by Qdrant capability detection, not guesswork.

---

## 9. Demo and Grant Narrative

For the first demo, Qdrant-native support should communicate three things:

1. semidex can build useful local knowledge collections for agents.
2. semidex can operate those collections safely: backup, reindex, rollback.
3. semidex is designed to use Qdrant's native capabilities instead of
   reinventing database-level infrastructure in application code.

Minimum demo-worthy Qdrant-native features:

- show collection info and vector schema;
- create snapshot before reindex;
- index into a new collection or physical version;
- switch alias or demonstrate the planned alias workflow;
- run the same MCP search against the stable collection name.

This does not require all phases to be complete. It requires a credible,
working slice and a clear roadmap.

---

## 10. Open Questions

1. Should aliases become mandatory for all production-like collections?
   Proposed answer: not for local hobby use; yes for safe reindex commands.

2. Should semidex keep using collection names directly in simple mode?
   Proposed answer: yes. Aliases are an operational upgrade, not a beginner
   requirement.

3. Should admin MCP tools exist?
   Proposed answer: eventually maybe, but CLI first. Admin MCP must be
   explicitly enabled and never mixed with read-only retrieval tools.

4. Should old physical collections be pruned automatically after alias switch?
   Proposed answer: no. Keep manual cleanup until rollback policy is proven.

5. Should Qdrant Cloud-specific features be documented separately?
   Proposed answer: yes, after local SDK integration is stable.

---

## 11. Recommended Next Task

Create a small SDK spike:

- add `@qdrant/js-client-rest`;
- implement internal helpers for:
  - `getQdrantVersion`;
  - `listCollections`;
  - `getCollectionInfo`;
  - `listAliases`;
  - `createSnapshot`;
- add one CLI command, for example:

```bash
npm run qdrant:doctor
```

Do not implement destructive operations in the spike. First prove that the SDK
integration works against local and remote Qdrant with current env/config.
