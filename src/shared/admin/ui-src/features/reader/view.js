import { renderAssemblyBanners, renderAssemblySegments } from '../../assembly-view.js';
import { cloneTemplate, prefersReducedMotion } from '../../dom.js';
import {
  chunksBelongToSection,
  FILE_PAGE_SIZE,
  fileViewHeader,
  renderFileChunks,
} from '../../file-view.js';
import { basename, nodeDisplayLabel } from '../../format.js';
import { showToast } from '../../toasts.js';
import { mount as mountCollectionHome } from '../collection-home/view.js';
import { apiGet } from '../../shared/api/client.js';
import {
  validateReaderAssemblyResponse,
  validateReaderChunksResponse,
  validateReaderNodeResponse,
} from '../../shared/api/contracts/reader.js';
import { createViewController } from '../../shared/lifecycle/view.js';
import { createEmptyState, createErrorState, createLoadingState } from '../../shared/ui/states.js';

function scrollIntoView(element, block = 'nearest') {
  element?.scrollIntoView?.({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block,
  });
}

function targetChunkFromHistory() {
  const value = globalThis.history?.state?.semidexReader?.chunkIndex;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Lifecycle-owned reader for #/c/:name/f/:sourceFile and
 * #/c/:name/n/:nodePath. Collection Home supplies the shared header/search
 * shell; this controller exclusively owns reader requests and mutable state.
 */
export function mount(host, params = {}) {
  const { name, sourceFile = null, nodePath = null } = params;
  const shell = mountCollectionHome(host, { name, searchRestore: 'form' });
  const view = createViewController();
  const panel = host.querySelector('#collection-content-panel');
  const title = host.querySelector('#content-title');
  const box = host.querySelector('#collection-content');
  const searchStatus = host.querySelector('#search-status');
  const searchResults = host.querySelector('#search-results');

  const state = {
    collection: name,
    scope: sourceFile ? 'file' : 'section',
    sourceFile,
    nodePath,
    targetChunkIndex: sourceFile ? targetChunkFromHistory() : null,
    mode: 'document',
    assembly: null,
    chunks: null,
    visibleCount: 0,
    titleText: sourceFile ? (basename(sourceFile) || sourceFile) : nodePath,
    node: null,
  };

  if (!panel || !box || !title || (!sourceFile && !nodePath)) {
    shell.dispose();
    view.dispose();
    return { dispose() {} };
  }

  searchStatus?.replaceChildren();
  searchResults?.replaceChildren();
  panel.style.display = '';
  title.textContent = state.titleText;
  scrollIntoView(panel);
  box.addEventListener('click', (event) => {
    const modeButton = event.target.closest?.('.reader-mode-btn');
    if (modeButton && box.contains(modeButton)) {
      setMode(view, state, box, modeButton.dataset.mode);
      return;
    }
    const loadMore = event.target.closest?.('#file-load-more');
    if (loadMore && box.contains(loadMore) && Array.isArray(state.chunks)) {
      renderVisibleChunks(view, state, box, Math.min(state.visibleCount + FILE_PAGE_SIZE, state.chunks.length));
    }
  }, { signal: view.signal });
  load(view, state, { box, title });

  return {
    dispose() {
      view.dispose();
      shell.dispose();
    },
  };
}

function load(view, state, els) {
  els.box.replaceChildren(createLoadingState('Loading document…'));
  const generation = view.nextGeneration();
  const request = state.scope === 'file'
    ? loadFile(view, state)
    : loadSection(view, state);

  request.then(() => {
    if (!view.isCurrent(generation)) return;
    els.title.textContent = state.titleText;
    if (!state.assembly.segments.length) {
      renderEmpty(state, els.box);
      return;
    }
    renderReader(view, state, els.box);
  }).catch((err) => {
    if (!view.isCurrent(generation)) return;
    if (err.kind === 'not_found') {
      renderEmpty(state, els.box);
      return;
    }
    els.box.replaceChildren(createErrorState(err, {
      retry: () => load(view, state, els),
    }));
  });
}

async function loadFile(view, state) {
  const query = `scope=file&sourceFile=${encodeURIComponent(state.sourceFile)}`;
  state.assembly = validateReaderAssemblyResponse(await apiGet(
    `/api/collections/${encodeURIComponent(state.collection)}/assembly?${query}`,
    { signal: view.signal },
  ));
}

async function loadSection(view, state) {
  const nodeResponse = validateReaderNodeResponse(await apiGet(
    `/api/collections/${encodeURIComponent(state.collection)}/skeleton/node?nodePath=${encodeURIComponent(state.nodePath)}`,
    { signal: view.signal },
  ));
  state.node = nodeResponse.node;
  state.sourceFile = state.node.sourceFile ?? null;
  const fullHeading = Array.isArray(state.node.headingPath) ? state.node.headingPath.at(-1) : null;
  state.titleText = fullHeading || nodeDisplayLabel(state.node);

  const query = `scope=section&nodePath=${encodeURIComponent(state.nodePath)}`;
  state.assembly = validateReaderAssemblyResponse(await apiGet(
    `/api/collections/${encodeURIComponent(state.collection)}/assembly?${query}`,
    { signal: view.signal },
  ));
  if (!state.sourceFile) state.sourceFile = state.assembly.sourceFile ?? null;
}

function renderEmpty(state, box) {
  const message = state.scope === 'section'
    ? 'This section has no indexed content.'
    : 'No searchable chunks in this file. It may only contain navigation/metadata or unsupported content.';
  const empty = createEmptyState(message);
  if (state.scope === 'section' && state.sourceFile) {
    const link = document.createElement('a');
    link.className = 'mini-btn';
    link.id = 'section-open-file-start';
    link.href = `#/c/${encodeURIComponent(state.collection)}/f/${encodeURIComponent(state.sourceFile)}`;
    link.textContent = 'Open file';
    empty.appendChild(link);
  }
  box.replaceChildren(empty);
}

function renderReader(view, state, box) {
  if (state.mode === 'document') {
    const header = readerHeader(view, state, box);
    const banners = renderAssemblyBanners(state.assembly);
    const { root, target } = renderAssemblySegments(state.assembly, {
      targetChunkIndex: state.targetChunkIndex,
      signal: view.signal,
    });
    box.replaceChildren(header, ...banners, root);
    scrollIntoView(target, 'center');
    return;
  }
  renderVisibleChunks(view, state, box, Math.min(FILE_PAGE_SIZE, state.chunks.length));
}

function readerHeader(view, state, box) {
  const headingPath = state.scope === 'section'
    && Array.isArray(state.node?.headingPath)
    && state.node.headingPath.length
    ? state.node.headingPath.join(' › ')
    : null;
  const header = fileViewHeader({
    nodeType: state.scope === 'section' ? 'section' : 'file',
    name: state.titleText,
    sourceFile: state.sourceFile,
    collectionName: state.collection,
    count: state.mode === 'chunks' && Array.isArray(state.chunks) ? state.chunks.length : undefined,
    metaExtra: headingPath,
  });
  const toggle = cloneTemplate('tpl-reader-mode-toggle').querySelector('.reader-mode-toggle');
  for (const button of toggle.querySelectorAll('.reader-mode-btn')) {
    const mode = button.dataset.mode;
    button.classList.toggle('active', state.mode === mode);
    button.setAttribute('aria-pressed', String(state.mode === mode));
  }
  header.querySelector('.file-view-title-row')?.appendChild(toggle);
  return header;
}

async function setMode(view, state, box, mode) {
  if ((mode !== 'document' && mode !== 'chunks') || state.mode === mode) return;
  state.mode = mode;
  if (mode === 'chunks' && state.chunks === null) {
    box.replaceChildren(createLoadingState('Loading chunks…'));
    const generation = view.nextGeneration();
    try {
      const query = `sourceFile=${encodeURIComponent(state.sourceFile)}`;
      const response = validateReaderChunksResponse(await apiGet(
        `/api/collections/${encodeURIComponent(state.collection)}/chunks?${query}`,
        { signal: view.signal },
      ));
      if (!view.isCurrent(generation)) return;
      state.chunks = state.scope === 'section'
        ? chunksBelongToSection(response.chunks, state.nodePath)
        : response.chunks;
    } catch (err) {
      if (!view.isCurrent(generation)) return;
      state.mode = 'document';
      renderReader(view, state, box);
      showToast(`Couldn't load chunks: ${err.message}`, { variant: 'error' });
      return;
    }
  }
  renderReader(view, state, box);
}

function renderVisibleChunks(view, state, box, count) {
  state.visibleCount = count;
  const header = readerHeader(view, state, box);
  box.replaceChildren(header, renderFileChunks(
    state.chunks.slice(0, count),
    state.targetChunkIndex ?? undefined,
    { signal: view.signal },
  ));
  if (count >= state.chunks.length) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini-btn';
  button.id = 'file-load-more';
  button.textContent = 'load more';
  box.appendChild(button);
}
