// ============================================================ interação por proximidade + prompt
// api.addInteractable({
//   pos: {x, z} | THREE.Vector3 | () => ({x, z}),   posição (função = objeto que anda, ex.: NPC)
//   radius = 1.6,                                   distância máxima (m) do jogador
//   label: string | () => string,                   título do prompt (HTML escapado pelo núcleo)
//   info?: string | () => string,                   linha menor (ex.: "trabalhando · Edit src/app.py")
//   key = 'KeyE', onInteract(),                     ação principal
//   actions?: [{ key, label, onInteract }],         ações extras (teclas CONTEXTUAIS: E R F X C V)
//   enabled?: () => bool, priority = 0,             desempate: maior prioridade, depois o mais perto
//   layout = false,                                 true = removido sozinho no próximo rebuild do layout
//   owner?: string                                  (depuração)
// }) → { remove(), set(patch), get near() }
import { $, esc, safeCall } from './util.js';
import { emit } from './events.js';

const items = new Set();
let near = null;
let lastHtml = '';

export function addInteractable(def) {
  const it = { radius: 1.6, key: 'KeyE', priority: 0, layout: false, ...def, _alive: true };
  items.add(it);
  return {
    remove() { it._alive = false; items.delete(it); if (near === it) { near = null; render(); emit('nearChanged', null); } },
    set(patch) { Object.assign(it, patch); if (near === it) render(true); },
    get near() { return near === it; },
  };
}

export function clearLayoutInteractables() {
  for (const it of [...items]) if (it.layout) { it._alive = false; items.delete(it); }
  if (near && !near._alive) { near = null; render(); emit('nearChanged', null); }
}

const posOf = it => { const p = typeof it.pos === 'function' ? it.pos() : it.pos; return p || null; };
const val = v => (typeof v === 'function' ? v() : v);
const keyLabel = code => code.replace(/^Key/, '').replace(/^Digit/, '');

function actionsOf(it) {
  const acts = [];
  if (it.onInteract) acts.push({ key: it.key || 'KeyE', label: it.actionLabel || 'interagir', onInteract: it.onInteract });
  for (const a of it.actions || []) acts.push(a);
  return acts;
}

let infoTimer = 0;
export function updateInteract(px, pz, dt, blocked) {
  let best = null, bestScore = Infinity;
  if (!blocked) for (const it of items) {
    if (it.enabled && !safeCall('interativo.enabled', it.enabled)) continue;
    const p = posOf(it);
    if (!p) continue;
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d > it.radius) continue;
    const score = -it.priority * 1000 + d;
    if (score < bestScore) { bestScore = score; best = it; }
  }
  if (best !== near) { near = best; render(true); emit('nearChanged', near); }
  else if (near && (infoTimer -= dt) <= 0) { infoTimer = 0.25; render(); }   // rótulo/info dinâmicos
}

function render(force) {
  const el = $('#prompt');
  if (!el) return;
  if (!near) { if (lastHtml) { el.innerHTML = ''; lastHtml = ''; } return; }
  const title = safeCall('interativo.label', val, near.label) ?? '';
  const info = safeCall('interativo.info', val, near.info) ?? '';
  const acts = actionsOf(near).map(a => `<span class="act"><kbd>${esc(keyLabel(a.key))}</kbd> ${esc(val(a.label) ?? '')}</span>`).join('<span class="gap"></span>');
  const html = `${title ? `<div class="pt">${esc(title)}</div>` : ''}${info ? `<div class="info">${esc(info)}</div>` : ''}<div>${acts}</div>`;
  if (force || html !== lastHtml) { el.innerHTML = html; lastHtml = html; }
}

// tecla contextual apertada: executa a ação do interativo perto. Devolve true se consumiu.
export function contextKey(code) {
  if (!near) return false;
  const a = actionsOf(near).find(x => x.key === code);
  if (!a) return false;
  safeCall(`interação ${code}`, a.onInteract);
  return true;
}

export const currentNear = () => near;
export const interactableCount = () => items.size;
