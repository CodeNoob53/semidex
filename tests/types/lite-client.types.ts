// Strict TypeScript consumer check for `semidex-lite/client`.
//
// This file is NEVER executed — `tests/types/tsconfig.json` runs it through
// `tsc --noEmit` (strict) via `npm run typecheck:lite-client`, wired into the
// normal `npm test` workflow through the root package.json's `pretest`
// script. Its only job is to fail the build the moment
// packages/lite/lite-src/client/index.d.ts drifts from what a real, external,
// strict TypeScript consumer actually sees — see
// docs/sdk-client-review-2026-08-28.md for the confirmed drift this guards
// against (v1/v2 event apiVersion, done-event narrowing, v2 conversation
// optionality). Every `@ts-expect-error` below is a negative assertion: if
// the marked line stops producing an error, `tsc` fails the build with
// "Unused '@ts-expect-error' directive" — so a future change that
// accidentally makes v1 silently accept v2 shapes (or vice versa) breaks
// this gate, not just a human reviewer.
import {
  createSemidexClient,
  isKnownAskV1Event,
  isKnownAskV2Event,
  type AskV1Args,
  type AskEventV1,
  type AskEventV2,
  type AskDoneEventV1,
  type AskDoneEventV2,
  type AskConversationDoneBlock,
  type AskTextArgs,
  type AskTextArgsV1,
  type AskTextArgsV2,
  type AskTextResultV1,
  type AskTextResultV2,
  // Backward-compatible aliases (pre-version-split names) — imported and
  // exercised below purely so a future edit cannot silently delete one of
  // them (a removed export breaks this import statement itself).
  type AskSourcesEvent,
  type AskAnswerDeltaEvent,
  type AskDoneEvent,
  type AskEvent,
  type AskDoneConversation,
  type AskTextResult,
} from '../../packages/lite/lite-src/client/index.js';

const semidex = createSemidexClient({
  baseUrl: 'http://127.0.0.1:8642',
  apiKey: 'sdx_v1_test-fixture-only',
});

// ── askV1(): known events resolve apiVersion: 'v1', with NO conversation field ──

async function checkAskV1KnownEventNarrowing(): Promise<void> {
  for await (const event of semidex.askV1({ collection: 'docs', question: 'q' })) {
    if (!isKnownAskV1Event(event)) continue; // forward-compat: ignore a future, unrecognized event type

    if (event.type === 'sources') {
      const searchMode: string | null = event.searchMode;
      void searchMode;
    } else if (event.type === 'answer_delta') {
      const text: string = event.text;
      void text;
    } else {
      // Narrowed all the way to AskDoneEventV1 — this is the exact case the
      // SDK review's `tsc --strict` check found broken before this fixture
      // existed: `.answer`/`.apiVersion` used to resolve to `unknown`.
      const apiVersion: 'v1' = event.apiVersion;
      const answer: string = event.answer;
      void apiVersion;
      void answer;

      // Ask v1 must stay free of a conversation field — modeling one here
      // (even as always-undefined) would falsely promise v2 data on a v1
      // response.
      // @ts-expect-error — AskDoneEventV1 has no `conversation` field at all.
      event.conversation;
    }
  }
}

// ── askV2(): known events resolve apiVersion: 'v2'; conversation is optional, never null ──

async function checkAskV2ConversationOptionality(): Promise<void> {
  for await (const event of semidex.askV2({ collection: 'docs', question: 'q' })) {
    if (!isKnownAskV2Event(event)) continue;
    if (event.type !== 'done') continue;

    const apiVersion: 'v2' = event.apiVersion;
    void apiVersion;

    if (event.conversation === undefined) continue; // omitted entirely on a first-turn request

    const id: string = event.conversation.id;
    const summaryChanged: boolean = event.conversation.summaryChanged;
    void id;
    void summaryChanged;

    // updatedSummary/compactedMessageCount are OMITTED (not `null`) whenever
    // the server did not recompute the summary this turn — reading either
    // without first checking for `undefined` must not typecheck as present.
    // @ts-expect-error — updatedSummary is `string | undefined`, not `string`.
    const forcedSummary: string = event.conversation.updatedSummary;
    void forcedSummary;

    if (typeof event.conversation.updatedSummary === 'string') {
      const summary: string = event.conversation.updatedSummary; // correctly narrowed
      void summary;
    }
  }
}

// ── unknown events: forward-compatible passthrough, no cast required ──

function checkUnknownEventForwardCompatibility(event: AskEventV1): void {
  // A hypothetical future event type this client doesn't know about yet must
  // still be a valid AskEventV1 with no cast — this is the "preserve runtime
  // forward compatibility with unknown future SSE event names" requirement,
  // checked at the type level.
  const future: AskEventV1 = { type: 'reasoning_delta', text: 'partial reasoning' };
  void future;

  // Every event, known or not, exposes at least `type: string`.
  const type: string = event.type;
  void type;
}
void checkUnknownEventForwardCompatibility;

// ── askV1() must not silently accept v2-shaped input ──

const badV1Args: AskV1Args = {
  collection: 'docs',
  question: 'q',
  // @ts-expect-error — AskV1Args has no `conversation` field; v1 must not silently accept v2 input.
  conversation: { conversationId: 'c1' },
};
void badV1Args;

// ── askText(): `version` selects the resolved result type, not just its runtime shape ──

async function checkAskTextV1(): Promise<void> {
  const result = await semidex.askText({ collection: 'docs', question: 'q' });
  const done: AskDoneEventV1 = result.done;
  const conversation: null = result.conversation; // statically null, not `T | null`
  void done;
  void conversation;

  // A v1 askText() result can never silently be treated as a v2 one.
  // @ts-expect-error — AskTextResultV1 is not assignable to AskTextResultV2 (done/conversation shapes differ).
  const asV2: AskTextResultV2 = result;
  void asV2;
}
void checkAskTextV1;

async function checkAskTextV2(): Promise<void> {
  const result = await semidex.askText({
    version: 'v2',
    collection: 'docs',
    question: 'q',
    conversation: { conversationId: 'c1' },
  });
  const done: AskDoneEventV2 = result.done;
  void done;

  if (result.conversation) {
    // @ts-expect-error — updatedSummary is optional; reading it as `string` without a check must fail.
    const forced: string = result.conversation.updatedSummary;
    void forced;
  }

  // Nor can a v2 result be silently narrowed back down to the v1 shape.
  // @ts-expect-error — AskTextResultV2 is not assignable to AskTextResultV1 (conversation is not statically `null`).
  const asV1: AskTextResultV1 = result;
  void asV1;
}
void checkAskTextV2;

// ── askText(): a value already typed as AskTextArgs (dynamic version) must still be callable ──
//
// A caller that picks v1 vs v2 at runtime ends up with a variable STATICALLY
// typed as the `AskTextArgsV1 | AskTextArgsV2` union (= `AskTextArgs`) —
// which is not assignable to either precise overload's parameter alone, so
// askText() needs the general `AskTextArgs` overload for this to compile at
// all. This is the "value already typed as AskTextArgs" / "dynamic version
// union" case.
function pickAskTextArgs(useV2: boolean): AskTextArgsV1 | AskTextArgsV2 {
  if (useV2) {
    return {
      version: 'v2',
      collection: 'docs',
      question: 'q',
      conversation: { conversationId: 'c1' },
    };
  }
  return { collection: 'docs', question: 'q' };
}

async function checkAskTextDynamicVersionUnion(): Promise<void> {
  const dynamicArgs: AskTextArgs = pickAskTextArgs(Math.random() > 0.5);
  const result = await semidex.askText(dynamicArgs);

  // Only the union is statically guaranteed — this is genuinely
  // AskTextResultV1 | AskTextResultV2, not narrowed to either on its own.
  const done: AskDoneEventV1 | AskDoneEventV2 = result.done;
  const conversation: AskConversationDoneBlock | null = result.conversation;
  void done;
  void conversation;

  // `result.done` itself narrows correctly on its own discriminant — this
  // does NOT propagate up to narrow `result` as a whole (TS does not narrow
  // an outer union from a check on a nested property path), so this checks
  // exactly what actually holds rather than overclaiming full narrowing.
  if (result.done.apiVersion === 'v2') {
    const doneV2: AskDoneEventV2 = result.done;
    void doneV2;
  }
}
void checkAskTextDynamicVersionUnion;

// ── Backward-compatible (pre-version-split) type names — must keep resolving ──
//
// These existed before AskEventV1/V2 etc. were introduced. They must still
// import cleanly (a removed export fails the import above) and still
// accurately describe a real v1 AND a real v2 value, since they are now
// defined as unions of the version-specific types rather than duplicated
// declarations that could drift out of sync with them.

function checkLegacyEventAliasesCoverBothVersions(v1: AskEventV1, v2: AskEventV2): void {
  const fromV1: AskEvent = v1;
  const fromV2: AskEvent = v2;
  void fromV1;
  void fromV2;

  const sourcesV1: AskSourcesEvent = { type: 'sources', apiVersion: 'v1', searchMode: null, sources: [] };
  const sourcesV2: AskSourcesEvent = { type: 'sources', apiVersion: 'v2', searchMode: null, sources: [] };
  void sourcesV1;
  void sourcesV2;

  const deltaV1: AskAnswerDeltaEvent = { type: 'answer_delta', apiVersion: 'v1', text: 'x' };
  const deltaV2: AskAnswerDeltaEvent = { type: 'answer_delta', apiVersion: 'v2', text: 'x' };
  void deltaV1;
  void deltaV2;
}
void checkLegacyEventAliasesCoverBothVersions;

function checkLegacyDoneEventAlias(done1: AskDoneEventV1, done2: AskDoneEventV2): void {
  const legacyDone1: AskDoneEvent = done1;
  const legacyDone2: AskDoneEvent = done2;
  void legacyDone1;
  void legacyDone2;
}
void checkLegacyDoneEventAlias;

function checkLegacyConversationAlias(): void {
  // AskDoneConversation = AskConversationDoneBlock: accurate now (optional
  // updatedSummary/compactedMessageCount), not the original's nullable-
  // required declaration.
  const withSummary: AskDoneConversation = { id: 'c1', summaryChanged: true, updatedSummary: 'new summary' };
  const withoutSummary: AskDoneConversation = { id: 'c1', summaryChanged: false };
  void withSummary;
  void withoutSummary;

  // @ts-expect-error — updatedSummary/compactedMessageCount are optional, not `null`; the legacy alias must not resurrect the old nullable-required shape.
  const stillNotNullable: AskDoneConversation = { id: 'c1', summaryChanged: false, updatedSummary: null };
  void stillNotNullable;
}
void checkLegacyConversationAlias;

async function checkLegacyAskTextResultAlias(): Promise<void> {
  const r1: AskTextResult = await semidex.askText({ collection: 'docs', question: 'q' });
  const r2: AskTextResult = await semidex.askText({
    version: 'v2',
    collection: 'docs',
    question: 'q',
  });
  void r1;
  void r2;
}
void checkLegacyAskTextResultAlias;

void checkAskV1KnownEventNarrowing;
void checkAskV2ConversationOptionality;
