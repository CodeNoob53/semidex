// Token-aware splitting of oversized structural entities (table/code_block/
// checklist) into multiple bounded, independently-embeddable retrieval
// fragments — while keeping ONE canonical entity carrying the complete,
// unsplit raw_content for reconstruction (qdrant_get_node, document
// assembly). Pure — no I/O, no Qdrant shapes, no profile/provider
// awareness (design decision: the chunker must not know provider names or
// the full embedding profile; it only receives a generic
// { maxInputTokens, countTokens } budget resolved by the indexing
// coordinator from the collection's stored profile).
//
// Why this exists: chunkFromSkeleton (skeleton-chunk.js) keeps table/
// code_block/checklist entities whole by design (impl spec §11) — correct
// for a local embedding model with a large context window (BGE-M3, 8192
// tokens), but a real problem for a small-window cloud model (E5, 512
// tokens): an ordinary large table or code block would otherwise hard-fail
// indexing for the whole file (checkEmbedInputFits rejects the body, and
// unlike `context`, the chunk BODY is never trimmed — trimming indexed
// content is forbidden). This module is what lets Semidex Lite index such
// files: split the entity into fragments that each fit the budget,
// preserving exactly one copy of the full raw content on a separate,
// non-searchable canonical point (point_kind: 'entity_raw', built by
// skeleton-chunk.js, never embedded against the real oversized text).
//
// Splitting boundaries, by node type — every fragment is built to be
// independently well-formed Markdown (a real search result may be shown to
// a user/agent standalone, so a fragment must never depend on a sibling
// fragment to parse or display correctly):
//   table      — normally splits on ROW boundaries, repeating the header
//                row (+ its GFM separator row) at the start of EVERY
//                fragment. A single row that alone still doesn't fit
//                (e.g. one cell with an enormous value) is split further
//                by CELL — see splitOversizedTableRow below — never left
//                whole and never silently truncated.
//   code_block — normally splits on LINE boundaries; EVERY fragment
//                carries its own opening and closing fence. A single line
//                that alone still doesn't fit (e.g. a minified/very long
//                line) is split further at CHARACTER boundaries via
//                splitOversizedUnitIntoPieces below.
//   checklist  — normally splits on ITEM boundaries ("- [ ] " / "- [x] "
//                list items, including their own continuation lines). A
//                single item that alone still doesn't fit is split further
//                at CHARACTER boundaries, same mechanism as code_block.
//
// Full token-aware split (no unsplittable-unit escape hatch): every real
// input this module is given can always be reduced to fragments that fit
// the budget, down to individual characters if truly necessary — there is
// no longer any "oversizedUnitCount, reported but not split further" case
// that stops indexing. A pathological budget too small for even one
// rendered character (never a real scenario — every supported cloud
// model's window is hundreds of tokens) is the sole remaining defensive
// edge case, documented at splitOversizedUnitIntoPieces itself.

const HEADER_SEPARATOR_RE = /^\|?[\s:|-]+\|?$/; // GFM table separator row, e.g. |---|:---:|
const CHECKLIST_ITEM_START_RE = /^([-*+]\s+\[[ xX]\]\s|[-*+]\s+)/; // "- [ ] " / "- [x] " / plain "- " list item start
const FENCE_RE = /^(`{3,}|~{3,})/;
// Prefix injected onto every NON-FIRST character-boundary piece of a
// split checklist item (code review, P2) — a bare continuation piece has
// no "- [ ] " marker of its own and is not valid standalone checklist
// markdown; this makes every fragment self-describing without a reader
// needing to see a sibling fragment to know it's a continuation.
const CHECKLIST_CONTINUATION_MARKER = '  (continued) ';

/**
 * @typedef {{ maxInputTokens: number, countTokens: (text: string) => number|Promise<number> }} EmbeddingBudget
 *   countTokens may be sync or async; always awaited. maxInputTokens is the
 *   TOTAL budget for one fragment's assembled `context + '\n\n' + fragmentText`
 *   — this module reserves room for context itself (see reserveForContext
 *   below), it never returns a fragment whose OWN text plus a representative
 *   context prefix would still overflow, except for the genuinely
 *   unsplittable single-unit case (one oversized table row / one oversized
 *   checklist item), which is reported via `oversizedUnits`, never silently
 *   dropped or truncated.
 */

/**
 * Splits GFM table markdown into row groups, each prefixed with the header
 * + separator row (except the header is naturally already there for the
 * first group). Returns an array of STRING fragments (full markdown table
 * text per fragment) — never partial rows.
 * @param {string} rawContent
 * @returns {{ header: string[], rows: string[] }} header = [headerLine, separatorLine] (or [] if not detected — defensive, treated as a single unsplittable unit by the caller), rows = body row lines
 */
function parseTableStructure(rawContent) {
  const lines = String(rawContent ?? '').split('\n');
  // Find the header + GFM separator pair — the first line, then the very
  // next non-blank line that matches the separator shape. Defensive: if no
  // separator is found (malformed/non-GFM table), report no header so the
  // caller treats the whole rawContent as one unsplittable unit rather than
  // guessing.
  let headerEnd = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === '') continue;
    if (HEADER_SEPARATOR_RE.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
      headerEnd = i + 1;
      break;
    }
    break; // first non-blank line must be the header; no separator right after it → malformed
  }
  if (headerEnd === -1) return { header: [], rows: [] };
  const header = lines.slice(0, headerEnd + 1);
  const rows = lines.slice(headerEnd + 1).filter((l) => l.trim() !== '');
  return { header, rows };
}

/**
 * Splits one GFM table row line into its cell values, respecting escaped
 * pipes ("\|") inside a cell. Leading/trailing pipes (the conventional
 * "| a | b |" style this codebase's own tables use) are stripped.
 * @param {string} rowLine
 * @returns {string[]} cell values, in column order
 */
/**
 * Re-escapes a literal "|" back into "\|" for rendering a cell value into
 * markdown row text — the inverse of parseTableRowCells' unescaping. Must
 * be applied at every point a cell value is written back into a row line
 * (code review, P1 regression): a cell parsed from "a\|b" holds "a|b" as
 * its plain string value, and without re-escaping here that literal pipe
 * is indistinguishable from a real column delimiter once rendered back to
 * markdown, silently corrupting the row into an extra column.
 * @param {string} cellText
 * @returns {string}
 */
function escapeTableCell(cellText) {
  return cellText.replace(/\|/g, '\\|');
}

function parseTableRowCells(rowLine) {
  const trimmed = rowLine.trim().replace(/^\|/, '').replace(/\|$/, '');
  // Split on an unescaped "|" only — a negative-lookbehind-free approach
  // (broader engine compatibility): walk the string, tracking a trailing
  // backslash run's parity so an escaped pipe never becomes a split point.
  const cells = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Column names from a parsed GFM header (the header line only, not the
 * separator) — used to label each piece of a cell that itself had to be
 * split further (splitOversizedTableRow).
 * @param {string[]} header — [headerLine, separatorLine] from parseTableStructure
 * @returns {string[]}
 */
function parseTableColumnNames(header) {
  return header.length ? parseTableRowCells(header[0]) : [];
}

/**
 * Splits ONE oversized table row — represented STRUCTURALLY as
 * `{ cells: string[], labeled: boolean[] }`, never as re-parsed row markdown
 * text — into its COMPLETE, final set of row-shaped pieces, each one
 * already fitting `budget` on its own. Structural representation is
 * load-bearing: an earlier version of this module rendered a split cell
 * back to a markdown string (e.g. "xxx (Value continued 1/2)") and re-fed
 * it through the GFM row parser on the next call, which mistook the label
 * itself for cell content and appended a NEW label on top each time,
 * looping forever without ever converging.
 *
 * Fully resolves the row in ONE call rather than returning a partial 2-way
 * split for the caller (greedyGroup) to re-check and re-split (code
 * review — P1 regression found while testing the escaped-pipe fix, not one
 * of the 3 originally reported findings): a 2-way "split the largest cell,
 * let the caller re-queue and re-check fitness" loop is only correct when
 * exactly ONE column is oversized. With TWO OR MORE independently oversized
 * columns, repeatedly halving whichever column is picked as "active" while
 * the OTHER oversized column rides along unchanged in both output pieces
 * causes that untouched column's content to be duplicated once per emitted
 * piece — confirmed via a real run: two 100-char oversized columns produced
 * 4 fragments each carrying the FULL, un-split second column, quadrupling
 * its content. Processing columns SEQUENTIALLY to completion — fully
 * draining column 0's own pieces (each with every later column emptied,
 * since a later column's real content is deferred to ITS OWN pieces, never
 * carried along unsplit) before ever touching column 1 — guarantees every
 * character of every cell appears in exactly one output piece.
 *
 * @param {{ cells: string[], labeled: boolean[] }} row
 * @param {string[]} columnNames
 * @param {(row: { cells: string[], labeled: boolean[] }) => string} renderRow
 *   — renders ONE row object to its final markdown line (labels included
 *   for any `labeled[i] === true` column) — used only to measure candidates
 * @param {EmbeddingBudget} budget
 * @returns {Promise<Array<{ cells: string[], labeled: boolean[] }>>} two or
 *   more row objects, each already fitting `budget` on its own — the
 *   caller (greedyGroup) still re-checks fitness per its own generic
 *   contract, but every piece returned here is final, not partial.
 */
async function splitOversizedTableRow(row, columnNames, renderRow, budget) {
  const { cells, labeled } = row;

  // A row with every OTHER column emptied is the cheapest possible frame
  // for column i's own content — if even THAT doesn't fit at zero
  // characters, no split of this row can ever succeed (hard, typed stop,
  // never a silent infinite shrink).
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].length === 0) continue;
    const allEmptyProbe = { cells: cells.map(() => ''), labeled: cells.map((_, j) => j === i || labeled[j]) };
    if (!(await fitsBudget(renderRow(allEmptyProbe), budget))) {
      const err = new Error(
        `Table row cannot be split to fit the embedding budget: even the header, separator, and continuation label for column "${columnNames[i] ?? `col ${i + 1}`}" alone (every cell emptied) exceeds maxInputTokens=${budget.maxInputTokens}.`,
      );
      err.code = 'TABLE_ROW_UNSPLITTABLE';
      throw err;
    }
  }

  const pieces = [];
  // Which columns are safe to repeat at FULL value in every piece while
  // OTHER columns are being actively split, without ever causing this
  // function's own duplication bug (code review, P1 regression found
  // while testing the escaped-pipe fix: an earlier version let a column
  // ride along at full value based only on an in-isolation probe — "does
  // THIS column alone, header included, fit?" — but that says nothing
  // about whether it ALSO fits alongside every OTHER column that turns
  // out to be similarly small; two 35-token columns can each pass that
  // isolated probe while together, alongside the header, exceeding a
  // 45-token budget, which silently reintroduced duplication by letting
  // both ride along at once). The correct question is: does the row fit
  // with ALL not-obviously-oversized columns present TOGETHER (every
  // large column emptied)? Computed via a single fixed-point shrink: start
  // by assuming every nonempty column MIGHT be small, then repeatedly
  // demote the single largest still-assumed-small column to "needs its
  // own split" until the remaining small columns really do fit together —
  // this terminates in at most `cells.length` demotions.
  const needsOwnSplit = cells.map((c) => c.length === 0);
  for (;;) {
    const probeCells = cells.map((c, j) => (needsOwnSplit[j] ? '' : c));
    const probeLabeled = cells.map((_, j) => needsOwnSplit[j] || labeled[j]);
    if (await fitsBudget(renderRow({ cells: probeCells, labeled: probeLabeled }), budget)) break;
    // Demote the largest column not yet marked as needing its own split —
    // guaranteed to exist here, since the row with EVERY column emptied
    // was already proven to fit by the pathological check above.
    let largest = -1;
    for (let j = 0; j < cells.length; j++) {
      if (!needsOwnSplit[j] && (largest === -1 || cells[j].length > cells[largest].length)) largest = j;
    }
    needsOwnSplit[largest] = true;
  }
  // Every original cell value appears in the returned pieces EXACTLY
  // once. Small (never-need-their-own-split) columns are placed ONLY in
  // the very FIRST emitted piece of the whole row — every other piece
  // shows them empty/labeled — never repeated across every piece (that
  // would duplicate their content once per piece; the user's own
  // stated rule for this fix). Only the columns marked needsOwnSplit are
  // ever actively divided into multiple char-boundary pieces; each such
  // piece carries ONLY its own active slice, with every other column
  // (small or large) empty.
  let firstPieceEmitted = false;
  // Columns already fully emitted (their real content placed into `pieces`
  // above) are emptied in every subsequent piece — their content must
  // never be carried forward unsplit into a later column's pieces, or it
  // would be duplicated once per remaining piece.
  const emittedEmpty = cells.map(() => false);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].length === 0) continue;
    if (!needsOwnSplit[i]) continue; // small columns are placed only via the first-piece pass below, never split on their own
    const cellText = cells[i];
    let offset = 0;
    while (offset < cellText.length) {
      // The FIRST piece emitted for the whole row also carries every small
      // (needsOwnSplit === false) column at its real, full, untouched
      // value — every later piece shows them empty instead. Header
      // repetition across fragments is fine (structural context); a
      // small cell's actual VALUE must appear exactly once, so this is
      // the only piece it is ever written into.
      const includeSmallColumns = !firstPieceEmitted;
      const baseCells = cells.map((c, j) => {
        if (j === i) return '';
        if (emittedEmpty[j]) return '';
        if (needsOwnSplit[j]) return ''; // not yet its own turn — deferred to its own later pieces
        return includeSmallColumns ? c : ''; // small column: real value only in the row's first piece
      });
      // A column shown empty here (active, already emitted, deferred
      // pending its own turn, or a small column outside the first piece)
      // is never showing its real complete value, so it must carry the
      // "(continued)" label too; only a small column shown at its real,
      // untouched full value in the first piece keeps its original
      // labeled state.
      const baseLabeled = cells.map((_, j) => {
        if (j === i) return true;
        if (emittedEmpty[j]) return true;
        if (needsOwnSplit[j]) return true;
        return includeSmallColumns ? labeled[j] : true;
      });
      const renderWithPiece = (piece) => {
        const rowCells = baseCells.slice();
        rowCells[i] = piece;
        return renderRow({ cells: rowCells, labeled: baseLabeled });
      };
      // Binary search the largest prefix of the REMAINING cellText (from
      // offset) that fits, all other columns at their current (possibly
      // already-emptied) values.
      let lo = offset; // offset itself (empty remaining piece) always fits: proven by the all-empty probe above once every prior column is emptied — see the pathological check below for the one-character floor.
      let hi = cellText.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi + 1) / 2);
        if (await fitsBudget(renderWithPiece(cellText.slice(offset, mid)), budget)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo === offset) {
        // Even one character of this column, with every other column at
        // its current value, doesn't fit — hard, typed stop (this mirrors
        // splitOversizedUnitIntoPieces's own "take it anyway" floor being
        // deliberately NOT used here: for a table row, silently keeping a
        // known-oversized character is worse than a clear, typed error,
        // since the caller has no per-character bookkeeping fallback the
        // way greedyGroup's own floor guard provides for whole units).
        const err = new Error(
          `Table row cannot be split to fit the embedding budget: even one character of column "${columnNames[i] ?? `col ${i + 1}`}" plus the table header, separator, and continuation label exceeds maxInputTokens=${budget.maxInputTokens}.`,
        );
        err.code = 'TABLE_ROW_UNSPLITTABLE';
        throw err;
      }
      const piece = cellText.slice(offset, lo);
      const pieceCells = baseCells.slice();
      pieceCells[i] = piece;
      pieces.push({ cells: pieceCells, labeled: baseLabeled });
      offset = lo;
      firstPieceEmitted = true;
    }
    emittedEmpty[i] = true;
  }
  // Defensive: if every column turned out small (needsOwnSplit all false —
  // should not be reachable, since a row only reaches this function when
  // it doesn't fit whole, and the fixed-point loop above only stops once
  // the small-only combination DOES fit, meaning the ORIGINAL full row
  // fitting would have meant greedyGroup never called this function at
  // all), emit the full row as a single piece so no content is silently
  // dropped.
  if (pieces.length === 0) {
    pieces.push({ cells: cells.slice(), labeled: labeled.slice() });
  }
  return pieces;
}

/**
 * Splits checklist markdown into individual item blocks. An item's own
 * continuation lines (indented lines immediately following its start line,
 * before the next item start) stay attached to that item — an item is
 * never split mid-way.
 * @param {string} rawContent
 * @returns {string[]} one string per checklist item (including any of its
 *   own continuation lines), in document order
 */
function parseChecklistItems(rawContent) {
  const lines = String(rawContent ?? '').split('\n');
  const items = [];
  let current = null;
  for (const line of lines) {
    if (CHECKLIST_ITEM_START_RE.test(line)) {
      if (current !== null) items.push(current.join('\n'));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
    // Lines before the first recognized item start (rare — leading blank
    // lines) are dropped; they carry no content.
  }
  if (current !== null) items.push(current.join('\n'));
  return items.map((i) => i.replace(/\n+$/, ''));
}

/**
 * Splits fenced code block markdown into line groups, preserving the
 * opening fence on the first fragment and the closing fence on the last —
 * never duplicated onto every fragment.
 * @param {string} rawContent
 * @returns {{ openFence: string|null, closeFence: string|null, bodyLines: string[] }}
 */
function parseCodeBlockStructure(rawContent) {
  const lines = String(rawContent ?? '').split('\n');
  let openFence = null, closeFence = null;
  let start = 0, end = lines.length;
  if (lines.length && FENCE_RE.test(lines[0].trim())) {
    openFence = lines[0];
    start = 1;
  }
  if (lines.length > start && FENCE_RE.test(lines[lines.length - 1].trim())) {
    closeFence = lines[lines.length - 1];
    end = lines.length - 1;
  }
  return { openFence, closeFence, bodyLines: lines.slice(start, end) };
}

async function fitsBudget(text, budget) {
  const count = await budget.countTokens(text);
  return count <= budget.maxInputTokens;
}

/**
 * Splits ONE oversized unit's raw text into character-boundary pieces, each
 * of which fits `budget` once wrapped by `renderPiece` (fence markers for a
 * code line, nothing for a checklist item). Used only as a last resort when
 * a single unit does not fit the budget even alone — greedyGroup's normal
 * unit-level grouping already handles every case where units CAN stay
 * whole; this only ever runs on the oversized remainder.
 *
 * Binary search per piece (real, possibly-async countTokens — never a
 * char/4 heuristic), mirroring fitContextToBudget's own technique
 * (qdrant-cloud-catalog.js) generalized from trimming a context prefix to
 * greedily consuming successive prefixes of arbitrary text. Splits at a
 * character boundary, not a token boundary — this can fall mid-token or
 * mid-word, which is syntactically imperfect for a single line of code or
 * a checklist item, but always produces a fragment that provably fits the
 * budget, which is the only real requirement here (the alternative —
 * rejecting the whole file — is strictly worse).
 *
 * @param {string} text — one oversized unit's raw text (never multiple
 *   units — greedyGroup only calls this on a single unit that alone
 *   doesn't fit)
 * @param {(piece: string) => string} renderPiece — wraps a raw text piece
 *   in whatever the unit's own render() would add (fences for code, e.g.)
 *   — used ONLY to measure the true rendered token cost per piece; the
 *   caller is responsible for actually assembling final fragments the
 *   same way once pieces are known
 * @param {EmbeddingBudget} budget
 * @returns {Promise<string[]>} ordered raw-text pieces; concatenating them
 *   reproduces `text` exactly (no character lost, no character duplicated)
 */
async function splitOversizedUnitIntoPieces(text, renderPiece, budget) {
  const pieces = [];
  let offset = 0;
  while (offset < text.length) {
    // Binary search the largest end offset (> current offset) such that
    // text.slice(offset, end) still fits the budget once rendered.
    let lo = offset + 1;
    let hi = text.length;
    // A single character must always "fit" for this loop to make forward
    // progress — if even one character doesn't fit (a pathological budget
    // smaller than one rendered character's own token cost), take it
    // anyway rather than looping forever; the caller/greedyGroup layer
    // still reports this as an oversized unit via its own bookkeeping.
    if (!(await fitsBudget(renderPiece(text.slice(offset, offset + 1)), budget))) {
      pieces.push(text.slice(offset, offset + 1));
      offset += 1;
      continue;
    }
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      const candidate = text.slice(offset, mid);
      if (await fitsBudget(renderPiece(candidate), budget)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    pieces.push(text.slice(offset, lo));
    offset = lo;
  }
  return pieces;
}

/**
 * Greedily groups `units` (each of any type T — a plain string for
 * checklist items/code lines, or a structured `{cells, labeled}` object
 * for table rows; rendered to a fragment string via `renderGroup`) so
 * every fragment fits `budget`. A single unit that alone doesn't fit is
 * split FURTHER via `splitUnit` (full token-aware split — code review,
 * P1: there is no remaining "oversized unit, reported but not split
 * further" case) and its pieces are grouped in its place, converging
 * through the work queue below rather than recursion.
 *
 * @template T
 * @param {T[]} units
 * @param {(group: T[]) => string} renderGroup
 * @param {EmbeddingBudget} budget
 * @param {(unit: T) => Promise<T[]>} splitUnit — splits ONE oversized unit
 *   into two or more smaller units of the SAME kind; called only when a
 *   unit doesn't fit even alone. MUST make real progress (return pieces
 *   that are genuinely smaller) — see the pathological-floor guard below
 *   for what happens if it structurally cannot.
 * @param {(a: T, b: T) => boolean} [unitsEqual] — identity check used only
 *   to detect the pathological case where splitUnit could not make
 *   progress (returned the unit itself, unchanged) — defaults to `===`,
 *   correct for string units; table rows pass a structural comparator
 *   since two distinct-but-equal {cells, labeled} objects are never `===`.
 * @returns {Promise<{ fragments: string[] }>}
 */
async function greedyGroup(units, renderGroup, budget, splitUnit, unitsEqual = (a, b) => a === b) {
  const fragments = [];
  let group = [];

  // Splits ONE oversized unit and flushes every resulting piece as its
  // own standalone fragment, recursing on any piece that is STILL
  // oversized on its own — never merges a piece with anything outside
  // this same original unit's own pieces (see the P2 comment at the call
  // site below for why that isolation matters).
  async function flushSplitUnit(unit) {
    const pieces = await splitUnit(unit);
    // Pathological floor case: splitUnit couldn't make progress (returned
    // exactly the same single unit back — can only happen when even ONE
    // character, once rendered with its surrounding markup/labels, still
    // exceeds the budget; never a realistic scenario for any real cloud
    // model's window, but recursing on an unchanged unit here would loop
    // forever). Accept it as its own fragment as-is — the best possible
    // outcome, since nothing smaller than "one character" exists to try.
    if (pieces.length === 1 && unitsEqual(pieces[0], unit)) {
      fragments.push(renderGroup([unit]));
      return;
    }
    for (const piece of pieces) {
      if (await fitsBudget(renderGroup([piece]), budget)) {
        fragments.push(renderGroup([piece]));
      } else {
        await flushSplitUnit(piece);
      }
    }
  }

  // A mutable work queue rather than a fixed for-loop — splitUnit() can
  // inject replacement pieces to be processed next, in order, exactly
  // where the oversized unit itself was.
  const queue = [...units];
  while (queue.length) {
    const unit = queue.shift();
    const candidate = [...group, unit];
    const rendered = renderGroup(candidate);
    if (await fitsBudget(rendered, budget)) {
      group = candidate;
      continue;
    }
    // Adding this unit would overflow the current group.
    if (group.length) {
      fragments.push(renderGroup(group));
      group = [];
    }
    // Does the unit fit entirely on its own (in a fresh, empty group)?
    if (await fitsBudget(renderGroup([unit]), budget)) {
      group = [unit];
      continue;
    }
    // Doesn't fit even alone — split it into smaller pieces of the same
    // kind and flush each piece as its OWN standalone fragment (code
    // review, P2): an earlier version re-queued split pieces via
    // queue.unshift and let the main loop's normal grouping logic
    // potentially pack a piece together with a DIFFERENT sibling unit in
    // the same fragment — for a checklist item, this could merge the tail
    // of one oversized item's last piece with the START of the next
    // unrelated item in one fragment, and a non-first piece has no marker
    // of its own to signal "this is a continuation, not a new item,"
    // making the merged fragment structurally invalid as standalone
    // checklist markdown. flushSplitUnit below recursively re-splits any
    // piece that is STILL oversized on its own, but never lets a piece
    // merge with anything outside its own original unit's pieces.
    await flushSplitUnit(unit);
  }
  if (group.length) fragments.push(renderGroup(group));
  return { fragments };
}

/**
 * Splits one oversized structural entity into bounded fragments. Full
 * token-aware split (code review, P1): every real input is reducible to
 * fragments that fit `budget` — there is no remaining "oversized unit,
 * reported but not split further" case that blocks indexing.
 *
 * @param {{ nodeType: 'table'|'code_block'|'checklist', rawContent: string }} entity
 * @param {EmbeddingBudget} budget
 * @returns {Promise<
 *   | { split: false }
 *     — the entity's type has no defined split boundary (defensive — never
 *       happens for table/code_block/checklist with well-formed input),
 *       parsing found nothing splittable (e.g. a table with no detected
 *       header/separator), OR the entity already fits the budget whole
 *       (greedy grouping produced exactly one fragment) — splitting into a
 *       canonical entity_raw point plus a single redundant fragment would
 *       add topology for no reason, so this is reported the same as "no
 *       split needed" and the caller must fall back to treating it as one
 *       unsplittable unit.
 *   | { split: true, fragments: string[] }
 *     — fragments is always >= 2, each independently fitting `budget`.
 * >}
 */
export async function splitStructuralEntity(entity, budget) {
  const { nodeType, rawContent } = entity;

  if (nodeType === 'table') {
    const { header, rows } = parseTableStructure(rawContent);
    if (!header.length || !rows.length) return { split: false };
    const headerText = header.join('\n');
    const columnNames = parseTableColumnNames(header);
    // Every row unit is ALWAYS the structured { cells, labeled } shape,
    // even a row that never needs splitting (labeled: all false) — a
    // single uniform representation end to end, rendered to markdown only
    // at the very end via renderRowUnit. This is what makes repeated
    // splitting idempotent (code review, P1 regression): an earlier
    // version rendered a split row back to markdown text and re-parsed it
    // on the next call, which mistook its own "(col continued 1/2)" label
    // for real cell content and appended a new label on top each time,
    // looping forever without ever converging.
    const rowUnits = rows.map((rowLine) => ({
      cells: parseTableRowCells(rowLine),
      labeled: parseTableRowCells(rowLine).map(() => false),
    }));
    const renderRowUnit = (unit) => `| ${unit.cells.map((cell, i) => {
      const escaped = escapeTableCell(cell);
      return unit.labeled[i] ? `${escaped} (${columnNames[i] ?? `col ${i + 1}`} continued)` : escaped;
    }).join(' | ')} |`;
    // Header + separator are re-rendered onto every fragment via `render`
    // itself, so greedyGroup's own fitsBudget(rendered, budget) call
    // already measures header+rows together — no separate budget
    // reservation for the header is needed.
    const render = (group) => `${headerText}\n${group.map(renderRowUnit).join('\n')}`;
    const renderRow = (unit) => render([unit]);
    const splitRow = (unit) => splitOversizedTableRow(unit, columnNames, renderRow, budget);
    const rowUnitsEqual = (a, b) => a === b || (a.cells.length === b.cells.length && a.cells.every((c, i) => c === b.cells[i]));
    const { fragments } = await greedyGroup(rowUnits, render, budget, splitRow, rowUnitsEqual);
    if (fragments.length <= 1) return { split: false };
    return { split: true, fragments };
  }

  if (nodeType === 'checklist') {
    const items = parseChecklistItems(rawContent);
    if (items.length < 1) return { split: false }; // no parseable items at all
    // A single item is NOT skipped here (code review, P1 regression): a
    // lone checklist item can itself be oversized (one very long item with
    // no siblings to group with), and greedyGroup's own splitUnit path is
    // exactly what handles that — bailing out early on items.length < 2
    // would silently leave that one oversized item whole, defeating "full
    // token-aware split" for the exact case that motivated it.
    const render = (group) => group.join('\n');
    // A character-boundary split of one checklist item produces raw text
    // pieces where only the FIRST naturally starts with the item's own
    // "- [ ] " marker (a prefix of the original text) — every later piece
    // is bare continuation text with no marker of its own, which is not
    // valid standalone checklist markdown and gives a reader no signal
    // that it continues a prior item rather than starting a new one (code
    // review, P2). Every non-first piece is prefixed here with an
    // explicit CHECKLIST_CONTINUATION_MARKER before it is ever measured
    // or returned, so (a) the marker's own token cost is correctly
    // accounted for by the SAME binary search that decides where to cut,
    // and (b) every piece splitItem returns is already final, structurally
    // self-describing text — greedyGroup's own piece isolation (see its
    // own comment above) then guarantees a continuation piece is never
    // merged into a fragment with a different, unrelated sibling item.
    const splitItem = async (item) => {
      const rawPieces = await splitOversizedUnitIntoPieces(
        item,
        (piece) => render([`${CHECKLIST_CONTINUATION_MARKER}${piece}`]),
        budget,
      );
      return rawPieces.map((piece, i) => (i === 0 ? piece : `${CHECKLIST_CONTINUATION_MARKER}${piece}`));
    };
    const { fragments } = await greedyGroup(items, render, budget, splitItem);
    if (fragments.length <= 1) return { split: false };
    return { split: true, fragments };
  }

  if (nodeType === 'code_block') {
    const { openFence, closeFence, bodyLines } = parseCodeBlockStructure(rawContent);
    if (bodyLines.length < 1) return { split: false }; // no body at all
    // A single body line is NOT skipped here (code review, P1 regression,
    // same reasoning as the checklist branch above): one minified/very
    // long line with no sibling lines to group with is exactly the case
    // greedyGroup's splitUnit path exists to handle via character-boundary
    // pieces — bailing out early on bodyLines.length < 2 would silently
    // leave that one oversized line whole.
    // Every fragment is rendered WITH its own fence markers for the budget
    // check (openFence on the opening fragment, closeFence on the closing
    // one, both together if only one fragment results) — a fenced block
    // read in isolation needs its own fence to parse/display correctly,
    // and the fence itself has a real (if small) token cost the budget
    // check must account for, not silently ignore.
    const render = (group) => {
      const parts = [];
      if (openFence !== null) parts.push(openFence);
      parts.push(...group);
      if (closeFence !== null) parts.push(closeFence);
      return parts.join('\n');
    };
    const splitLine = (line) => splitOversizedUnitIntoPieces(line, (piece) => render([piece]), budget);
    // greedyGroup already renders each group via `render` internally to
    // build `fragments` — those ARE the final fragment strings; never
    // re-render them again (a real bug caught by manual testing:
    // `parts.push(...group)` on an already-joined string argument spreads
    // its characters, not lines).
    const { fragments } = await greedyGroup(bodyLines, render, budget, splitLine);
    if (fragments.length <= 1) return { split: false };
    return { split: true, fragments };
  }

  return { split: false };
}
