// ── inline SVG icons ────────────────────────────────────────────────────
// Small, hand-authored stroke icons (Feather/Lucide-style visual language:
// 16x16 viewBox, stroke="currentColor", fill="none", stroke-width 1.6, round
// caps/joins) — deliberately NOT an icon-package import, per Phase 3C's
// brief to avoid a "noisy custom icon system." Each function returns a
// plain SVG markup string for direct template-literal interpolation,
// matching this codebase's existing innerHTML= pattern; icons carry no
// user data, so no escaping is needed. Each root <svg> carries
// data-icon="<name>" purely so tests can assert on icon presence without
// matching brittle path data.
const ICON_ATTRS = 'viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export function iconCollection() {
  return `<svg ${ICON_ATTRS} data-icon="collection" class="tree-icon-svg">
    <ellipse cx="8" cy="3.2" rx="5.5" ry="1.8"/>
    <path d="M2.5 3.2v9.6c0 1 2.46 1.8 5.5 1.8s5.5-.8 5.5-1.8V3.2"/>
    <path d="M2.5 8c0 1 2.46 1.8 5.5 1.8s5.5-.8 5.5-1.8"/>
  </svg>`;
}

export function iconDirectory() {
  return `<svg ${ICON_ATTRS} data-icon="directory" class="tree-icon-svg">
    <path d="M1.8 4.2c0-.66.54-1.2 1.2-1.2h3l1.3 1.6h5.9c.66 0 1.2.54 1.2 1.2v6.4c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2z"/>
  </svg>`;
}

export function iconFile() {
  return `<svg ${ICON_ATTRS} data-icon="file" class="tree-icon-svg">
    <path d="M4 1.8h5.2L12.2 4.8v9.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z"/>
    <path d="M9.2 1.8v3h3"/>
  </svg>`;
}

export function iconSection() {
  return `<svg ${ICON_ATTRS} data-icon="section" class="tree-icon-svg">
    <path d="M3 4h10M3 8h7M3 12h9"/>
  </svg>`;
}

export function iconTable() {
  return `<svg ${ICON_ATTRS} data-icon="table" class="tree-icon-svg">
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/>
    <path d="M1.8 6.4h12.4M6.2 2.8v10.4"/>
  </svg>`;
}

export function iconCodeBlock() {
  return `<svg ${ICON_ATTRS} data-icon="code_block" class="tree-icon-svg">
    <path d="M5.4 4 2 8l3.4 4M10.6 4 14 8l-3.4 4"/>
  </svg>`;
}

export function iconChecklist() {
  return `<svg ${ICON_ATTRS} data-icon="checklist" class="tree-icon-svg">
    <path d="M2.4 4h1.8M2.4 8h1.8M2.4 12h1.8"/>
    <path d="M6.4 4h7.2M6.4 8h7.2M6.4 12h7.2"/>
    <path d="M2 3.6l.7.7L4 3"/>
  </svg>`;
}

export function iconChevron({ expanded = false } = {}) {
  const rotation = expanded ? ' style="transform:rotate(90deg)"' : '';
  return `<svg ${ICON_ATTRS} data-icon="chevron" class="tree-icon-svg tree-chevron-svg"${rotation}>
    <path d="M5.5 3l5 5-5 5"/>
  </svg>`;
}

export function iconSearch() {
  return `<svg ${ICON_ATTRS} data-icon="search">
    <circle cx="6.6" cy="6.6" r="4.4"/>
    <path d="M13.5 13.5l-3.6-3.6"/>
  </svg>`;
}

// Status-badge glyphs (design plan §7.4/§8.1: "icon + text + color, never
// color alone" — the shape difference between these four is the
// non-color signal; status-badge.js pairs each with a text label too).
// Same hand-authored stroke-icon language as every icon above.
export function iconStatusOk() {
  return `<svg ${ICON_ATTRS} data-icon="status_ok">
    <circle cx="8" cy="8" r="6"/>
    <path d="M5.2 8.2l2 2 3.6-4.4"/>
  </svg>`;
}

export function iconStatusWarn() {
  return `<svg ${ICON_ATTRS} data-icon="status_warn">
    <path d="M8 2.4 14 13.2H2z"/>
    <path d="M8 6.6v3M8 11.6v.1"/>
  </svg>`;
}

export function iconStatusFail() {
  return `<svg ${ICON_ATTRS} data-icon="status_fail">
    <circle cx="8" cy="8" r="6"/>
    <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/>
  </svg>`;
}

export function iconStatusUnknown() {
  return `<svg ${ICON_ATTRS} data-icon="status_unknown">
    <circle cx="8" cy="8" r="6"/>
    <path d="M6.1 6.3a2 2 0 1 1 2.9 1.8c-.7.4-1 .8-1 1.5"/>
    <path d="M8 11.6v.1"/>
  </svg>`;
}

export function iconGear() {
  return `<svg ${ICON_ATTRS} data-icon="gear">
    <circle cx="8" cy="8" r="2.2"/>
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1M12.2 12.2l-1.1-1.1M4.9 4.9 3.8 3.8"/>
  </svg>`;
}

// Falls back to iconFile()/iconSection() for a node type this module
// doesn't have a dedicated icon for (e.g. paragraph, list, blockquote,
// image, frontmatter — real skeleton node types per
// src/indexer/phases/node-policy.js, but not distinctive enough to warrant
// their own glyph in the sidebar tree today).
const NODE_TYPE_ICON = {
  collection: iconCollection,
  directory: iconDirectory,
  file: iconFile,
  section: iconSection,
  table: iconTable,
  code_block: iconCodeBlock,
  checklist: iconChecklist,
};

export function iconForNodeType(nodeType) {
  const fn = NODE_TYPE_ICON[nodeType];
  if (fn) return fn();
  return nodeType === 'section' ? iconSection() : iconFile();
}
