// ============================================================ minimapa (canvas 2D) + mapa grande com "ir até"
// Orientação: +X à direita, fundo do prédio (-Z) em cima, entrada embaixo — igual a quem entra pela porta.
// api.addMinimapMarker({ pos: {x,z} | () => ({x,z}), color='#d9a441', size=3, shape: 'dot'|'square' }) → remove()
import { $, esc } from './util.js';

const markers = new Set();
let lay = null, rooms = [], statics = null, scale = 1;

export function addMinimapMarker(m) {
  const it = { color: '#d9a441', size: 3, shape: 'dot', ...m };
  markers.add(it);
  return () => markers.delete(it);
}

function drawPlan(ctx, L, s, roomInfo, { labels = false } = {}) {
  const W = L.W, D = L.D;
  ctx.fillStyle = '#e9e4d8'; ctx.fillRect(0, 0, W * s, D * s);
  const at = (gx, gz) => L.grid[gz][gx];
  // piso por área: salas coloridas
  for (const r of L.slots) {
    const c = r.isNew ? '#f3dfa9' : (roomInfo.get(r.id)?.color || '#c9b28a');
    const [x0, z0, x1, z1] = r.interiorCell;
    ctx.fillStyle = c;
    ctx.fillRect(x0 * s, (D - 1 - z1) * s, (x1 - x0 + 1) * s, (z1 - z0 + 1) * s);
  }
  for (let gz = 0; gz < D; gz++) for (let gx = 0; gx < W; gx++) {
    const ch = at(gx, gz);
    let col = null;
    if (ch === '#' || ch === 'W' || ch === 'Q') col = '#3d4652';
    else if (ch === '=' || ch === 'E') col = '#6fa89a';
    else if (ch === '|') col = '#9c8f70';
    else if (ch === 'k') col = '#b9b2a2';
    else if ('RSKCOFXTcB'.includes(ch)) col = 'rgba(80,70,50,.35)';
    else if (ch === 'P') col = '#5f9a55';
    if (col) { ctx.fillStyle = col; ctx.fillRect(gx * s, (D - 1 - gz) * s, s, s); }
  }
  if (labels) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const r of L.slots) {
      const [x0, z0, x1, z1] = r.interiorCell;
      const cx = (x0 + x1 + 1) / 2 * s, cy = (D - (z0 + z1 + 1) / 2) * s;
      const name = r.isNew ? '+ nova sala' : (roomInfo.get(r.id)?.display || r.id);
      ctx.font = `600 ${Math.max(10, s * 0.9)}px "Trebuchet MS", sans-serif`;
      ctx.fillStyle = '#1f2a36';
      const short = name.length > 14 ? name.slice(0, 13) + '…' : name;
      ctx.fillText(short, cx, cy);
    }
    ctx.font = `600 ${Math.max(10, s * 0.8)}px "Trebuchet MS", sans-serif`;
    ctx.fillStyle = '#1f3a5f';
    ctx.fillText('recepção', L.W / 2 * s, (D - 4) * s);
    ctx.fillText('quadro ▸', (L.W - 4) * s, (D - L.b0 - 3) * s);
    ctx.fillText('◂ copa', 4 * s, (D - L.b0 - 3) * s);
  }
}

export function setMinimapLayout(L, roomList) {
  lay = L; rooms = roomList || [];
  const cv = $('#minimap');
  const maxW = 190, maxH = 220;
  scale = Math.min(maxW / L.W, maxH / L.D);
  cv.width = Math.round(L.W * scale * 2); cv.height = Math.round(L.D * scale * 2);
  cv.style.width = `${Math.round(L.W * scale)}px`; cv.style.height = `${Math.round(L.D * scale)}px`;
  statics = document.createElement('canvas');
  statics.width = cv.width; statics.height = cv.height;
  drawPlan(statics.getContext('2d'), L, scale * 2, new Map(rooms.map(r => [r.id, r])));
  mapH = Math.round(L.D * scale) + 6;
  placeHud();
}

// a coluna de slots do HUD começa logo abaixo do minimapa (a altura dele muda com o prédio; no celular ele encolhe)
let mapH = 226;
function placeHud() {
  const k = matchMedia('(max-width: 640px)').matches ? 0.7 : 1;
  const el = $('#hud-right');
  if (el) el.style.top = `${12 + Math.round(mapH * k) + 10}px`;
}
addEventListener('resize', placeHud);

// mundo → pixel do canvas (escala s por metro)
const toPx = (x, z, s) => [x * s, (lay.D + z) * s];

export function drawMinimap(player) {
  if (!lay || !statics) return;
  const cv = $('#minimap'), ctx = cv.getContext('2d'), s = scale * 2;
  ctx.drawImage(statics, 0, 0);
  for (const m of markers) {
    const p = typeof m.pos === 'function' ? m.pos() : m.pos;
    if (!p) continue;
    const [x, y] = toPx(p.x, p.z, s);
    ctx.fillStyle = m.color;
    if (m.shape === 'square') ctx.fillRect(x - m.size, y - m.size, m.size * 2, m.size * 2);
    else { ctx.beginPath(); ctx.arc(x, y, m.size, 0, Math.PI * 2); ctx.fill(); }
  }
  // jogador: seta
  const [x, y] = toPx(player.x, player.z, s);
  ctx.save(); ctx.translate(x, y); ctx.rotate(-player.yaw + Math.PI);
  ctx.fillStyle = '#c0392b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath();
  ctx.fill(); ctx.stroke(); ctx.restore();
}

// mapa grande (tecla M): devolve { html, mount(body, onGo) } para o openPanel
export function bigMapHtml(L, roomList) {
  const list = (roomList || []).map(r => `<button type="button" class="map-go" data-room="${esc(r.id)}"><i style="background:${esc(r.color || '#c9b28a')}"></i>${esc(r.display || r.id)}</button>`).join('');
  return `<div class="map-wrap"><canvas class="map-canvas"></canvas><div class="map-list">
    <button type="button" class="map-go" data-place="spawn"><i style="background:#1f3a5f"></i>Recepção</button>
    <button type="button" class="map-go" data-place="quadro"><i style="background:#b88a4a"></i>Quadro de anotações</button>
    <button type="button" class="map-go" data-place="copa"><i style="background:#6f8a9a"></i>Copa (café)</button>
    ${list}
    ${L.newSlot ? '<button type="button" class="map-go" data-place="new"><i style="background:#d9a441"></i>+ Sala disponível</button>' : ''}
  </div></div>`;
}
export function mountBigMap(body, L, roomList, player, onGo, signal) {
  const cv = body.querySelector('.map-canvas');
  const s = Math.min(560 / L.W, 520 / L.D);
  cv.width = L.W * s * 2; cv.height = L.D * s * 2;
  cv.style.width = `${L.W * s}px`; cv.style.height = `${L.D * s}px`;
  const ctx = cv.getContext('2d');
  drawPlan(ctx, L, s * 2, new Map((roomList || []).map(r => [r.id, r])), { labels: true });
  const [px, py] = [player.x * s * 2, (L.D + player.z) * s * 2];
  ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '700 20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('você', px, py - 14);
  body.addEventListener('click', ev => {
    const b = ev.target.closest('.map-go');
    if (b) onGo(b.dataset.room ? { room: b.dataset.room } : { place: b.dataset.place });
  }, { signal });
  cv.addEventListener('click', ev => {
    const rect = cv.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / rect.width * L.W, z = -L.D + (ev.clientY - rect.top) / rect.height * L.D;
    onGo({ point: { x, z } });
  }, { signal });
}
