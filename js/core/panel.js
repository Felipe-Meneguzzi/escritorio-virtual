// ============================================================ painel central genérico (api.openPanel)
// openPanel({ title, meta?, html?, actions?: [{ label, onClick(ev), title?, danger?, primary?, disabled? }], onClose?,
//             width? ('min(880px, …)' padrão; ex. 'min(1100px, calc(100vw - 32px))'), className? })
// html é inserido como está — escape (esc) o que vier do disco/usuário (ou use api.markdown, que já é seguro).
// Devolve um handle: { body, el, buttons, signal, isOpen(), update({ title?, meta?, html? }), close() }
//   signal (AbortSignal) aborta quando ESTE painel fecha ou é trocado por outro — use em addEventListener
import { $, safeCall } from './util.js';
import { emit } from './events.js';
import { setInputEnabled } from './input.js';

let seq = 0, onCloseCb = null, ctrl = null;

function reset(title) {
  seq++;
  if (ctrl) { ctrl.abort(); ctrl = null; }
  if ($('#panel').contains(document.activeElement)) document.activeElement.blur();
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; safeCall('openPanel.onClose', cb); }
  $('#pn-title').textContent = title;
  $('#pn-actions').innerHTML = '';
  $('#pn-body').innerHTML = '';
  return seq;
}

export function openPanel({ title = '', meta = '', html = '', actions = [], onClose = null, width = null, className = '' } = {}) {
  const wasOpen = isPanelOpen();
  const my = reset(title);
  ctrl = new AbortController();
  const el = $('#panel');
  el.style.width = width || '';
  el.className = `open ${className}`.trim();
  $('#pn-meta').textContent = meta;
  $('#pn-meta').hidden = !meta;
  $('#pn-body').innerHTML = html;
  const buttons = [];
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = a.label;
    if (a.title) b.title = a.title;
    if (a.danger) b.classList.add('danger');
    if (a.primary) b.classList.add('primary');
    if (a.disabled) b.disabled = true;
    b.addEventListener('click', ev => safeCall(`openPanel ação '${a.label}'`, a.onClick, ev));
    $('#pn-actions').append(b);
    buttons.push(b);
  }
  onCloseCb = onClose;
  keys_release();
  if (!wasOpen) emit('panel', true);
  const mine = () => my === seq && isPanelOpen();
  return {
    body: $('#pn-body'), el, buttons, signal: ctrl.signal,
    isOpen: mine,
    update({ title: t, meta: m, html: h } = {}) {
      if (!mine()) return false;
      if (t !== undefined) $('#pn-title').textContent = t;
      if (m !== undefined) { $('#pn-meta').textContent = m; $('#pn-meta').hidden = !m; }
      if (h !== undefined) $('#pn-body').innerHTML = h;
      return true;
    },
    close() { if (mine()) closePanel(); },
  };
}

// solta WASD presos (o painel pode abrir com uma tecla de movimento apertada)
function keys_release() { setInputEnabled(false); setInputEnabled(true); }

export function closePanel() {
  if (!isPanelOpen()) return;
  seq++;
  if (ctrl) { ctrl.abort(); ctrl = null; }
  if ($('#panel').contains(document.activeElement)) document.activeElement.blur();
  $('#panel').classList.remove('open');
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; safeCall('openPanel.onClose', cb); }
  emit('panel', false);
}
export const isPanelOpen = () => $('#panel')?.classList.contains('open');

export function initPanel() {
  $('#pn-close').addEventListener('click', closePanel);
  $('#panel-backdrop').addEventListener('click', closePanel);
}
