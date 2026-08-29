// Semantic table/list surface primitive (design plan §7.5, §8.1, §8.6). A
// DOM-producing function over a real <table> with <th scope="col">. Row
// activation (if any) is ONE delegated click/keydown listener on <tbody>,
// never one listener per row (design plan §8.6: "No listener per table
// row. Delegate from the stable owning root."). Cell content goes through
// textContent by default; a column may supply `render(row)` returning
// either a plain value (still textContent'd) or a Node (e.g. a
// createStatusBadge() element) to append directly — never a raw HTML
// string, so there is no way for a column renderer to introduce a new
// innerHTML sink through this primitive.
/**
 * @param {{
 *   columns: Array<{ key?: string, label: string, numeric?: boolean, mono?: boolean, render?: (row: any) => (string|number|Node) }>,
 *   rows: any[],
 *   getRowKey?: (row: any) => string,
 *   onActivateRow?: (rowKey: string, rowEl: HTMLTableRowElement) => void,
 * }} opts
 * @returns {HTMLTableElement}
 */
export function createDataTable({ columns, rows, getRowKey, onActivateRow = null }) {
  const table = document.createElement('table');
  table.className = 'data';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.setAttribute('scope', 'col');
    if (col.numeric) th.className = 'num';
    th.textContent = col.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    if (onActivateRow) {
      tr.className = 'rowlink';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.dataset.rowKey = getRowKey ? getRowKey(row) : '';
    }
    for (const col of columns) {
      const td = document.createElement('td');
      if (col.numeric) td.classList.add('num');
      if (col.mono) td.classList.add('mono');
      const value = col.render ? col.render(row) : row[col.key];
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);

  if (onActivateRow) {
    const activateFromEvent = (e) => {
      const tr = e.target.closest('tr[data-row-key]');
      if (tr && tbody.contains(tr)) onActivateRow(tr.dataset.rowKey, tr);
    };
    tbody.addEventListener('click', activateFromEvent);
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-row-key]');
      if (tr && tbody.contains(tr)) { e.preventDefault(); onActivateRow(tr.dataset.rowKey, tr); }
    });
  }

  return table;
}
