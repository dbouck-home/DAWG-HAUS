// Tiny DOM helpers and a modal dialog.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let modalOpen = 0;
export function isModalOpen() { return modalOpen > 0; }

/**
 * openModal({ title, body: Node, buttons: [{label, kind, left, onClick(close) -> false keeps open}] })
 */
export function openModal({ title, body, buttons = [], onClose, width }) {
  const root = document.getElementById('modal-root');
  const foot = h('div', { class: 'mfoot' });
  const modal = h('div', { class: 'modal', style: width ? { width } : null },
    h('h2', {}, title), h('div', { class: 'mbody' }, body), foot);
  const back = h('div', { class: 'modal-backdrop' }, modal);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalOpen--;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      const primary = buttons.find((b) => b.kind === 'primary');
      if (primary) { e.preventDefault(); e.stopPropagation(); if (primary.onClick?.(close) !== false) close(); }
    }
    e.stopPropagation();
  };
  for (const b of buttons) {
    foot.append(h('button', {
      class: `btn ${b.kind || ''} ${b.left ? 'left' : ''}`,
      onclick: () => { if (b.onClick?.(close) !== false) close(); },
    }, b.label));
  }
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  root.append(back);
  modalOpen++;
  const first = modal.querySelector('input, select');
  if (first) setTimeout(() => { first.focus(); first.select?.(); }, 0);
  return close;
}

export function promptText(title, value, label = 'Name') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, maxlength: 80 });
    let result = null;
    openModal({
      title,
      body: h('label', { class: 'row' }, h('span', {}, label), input),
      buttons: [
        { label: 'Cancel' },
        { label: 'OK', kind: 'primary', onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      title,
      body: h('div', { class: 'hint' }, text),
      buttons: [{ label: 'Cancel' }, { label: okLabel, kind: danger ? 'primary danger' : 'primary', onClick: () => { ok = true; } }],
      onClose: () => resolve(ok),
    });
  });
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

/** Small popup menu at screen x/y. items: [{ label, onClick, disabled }] or '-' for a divider. */
export function popupMenu(x, y, items) {
  document.querySelector('.popmenu')?.remove();
  const menu = h('div', { class: 'popmenu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'popsep' })); continue; }
    menu.append(h('button', {
      class: 'popitem', disabled: it.disabled,
      onclick: () => { menu.remove(); it.onClick(); },
    }, it.label, it.hint ? h('small', {}, it.hint) : null));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  return menu;
}
