// ── search: "Search this collection" ───────────────────────────────────────
// Default view is minimal: query + top-k + submit. Everything else (window
// size, compact/full, score display, file scoping) lives inside a native
// <details> "advanced" block so a first-time user sees a plain search box.
// Default result format is FULL (readable prose), not compact — compact is
// an advanced/debug option now.
import { $, cloneTemplate } from './dom.js';
import { apiPost } from './api.js';
import { openFileView, hideCollectionContent } from './file-view.js';

let searchSourceFile = null;
let searchCollectionName = null;

export function initSearchPanel(name) {
  searchSourceFile = null;
  searchCollectionName = name;
  const box = $('#search-panel');
  box.innerHTML = `
    <form class="search-form" id="search-form" autocomplete="off">
      <div class="search-main-row">
        <input type="text" id="q-input" class="q-input"
          placeholder="Ask a question about this collection…">
        <label class="ctl" title="Number of results to return">top
          <select id="q-top">${[3, 5, 10, 20].map(n =>
            `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <button type="submit" class="btn-amber" id="q-submit">Search</button>
      </div>
      <details class="advanced-box">
        <summary>Advanced</summary>
        <div class="search-controls">
          <label class="ctl" title="Extra chunks to show before/after each result">window
            <select id="q-window">${[0, 1, 2, 3, 4, 5].map(n =>
              `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </label>
          <div class="segmented" id="q-format" role="group" aria-label="window format"
               title="Full shows complete neighboring text; compact shows short snippets (debug view)">
            <button type="button" data-v="full" class="on">full</button>
            <button type="button" data-v="compact">compact</button>
          </div>
          <label class="ctl" title="Show the retrieval rank score on each result"><input type="checkbox" id="q-show-score"> score</label>
          <span class="filter-chip" id="q-file-chip" style="display:none">
            <span class="mono" id="q-file-label"></span>
            <button type="button" id="q-file-clear" title="Clear file filter">×</button>
          </span>
        </div>
      </details>
    </form>
    <div id="search-status" class="empty">Results are retrieval evidence — real indexed chunks with scores.
      The sidebar tree is navigation only.</div>
    <div id="search-results"></div>`;

  $('#q-format').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    for (const b of $('#q-format').querySelectorAll('button')) b.classList.toggle('on', b === btn);
  });

  $('#q-file-clear').addEventListener('click', () => clearSearchFile());

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(name);
  });

  updateSearchScopeLabel();
}

function updateSearchScopeLabel() {
  const scope = $('#search-scope');
  if (!scope) return;
  scope.textContent = searchSourceFile
    ? `Searching in: ${searchSourceFile}`
    : `Searching in: ${searchCollectionName}`;
}

export function setSearchFile(sourceFile) {
  searchSourceFile = sourceFile;
  $('#q-file-label').textContent = sourceFile;
  $('#q-file-chip').style.display = '';
  updateSearchScopeLabel();
  $('#search-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#q-input').focus();
}

export function clearSearchFile() {
  searchSourceFile = null;
  $('#q-file-chip').style.display = 'none';
  updateSearchScopeLabel();
}

export async function runSearch(name) {
  const status = $('#search-status');
  const resultsBox = $('#search-results');
  const submit = $('#q-submit');

  const query = $('#q-input').value.trim();
  if (!query) {
    status.className = 'error-box';
    status.textContent = 'Enter a query first.';
    return;
  }

  const top = Number($('#q-top').value);
  const window = Number($('#q-window').value);
  const windowFormat = $('#q-format .on')?.dataset.v ?? 'full';
  const showScore = $('#q-show-score').checked;

  const payload = { collection: name, query, top, window };
  if (window > 0) payload.windowFormat = windowFormat;
  if (searchSourceFile) payload.sourceFile = searchSourceFile;

  submit.disabled = true;
  status.className = 'empty';
  status.textContent = 'searching…';
  resultsBox.innerHTML = '';
  hideCollectionContent();

  try {
    const body = await apiPost('/api/search', payload);
    $('#search-mode').textContent = body.searchMode ? `mode: ${body.searchMode}` : '';
    if (!body.results.length) {
      status.textContent = searchSourceFile
        ? 'No results in the filtered file — try clearing the file filter.'
        : 'No results for this query.';
      return;
    }
    status.textContent = `${body.results.length} result${body.results.length > 1 ? 's' : ''}`
      + (searchSourceFile ? ` · filtered to one file` : '');
    resultsBox.replaceChildren(...body.results.map((r, i) => renderResult(r, i, showScore)));
    for (const btn of resultsBox.querySelectorAll('.result-open')) {
      btn.addEventListener('click', () =>
        openFileView(name, btn.dataset.sf, null, Number(btn.dataset.ci)));
    }
  } catch (err) {
    status.className = 'error-box';
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

// Builds a result-card element from the tpl-search-result template — all
// user/API content (source file, section, score, chunk text, window
// chunks) is filled via textContent/dataset, never string-concatenated
// into markup. Returns the element (not an HTML string) so callers append
// it directly instead of round-tripping through innerHTML.
export function renderResult(r, i, showScore) {
  const canOpen = r.sourceFile && Number.isInteger(r.chunkIndex);
  const frag = cloneTemplate('tpl-search-result');
  const card = frag.querySelector('.result-card');

  card.querySelector('.rank').textContent = `#${i + 1}`;

  const scoreEl = card.querySelector('.score');
  if (showScore && typeof r.score === 'number') {
    scoreEl.textContent = r.score.toFixed(4);
    scoreEl.hidden = false;
  }

  card.querySelector('.result-source').textContent = r.sourceFile ?? '?';
  card.querySelector('.result-chunk-index').textContent =
    `chunk ${r.chunkIndex ?? '?'}${r.totalChunks ? ` / ${r.totalChunks}` : ''}`;
  card.querySelector('.result-section').textContent = r.section || 'intro';

  const nodeTypeEl = card.querySelector('.result-node-type');
  if (r.nodeType) {
    nodeTypeEl.textContent = r.nodeType;
    nodeTypeEl.hidden = false;
  }

  const openBtn = card.querySelector('.result-open');
  if (canOpen) {
    openBtn.dataset.sf = r.sourceFile;
    openBtn.dataset.ci = String(r.chunkIndex);
    openBtn.hidden = false;
  }

  const contextEl = card.querySelector('.chunk-context');
  if (r.context) {
    contextEl.textContent = r.context;
    contextEl.hidden = false;
  }

  card.querySelector('.chunk-text').textContent = r.text ?? '';

  if (Array.isArray(r.windowChunks) && r.windowChunks.length) {
    const winBox = card.querySelector('.win-chunks');
    winBox.hidden = false;
    for (const w of r.windowChunks) {
      const wFrag = cloneTemplate('tpl-window-chunk');
      const wEl = wFrag.querySelector('.win-chunk');
      wEl.classList.toggle('match', Boolean(w.isMatch));
      wEl.querySelector('.win-chunk-index').textContent = `#${w.chunkIndex ?? '?'}`;
      const wBadge = wEl.querySelector('.badge');
      wBadge.hidden = !w.isMatch;
      wEl.querySelector('.win-section').textContent = w.section || '';
      wEl.querySelector('.win-text').textContent = w.textSnippet ?? w.text ?? '';
      winBox.appendChild(wFrag);
    }
  }

  return card;
}
