// ============================================================ HUD: crachá da empresa, sala atual, ajuda, slots, desempenho
import { $, esc } from './util.js';
import { NATIVE_HELP, featureKeys, setHelpListener } from './input.js';

const HELP_KEY = 'esc.helpMin';

export function setCompany(name, sub = '') {
  $('#co-name').textContent = name;
  $('#co-where').textContent = sub;
}
export function setWhere(text) { $('#co-where').textContent = text; }

export function renderHelp() {
  const el = $('#help');
  const rows = [...NATIVE_HELP, ...featureKeys().filter(k => k.help).map(k => [k.label, k.help])];
  el.innerHTML = `<div class="toggle">Teclas</div>${rows.map(([k, h]) => `<span><kbd>${esc(k)}</kbd></span><span>${esc(h)}</span>`).join('')}`;
  el.querySelector('.toggle').addEventListener('click', toggleHelp);
}
export function toggleHelp() {
  const el = $('#help');
  el.classList.toggle('min');
  try { localStorage.setItem(HELP_KEY, el.classList.contains('min') ? '1' : '0'); } catch { /* sem storage */ }
}

// api.hudSlot(id, { wide=false, order=0 }) → <div> na coluna da direita (sob o minimapa), criado uma vez por id
const slots = new Map();
export function hudSlot(id, { wide = false, order = 0 } = {}) {
  if (slots.has(id)) return slots.get(id);
  const d = document.createElement('div');
  d.className = 'hud-slot' + (wide ? ' wide' : '');
  d.dataset.slot = id;
  d.style.order = order;
  $('#hud-right').append(d);
  slots.set(id, d);
  return d;
}

let perfOn = false;
export function togglePerf() { perfOn = !perfOn; $('#perf').hidden = !perfOn; }
export function renderPerf(s) {
  if (!perfOn) return;
  $('#perf').textContent = `${s.fps.toFixed(0)} fps · ${s.calls} draw calls · ${(s.triangles / 1000).toFixed(1)}k tri · res ${s.ratio.toFixed(2)} · ${s.tier}` +
    ` · ${s.colliders} colisores · ${s.interactables} interativos · ${s.characters} bonecos`;
}

export function initHud() {
  setHelpListener(renderHelp);
  renderHelp();
  let pref = null;
  try { pref = localStorage.getItem(HELP_KEY); } catch { /* */ }
  if (pref === '1') $('#help').classList.add('min');
  // 1ª visita: a ajuda abre inteira e se recolhe sozinha depois de 45 s (H ou um clique trazem de volta)
  else if (pref === null) setTimeout(() => {
    let now = null;
    try { now = localStorage.getItem(HELP_KEY); } catch { /* */ }
    if (now === null && !$('#help').classList.contains('min')) toggleHelp();
  }, 45000);
}
