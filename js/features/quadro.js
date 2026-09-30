// ============================================================ PACOTE quadro — QUADRO DE ANOTAÇÕES
// Quadro de cortiça na parede leste da área comum (api.office.zones.quadroWall). Cada .md de <escritório>/quadro/
// vira um post-it preso com tachinha (cor pela nota, título = 1º "# título" ou o nome do arquivo, textura legível
// de perto). Chegar perto: E abre o painel (lista + editor + pré-visualização SEGURA via api.markdown), C nova nota;
// Q abre de qualquer lugar. Conflito de edição por etag (outra aba, um funcionário Claude ou um editor externo).
// Post-it novo "voa" do bloquinho (ou da mão do jogador) até o quadro quando o painel fecha.
// Backend: features/quadro.py (rotas /api/quadro*). Contrato: ARCH.md §Quadro.
//
// Orçamento de GPU: moldura+bandeja+bloquinho = 1 malha mesclada (cores por vértice); cortiça 1; placa 1; enfeite 1;
// TODOS os post-its = 1 malha mesclada com atlas (1 textura de canvas); sombras 1; tachinhas 1 InstancedMesh.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const PAPERS = [
  { bg: '#fff27a', ink: '#3b3522', name: 'amarelo' },
  { bg: '#ffbcd2', ink: '#44262f', name: 'rosa' },
  { bg: '#b2e5f7', ink: '#1f3440', name: 'azul' },
  { bg: '#caef9f', ink: '#2c3a1f', name: 'verde' },
  { bg: '#ffd08c', ink: '#43301a', name: 'laranja' },
  { bg: '#ddcdf7', ink: '#302645', name: 'lilás' },
];
const PIN_COLORS = ['#d23b2f', '#2f6fd2', '#2f9e4a', '#e0a21a', '#8a3fc4', '#e36a1a'];
const HAND = '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive';
const SANS = '"Segoe UI", "Trebuchet MS", Arial, sans-serif';
const ATLAS = 1024;
const Z_NOTE = 0.018;          // distância dos post-its até a parede (m)
const VIEW_KEY = 'esc.quadro.view';

let api = null, U = null;
const S = {
  office: null, notes: [], byName: new Map(), etag: null, known: null, max: 300, noteMax: 256 * 1024,
  fly: new Set(),               // notas que ainda vão "voar" até o quadro (fora da malha até pousar)
  flights: [], falls: [],       // animações em curso
};
let board = null;               // {root, W, H, cy, region, notesMesh, shadowMesh, pins, hl, slots, grid, pad}
let M = null;                   // materiais/texturas (criados uma vez)
let refreshing = null, refreshAgain = false;
let focusSlot = null, focusT = 0;
let chip = null;

// ============================================================ materiais e texturas (uma vez)
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function corkTexture() {
  const c = canvas(256, 256), x = c.getContext('2d'), r = U.rng('cortiça');
  x.fillStyle = '#b8895a'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const l = r();
    x.fillStyle = l < 0.45 ? `rgba(92,58,28,${0.18 + r() * 0.3})` : l < 0.8 ? `rgba(222,182,130,${0.2 + r() * 0.35})` : `rgba(60,36,16,${0.25 + r() * 0.3})`;
    const s = 0.8 + r() * 2.4;
    x.fillRect(r() * 256, r() * 256, s, s * (0.6 + r() * 0.8));
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  return t;
}

function signTexture() {
  const c = canvas(1024, 128), x = c.getContext('2d');
  x.fillStyle = '#1f3a5f'; x.fillRect(0, 0, 1024, 128);
  x.strokeStyle = '#d9a441'; x.lineWidth = 6; x.strokeRect(8, 8, 1008, 112);
  x.fillStyle = '#f7f1e3'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `700 62px ${SANS}`;
  x.fillText('QUADRO DE ANOTAÇÕES', 512, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  return t;
}

// enfeite fixo à esquerda da cortiça: "Funcionário do mês" + aviso da gerência (bem The Office)
function decorTexture() {
  const c = canvas(256, 512), x = c.getContext('2d');
  x.clearRect(0, 0, 256, 512);
  // certificado
  x.save(); x.translate(128, 150); x.rotate(-0.035);
  x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(-100, -126, 206, 262);
  x.fillStyle = '#fbf7ea'; x.fillRect(-104, -132, 206, 262);
  x.strokeStyle = '#c99a2e'; x.lineWidth = 5; x.strokeRect(-96, -124, 190, 246);
  x.fillStyle = '#1f3a5f'; x.textAlign = 'center';
  x.font = `700 17px ${SANS}`; x.fillText('FUNCIONÁRIO', 0, -96); x.fillText('DO MÊS', 0, -76);
  // retrato
  x.fillStyle = '#dfe6ea'; x.fillRect(-52, -64, 104, 118);
  x.fillStyle = '#2c3440'; x.beginPath(); x.moveTo(-46, 54); x.lineTo(-40, 14); x.quadraticCurveTo(0, -4, 40, 14); x.lineTo(46, 54); x.fill();
  x.fillStyle = '#ffffff'; x.beginPath(); x.moveTo(-10, 8); x.lineTo(0, 30); x.lineTo(10, 8); x.fill();
  x.fillStyle = '#b0302a'; x.beginPath(); x.moveTo(-4, 10); x.lineTo(4, 10); x.lineTo(6, 42); x.lineTo(0, 50); x.lineTo(-6, 42); x.fill();
  x.fillStyle = '#e8c09a'; x.beginPath(); x.arc(0, -18, 22, 0, TAU); x.fill();
  x.fillStyle = '#4a3322'; x.beginPath(); x.arc(0, -26, 22, Math.PI * 1.05, Math.PI * 1.95); x.fill();
  x.fillStyle = '#222'; x.fillRect(-9, -21, 4, 4); x.fillRect(5, -21, 4, 4);
  x.strokeStyle = '#7a3a2a'; x.lineWidth = 2; x.beginPath(); x.arc(0, -12, 8, 0.2, Math.PI - 0.2); x.stroke();
  x.fillStyle = '#1f2a36'; x.font = `italic 700 18px ${HAND}`; x.fillText('Você?', 0, 82);
  x.fillStyle = '#c99a2e'; x.beginPath(); x.arc(58, 96, 15, 0, TAU); x.fill();
  x.fillStyle = '#fff3c4'; x.font = `700 12px ${SANS}`; x.fillText('Nº1', 58, 100);
  x.restore();
  x.fillStyle = '#d23b2f'; x.beginPath(); x.arc(128, 26, 7, 0, TAU); x.fill();
  x.fillStyle = 'rgba(255,255,255,.6)'; x.beginPath(); x.arc(126, 24, 2.5, 0, TAU); x.fill();
  // aviso da gerência
  x.save(); x.translate(128, 395); x.rotate(0.05);
  x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(-92, -78, 190, 164);
  x.fillStyle = '#e8f1fb'; x.fillRect(-96, -84, 190, 164);
  x.fillStyle = '#b03a2e'; x.font = `900 22px ${SANS}`; x.textAlign = 'center'; x.fillText('AVISO', 0, -52);
  x.fillStyle = '#1f2a36'; x.font = `600 14px ${SANS}`;
  ['Proibido esquentar', 'PEIXE no micro-ondas.', 'Isso vale pra você,', 'Kevin.'].forEach((l, i) => x.fillText(l, 0, -24 + i * 19));
  x.font = `italic 13px ${HAND}`; x.fillText('— A Gerência', 22, 66);
  x.restore();
  x.fillStyle = '#2f6fd2'; x.beginPath(); x.arc(122, 316, 7, 0, TAU); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  return t;
}

function shadowTexture() {
  const c = canvas(64, 64), x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 8, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(0.6, 'rgba(0,0,0,.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function makeMaterials() {
  const shared = m => { m.userData.shared = true; return m; };
  const atlasCanvas = canvas(ATLAS, ATLAS);
  const atlasTex = new THREE.CanvasTexture(atlasCanvas);
  atlasTex.colorSpace = THREE.SRGBColorSpace; atlasTex.anisotropy = 4;
  M = {
    atlasCanvas, atlasTex,
    frame: shared(new THREE.MeshLambertMaterial({ vertexColors: true })),
    cork: shared(new THREE.MeshLambertMaterial({ map: corkTexture() })),
    sign: shared(new THREE.MeshBasicMaterial({ map: signTexture() })),
    decor: shared(new THREE.MeshLambertMaterial({ map: decorTexture(), transparent: true, alphaTest: 0.05 })),
    atlas: shared(new THREE.MeshLambertMaterial({ map: atlasTex, side: THREE.DoubleSide })),
    shadow: shared(new THREE.MeshBasicMaterial({ map: shadowTexture(), color: '#000000', transparent: true, depthWrite: false, opacity: 0.55 })),
    pin: shared(new THREE.MeshLambertMaterial({ color: '#ffffff' })),
    hl: shared(new THREE.MeshBasicMaterial({ color: '#d9a441' })),
    papers: PAPERS.map(p => shared(new THREE.MeshLambertMaterial({ color: p.bg, side: THREE.DoubleSide }))),
  };
  const pinG = [new THREE.CylinderGeometry(0.017, 0.02, 0.008, 10), new THREE.CylinderGeometry(0.009, 0.012, 0.016, 8), new THREE.CylinderGeometry(0.014, 0.014, 0.006, 10)];
  pinG[0].translate(0, 0.004, 0); pinG[1].translate(0, 0.016, 0); pinG[2].translate(0, 0.027, 0);
  M.pinGeo = mergeGeometries(pinG.map(g => g.toNonIndexed()), false);
  M.pinGeo.rotateX(Math.PI / 2);               // eixo da tachinha para fora da parede (+Z local)
  M.pinGeo.userData.shared = true;
  for (const g of pinG) g.dispose();
}

// ============================================================ utilidades
const paperOf = name => PAPERS[U.hashStr(name) % PAPERS.length];
const byteLen = s => new TextEncoder().encode(s).length;
const noteTitle = n => n?.title || (n?.name || '').replace(/\.md$/i, '');

function wrapText(ctx, text, maxW, maxLines) {
  const fits = t => ctx.measureText(t).width <= maxW;
  const out = [];
  let cur = '', cut = false;
  for (let w of String(text || '').split(/\s+/).filter(Boolean)) {
    while (!fits(w) && w.length > 1) {                  // palavra comprida demais: quebra no meio
      let k = w.length - 1;
      while (k > 1 && !fits(w.slice(0, k))) k--;
      if (cur) { out.push(cur); cur = ''; }
      out.push(w.slice(0, k)); w = w.slice(k);
    }
    const t = cur ? `${cur} ${w}` : w;
    if (fits(t)) cur = t; else { out.push(cur); cur = w; }
    if (out.length >= maxLines) { cut = true; break; }
  }
  if (cur && !cut) out.push(cur);
  if (out.length > maxLines) cut = true;
  const res = out.slice(0, maxLines);
  if (cut && res.length) {
    let l = res[res.length - 1];
    while (l.length > 1 && !fits(`${l}…`)) l = l.slice(0, -1);
    res[res.length - 1] = `${l.replace(/\s+$/, '')}…`;
  }
  return res;
}

// ============================================================ atlas dos post-its
function drawNoteCell(ctx, x0, y0, cs, note) {
  const p = paperOf(note.name);
  const g = 3;                               // calha contra vazamento entre células (mipmap)
  const w = cs - g * 2;
  ctx.save();
  ctx.translate(x0 + g, y0 + g);
  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, w, w);
  const top = ctx.createLinearGradient(0, 0, 0, w * 0.2);   // faixa de cola, um tom mais escuro
  top.addColorStop(0, 'rgba(0,0,0,.09)'); top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top; ctx.fillRect(0, 0, w, w * 0.2);
  const curl = ctx.createLinearGradient(0, w * 0.72, 0, w);   // pontinha levantada embaixo
  curl.addColorStop(0, 'rgba(0,0,0,0)'); curl.addColorStop(1, 'rgba(0,0,0,.12)');
  ctx.fillStyle = curl; ctx.fillRect(0, w * 0.72, w, w * 0.28);
  const pad = w * 0.085, maxW = w - pad * 2;
  // título (letra de mão)
  let ts = w * 0.13;
  ctx.fillStyle = p.ink; ctx.textBaseline = 'top';
  ctx.font = `700 ${ts}px ${HAND}`;
  let tl = wrapText(ctx, noteTitle(note), maxW, 2);
  if (tl.length === 2 && ctx.measureText(tl[1]).width > maxW * 0.98) { ts *= 0.9; ctx.font = `700 ${ts}px ${HAND}`; tl = wrapText(ctx, noteTitle(note), maxW, 2); }
  let y = pad * 0.9 + w * 0.05;
  for (const l of tl) { ctx.fillText(l, pad, y); y += ts * 1.12; }
  // risquinho embaixo do título
  ctx.strokeStyle = p.ink; ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(1, w * 0.008);
  ctx.beginPath(); ctx.moveTo(pad, y + ts * 0.05);
  for (let k = 1; k <= 8; k++) ctx.lineTo(pad + (maxW * 0.7) * k / 8, y + ts * 0.05 + (k % 2 ? 1.2 : -1.2) * (w / 200));
  ctx.stroke(); ctx.globalAlpha = 1;
  y += ts * 0.35;
  // corpo (linhas limpas vindas do backend)
  const bs = w * 0.074, lh = bs * 1.28;
  ctx.font = `500 ${bs}px ${SANS}`;
  ctx.fillStyle = p.ink; ctx.globalAlpha = 0.9;
  const src = note.lines?.length ? note.lines : (note.excerpt ? [note.excerpt] : []);
  const bottom = w - pad * 0.8;
  outer: for (const raw of src) {
    let text = raw, box = null;
    const m = /^([☐☑])\s*(.*)$/.exec(raw);
    if (m) { box = m[1] === '☑'; text = m[2]; }
    const indent = box === null ? 0 : bs * 1.05;
    const lines = wrapText(ctx, text, maxW - indent, 3);
    for (let i = 0; i < lines.length; i++) {
      if (y + bs > bottom) break outer;
      if (box !== null && i === 0) {
        const b = bs * 0.72, by = y + bs * 0.18;
        ctx.lineWidth = Math.max(1, w * 0.008); ctx.strokeRect(pad + 0.5, by, b, b);
        if (box) { ctx.beginPath(); ctx.moveTo(pad + b * 0.15, by + b * 0.5); ctx.lineTo(pad + b * 0.42, by + b * 0.85); ctx.lineTo(pad + b * 1.05, by - b * 0.1); ctx.stroke(); }
      }
      ctx.fillText(lines[i], pad + indent, y);
      y += lh;
    }
    y += bs * 0.15;
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawOverflowCell(ctx, x0, y0, cs, extra) {
  const g = 3, w = cs - g * 2;
  ctx.save(); ctx.translate(x0 + g, y0 + g);
  ctx.fillStyle = '#f4f1e8'; ctx.fillRect(0, 0, w, w);
  ctx.fillStyle = '#1f3a5f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${w * 0.26}px ${HAND}`; ctx.fillText(`+${extra}`, w / 2, w * 0.42);
  ctx.font = `500 ${w * 0.09}px ${SANS}`; ctx.fillText('notas — tecla Q', w / 2, w * 0.72);
  ctx.restore();
}

// ============================================================ grade das fichas no quadro (estável)
function gridFor(n, regW, regH) {
  const sizes = [0.36, 0.30, 0.26, 0.22, 0.19];
  let best = null;
  for (const s of sizes) {
    const cols = Math.max(1, Math.floor((regW + 0.05) / (s + 0.06)));
    const rows = Math.max(1, Math.floor((regH + 0.05) / (s + 0.075)));
    best = { s, cols, rows, cap: cols * rows };
    if (best.cap >= n) break;
  }
  // ordem de preenchimento: do meio para fora (quadro com poucas notas não fica todo num canto); fixa para a
  // mesma grade → adicionar nota não mexe nas outras
  const cells = [];
  for (let r = 0; r < best.rows; r++) for (let c = 0; c < best.cols; c++) {
    const dx = (c + 0.5) / best.cols - 0.46, dy = (r + 0.5) / best.rows - 0.45;
    cells.push({ c, r, k: Math.abs(dx) * regW * 0.9 + Math.abs(dy) * regH * 1.3 + ((U.hashStr(`${c},${r}`) % 100) / 100) * 0.12 });
  }
  cells.sort((a, b) => a.k - b.k);
  best.order = cells;
  best.perRow = Math.ceil(Math.sqrt(best.cap));
  best.cellPx = Math.floor(ATLAS / best.perRow);
  return best;
}

// ============================================================ geometria de um post-it (quad com a ponta curvada)
function noteQuad(s, uv, curl) {
  // 3 fileiras de vértices: base (curvada), 22% (dobra) e topo
  const rowsV = [0, 0.22, 1], pos = [], uvs = [], idx = [];
  for (const fv of rowsV) for (const fu of [0, 1]) {
    const z = fv < 0.22 ? curl * Math.pow((0.22 - fv) / 0.22, 1.6) : 0;
    pos.push((fu - 0.5) * s, (fv - 0.5) * s, z);
    uvs.push(uv.u0 + (uv.u1 - uv.u0) * fu, uv.v0 + (uv.v1 - uv.v0) * fv);
  }
  for (let r = 0; r < 2; r++) { const a = r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function cellUv(i, grid) {
  const cs = grid.cellPx, cx = (i % grid.perRow) * cs, cy = Math.floor(i / grid.perRow) * cs, g = 3;
  return { u0: (cx + g) / ATLAS, u1: (cx + cs - g) / ATLAS, v0: 1 - (cy + cs - g) / ATLAS, v1: 1 - (cy + g) / ATLAS };
}

// ============================================================ construção do quadro (a cada layoutChanged)
function buildBoard() {
  board = null;
  const qw = api.office?.zones?.quadroWall;
  if (!qw) return;
  const g = api.layoutGroup('quadro');
  const span = Math.abs(qw.z1 - qw.z0);
  const root = new THREE.Group();
  root.name = 'quadro';
  root.position.set(qw.x, 0, (qw.z0 + qw.z1) / 2);
  root.rotation.y = qw.yaw;                     // local: X ao longo do quadro (direita de quem olha), Z para fora
  g.add(root);
  const Wf = span - 0.16, y0 = qw.y0, y1 = qw.y1, Hf = y1 - y0, ft = 0.05;
  const W = Wf - ft * 2, H = Hf - ft * 2, cy = (y0 + y1) / 2;

  // moldura + bandeja + bloquinho de post-its + caneta: uma malha só (cores por vértice)
  const parts = [];
  const box = (w, h, d, x, y, z, color) => {
    const b = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    b.translate(x, y, z);
    const col = new THREE.Color(color), n = b.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    b.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(b);
  };
  const wood = '#9c7447', woodD = '#7d5a34';
  box(Wf, ft, 0.04, 0, y1 - ft / 2, 0.02, wood);
  box(Wf, ft, 0.04, 0, y0 + ft / 2, 0.02, wood);
  box(ft, Hf - ft * 2, 0.04, -Wf / 2 + ft / 2, cy, 0.02, woodD);
  box(ft, Hf - ft * 2, 0.04, Wf / 2 - ft / 2, cy, 0.02, woodD);
  box(Wf - 0.1, 0.02, 0.075, 0, y0 - 0.005, 0.04, '#a7afb6');                 // bandeja de alumínio
  box(Wf - 0.1, 0.035, 0.01, 0, y0 + 0.008, 0.078, '#b7bfc6');
  const padU = Wf / 2 - 0.32, padY = y0 + 0.005;
  box(0.1, 0.035, 0.09, padU, padY + 0.0175, 0.042, '#f2e46a');               // bloquinho amarelo
  box(0.1, 0.004, 0.09, padU, padY + 0.036, 0.042, '#fff27a');
  box(0.09, 0.025, 0.08, padU - 0.13, padY + 0.0125, 0.042, '#ffbcd2');        // bloquinho rosa
  box(0.16, 0.012, 0.012, padU - 0.3, padY + 0.006, 0.05, '#2f5fb8');          // caneta
  box(0.03, 0.013, 0.013, padU - 0.39, padY + 0.0065, 0.05, '#1c2b44');
  const frameGeo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  root.add(new THREE.Mesh(frameGeo, M.frame));

  const corkG = new THREE.PlaneGeometry(W, H);
  corkG.translate(0, cy, 0.012);
  M.cork.map.repeat.set(W / 0.7, H / 0.7);
  root.add(new THREE.Mesh(corkG, M.cork));

  const signW = Math.min(1.5, Wf * 0.42);
  const signG = new THREE.PlaneGeometry(signW, signW / 8);
  signG.translate(0, y1 + 0.2, 0.012);
  root.add(new THREE.Mesh(signG, M.sign));

  const decW = 0.5, decH = 1.0;
  const decG = new THREE.PlaneGeometry(decW, decH);
  decG.translate(-W / 2 + 0.04 + decW / 2, cy, 0.016);
  root.add(new THREE.Mesh(decG, M.decor));

  // região das notas (à direita do enfeite)
  const rx0 = -W / 2 + 0.04 + decW + 0.06, rx1 = W / 2 - 0.05;
  const region = { x0: rx0, x1: rx1, y0: cy - H / 2 + 0.05, y1: cy + H / 2 - 0.04 };
  const hl = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), M.hl);
  hl.visible = false;
  root.add(hl);
  board = { root, W, H, cy, region, hl, notesMesh: null, shadowMesh: null, pins: null, slots: [], grid: null,
    pad: new THREE.Vector3(padU, padY + 0.06, 0.06) };
  root.updateMatrixWorld(true);

  api.addInteractable({
    layout: true, owner: 'quadro', priority: 0, radius: 2.7,
    pos: { x: qw.x - 1.25, z: (qw.z0 + qw.z1) / 2 },
    label: 'Quadro de anotações',
    info: () => {
      const f = focusSlot && S.byName.get(focusSlot.name);
      if (f) return `📝 “${noteTitle(f)}” · ${U.fmtAgo(f.mtime)}`;
      return S.notes.length ? `${S.notes.length} nota${S.notes.length > 1 ? 's' : ''} · mire numa nota para abri-la` : 'nenhuma nota ainda — crie a primeira!';
    },
    actionLabel: () => (focusSlot ? 'abrir esta nota' : 'abrir o quadro'),
    onInteract: () => openBoard({ select: focusSlot?.name }),
    actions: [{ key: 'KeyC', label: 'nova nota', onInteract: () => openBoard({ create: true }) }],
  });
  rebuildNotes();
}

function disposeNotes() {
  if (!board) return;
  for (const k of ['notesMesh', 'shadowMesh', 'pins']) {
    const m = board[k];
    if (m) { m.removeFromParent(); if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose(); if (m.isInstancedMesh) m.dispose(); board[k] = null; }
  }
}

// desenha o atlas e remonta a malha das notas (depois de mudar a lista ou o layout)
function rebuildNotes() {
  if (!board) return;
  disposeNotes();
  const reg = board.region, regW = reg.x1 - reg.x0, regH = reg.y1 - reg.y0;
  const n = S.notes.length;
  const grid = gridFor(n, regW, regH);
  board.grid = grid;
  const shown = n > grid.cap ? grid.cap - 1 : n;
  const extra = n - shown;
  // atlas
  const ctx = M.atlasCanvas.getContext('2d');
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  const slots = [];
  const sx = regW / grid.cols, sy = regH / grid.rows;
  for (let i = 0; i < shown + (extra ? 1 : 0); i++) {
    const cell = grid.order[i];
    const note = i < shown ? S.notes[i] : null;
    const seed = note ? note.name : '+mais';
    const r = U.rng(`${seed}|quadro`);
    const cu = reg.x0 + (cell.c + 0.5) * sx + (r() - 0.5) * Math.max(0, sx - grid.s) * 0.7;
    const cv = reg.y1 - (cell.r + 0.5) * sy + (r() - 0.5) * Math.max(0, sy - grid.s) * 0.5;
    const rot = (r() - 0.5) * 0.16;
    const px = grid.cellPx * (i % grid.perRow), py = grid.cellPx * Math.floor(i / grid.perRow);
    if (note) drawNoteCell(ctx, px, py, grid.cellPx, note); else drawOverflowCell(ctx, px, py, grid.cellPx, extra);
    slots.push({ i, name: note?.name || null, overflow: !note, u: cu, v: cv, rot, s: grid.s, z: Z_NOTE + i * 0.0007,
      pin: PIN_COLORS[U.hashStr(`${seed}pin`) % PIN_COLORS.length], curl: 0.012 + r() * 0.02 });
  }
  M.atlasTex.needsUpdate = true;
  board.slots = slots;
  // malha mesclada (sem as que ainda vão voar)
  const quads = [], shadows = [];
  const visible = slots.filter(s => !s.name || !S.fly.has(s.name));
  for (const s of visible) {
    const q = noteQuad(s.s, cellUv(s.i, grid), s.curl);
    q.rotateZ(s.rot); q.translate(s.u, s.v, s.z);
    quads.push(q);
    const sh = new THREE.PlaneGeometry(s.s * 1.18, s.s * 1.18);
    sh.rotateZ(s.rot); sh.translate(s.u + 0.012, s.v - 0.016, 0.0135 + s.i * 0.00001);
    shadows.push(sh);
  }
  if (quads.length) {
    const ng = mergeGeometries(quads, false), sg = mergeGeometries(shadows, false);
    for (const q of [...quads, ...shadows]) q.dispose();
    board.notesMesh = new THREE.Mesh(ng, M.atlas);
    board.shadowMesh = new THREE.Mesh(sg, M.shadow);
    board.shadowMesh.renderOrder = 1;
    board.root.add(board.shadowMesh, board.notesMesh);
    const pins = new THREE.InstancedMesh(M.pinGeo, M.pin, visible.length);
    const mtx = new THREE.Matrix4(), col = new THREE.Color();
    visible.forEach((s, k) => {
      const [px, py] = pinPos(s);
      mtx.makeTranslation(px, py, s.z + 0.002);
      pins.setMatrixAt(k, mtx);
      pins.setColorAt(k, col.set(s.pin));
    });
    pins.instanceMatrix.needsUpdate = true;
    if (pins.instanceColor) pins.instanceColor.needsUpdate = true;
    board.pins = pins;
    board.root.add(pins);
  }
  if (focusSlot) focusSlot = board.slots.find(s => s.name === focusSlot.name) || null;
  updateHighlight();
}

function pinPos(s) {
  const ox = 0, oy = s.s * 0.38;
  return [s.u + ox * Math.cos(s.rot) - oy * Math.sin(s.rot), s.v + ox * Math.sin(s.rot) + oy * Math.cos(s.rot)];
}

// ============================================================ animações: voar até o quadro / cair no chão
function playerLocal() {
  const v = new THREE.Vector3(api.player.x, 1.15, api.player.z);
  return board.root.worldToLocal(v);
}

function runFlights() {
  if (!board || !S.fly.size || api.isPanelOpen()) return;
  let delay = 0;
  for (const name of [...S.fly]) {
    const s = board.slots.find(x => x.name === name);
    if (!s) { S.fly.delete(name); continue; }
    if (S.flights.some(f => f.name === name)) continue;
    const geo = noteQuad(s.s, cellUv(s.i, board.grid), s.curl);
    const mesh = new THREE.Mesh(geo, M.atlas);
    const pl = playerLocal();
    const near = pl.z > 0.3 && pl.z < 5 && Math.abs(pl.x) < board.W / 2 + 1.5;
    const from = near ? pl : board.pad.clone();
    const to = new THREE.Vector3(s.u, s.v, s.z);
    const ctrl = from.clone().lerp(to, 0.5); ctrl.z += 0.9; ctrl.y += 0.45;
    mesh.position.copy(from); mesh.scale.setScalar(0.35);
    board.root.add(mesh);
    S.flights.push({ name, mesh, from, ctrl, to, rot: s.rot, t: -delay, dur: 1.05 });
    delay += 0.22;
  }
}

function startFall(slot, name) {
  if (!board || !slot) return;
  const mat = M.papers[PAPERS.indexOf(paperOf(name))] || M.papers[0];
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(slot.s, slot.s), mat);
  mesh.position.set(slot.u, slot.v, slot.z); mesh.rotation.z = slot.rot;
  board.root.add(mesh);
  S.falls.push({ mesh, t: 0, vx: 0.25 + Math.random() * 0.3, vz: 0.45 + Math.random() * 0.4, spin: (Math.random() - 0.5) * 5 });
}

function tickAnimations(dt) {
  if (S.flights.length) {
    let landed = false;
    for (const f of [...S.flights]) {
      f.t += dt / f.dur;
      if (f.t < 0) continue;
      const t = Math.min(1, f.t), e = 1 - Math.pow(1 - t, 3), a = 1 - e;
      f.mesh.position.set(
        a * a * f.from.x + 2 * a * e * f.ctrl.x + e * e * f.to.x,
        a * a * f.from.y + 2 * a * e * f.ctrl.y + e * e * f.to.y,
        a * a * f.from.z + 2 * a * e * f.ctrl.z + e * e * f.to.z);
      f.mesh.rotation.set(Math.sin(t * Math.PI) * 0.5, a * TAU * 1.25, f.rot + a * 1.2);
      f.mesh.scale.setScalar(0.35 + 0.65 * e);
      if (t >= 1) {
        f.mesh.removeFromParent(); f.mesh.geometry.dispose();
        S.flights.splice(S.flights.indexOf(f), 1);
        S.fly.delete(f.name);
        landed = true;
      }
    }
    if (landed) rebuildNotes();
  }
  for (const f of [...S.falls]) {
    f.t += dt;
    const m = f.mesh;
    if (m.position.y > 0.01) {
      m.position.y -= (0.4 + f.t * 2.2) * dt;
      m.position.x += Math.sin(f.t * 5) * f.vx * dt;
      m.position.z += f.vz * dt;
      m.rotation.x = Math.min(Math.PI / 2, m.rotation.x + dt * 1.4);
      m.rotation.z += f.spin * dt * 0.3;
      if (m.position.y <= 0.01) { m.position.y = 0.01; m.rotation.x = -Math.PI / 2; }
    } else if (f.t > 3) {
      m.scale.multiplyScalar(Math.max(0, 1 - dt * 3));
      if (m.scale.x < 0.05) { m.removeFromParent(); m.geometry.dispose(); S.falls.splice(S.falls.indexOf(f), 1); }
    }
  }
}

// ============================================================ nota "mirada" (centro da tela) → destaque + E abre ela
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const _ray = new THREE.Raycaster(), AIM = new THREE.Vector2(0, 0.3), _head = new THREE.Vector3();
// a mira fica logo ACIMA da cabeça do boneco na tela (a nota bem no centro estaria escondida atrás dela)
function updateFocus(dt) {
  if (!board || !board.slots.length) { if (focusSlot) { focusSlot = null; updateHighlight(); } return; }
  if ((focusT -= dt) > 0) return;
  focusT = 0.1;
  const pl = playerLocal();
  let best = null;
  if (pl.z > 0.2 && pl.z < 3.4 && Math.abs(pl.x) < board.W / 2 + 0.8 && !api.isPanelOpen()) {
    _head.set(api.player.x, 2.0, api.player.z).project(api.camera);
    AIM.set(0, U.clamp((Number.isFinite(_head.y) ? _head.y : 0.2) + 0.1, -0.2, 0.85));
    _ray.setFromCamera(AIM, api.camera);
    _o.copy(_ray.ray.origin); _d.copy(_ray.ray.direction);
    board.root.worldToLocal(_o);
    board.root.getWorldQuaternion(_q); _d.applyQuaternion(_q.invert());
    if (_d.z < -0.05) {
      const t = (Z_NOTE - _o.z) / _d.z;
      // ponto mirado, preso à região das notas (câmera colada: a mira passa por cima do quadro)
      const rg = board.region, hs = (board.grid?.s || 0.3) / 2;
      const hu = U.clamp(_o.x + _d.x * t, rg.x0 - 0.3, rg.x1 + 0.3), hv = U.clamp(_o.y + _d.y * t, rg.y0 + hs, rg.y1 - hs);
      let bd = Infinity;
      for (const s of board.slots) {
        if (!s.name || S.fly.has(s.name)) continue;
        const d = Math.hypot(s.u - hu, (s.v - hv) * 1.2);
        if (d < bd) { bd = d; best = s; }
      }
      if (bd > best?.s * 1.6) best = null;
      // sem mira boa: a nota mais perto na horizontal, se o jogador estiver bem na frente
      if (!best && pl.z < 2.2) {
        let bx = Infinity;
        for (const s of board.slots) if (s.name && !S.fly.has(s.name)) { const d = Math.abs(s.u - pl.x) + Math.abs(s.v - 1.5) * 0.3; if (d < bx) { bx = d; best = s; } }
        if (bx > 0.6) best = null;
      }
    }
  }
  if (best !== focusSlot) { focusSlot = best; updateHighlight(); }
}

function updateHighlight() {
  if (!board) return;
  const s = focusSlot;
  board.hl.visible = !!s;
  if (!s) return;
  board.hl.scale.set(s.s + 0.035, s.s + 0.035, 1);
  board.hl.position.set(s.u, s.v, s.z - 0.0008);
  board.hl.rotation.z = s.rot;
}

// ============================================================ dados: lista de notas (hub esc:quadro:<office>)
async function refreshNotes() {
  if (!S.office) return;
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      try {
        const j = await api.request('/api/quadro', { office: S.office }, 'GET', undefined, { timeout: 15000 });
        applyNotes(j);
      } catch (err) {
        console.warn('[quadro] lista:', err.message);
      }
    } while (refreshAgain);
    refreshing = null;
  })();
  return refreshing;
}

function applyNotes(j) {
  S.max = j.max || S.max; S.noteMax = j.note_max || S.noteMax;
  if (j.etag && j.etag === S.etag) { panelListChanged(false); return; }
  S.etag = j.etag;
  const notes = Array.isArray(j.notes) ? j.notes : [];
  const names = new Set(notes.map(n => n.name));
  if (S.known) {
    const added = notes.filter(n => !S.known.has(n.name));
    const removed = [...S.known].filter(n => !names.has(n));
    for (const n of added) S.fly.add(n.name);
    for (const n of removed) startFall(board?.slots.find(s => s.name === n), n);
    if (added.length && !P.h?.isOpen() && !P.creating.size) flashChip(`📌 nota nova: “${U.esc(noteTitle(added[0]))}”`);
    for (const n of added) P.creating.delete(n.name);
  }
  S.known = names;
  S.notes = notes;
  S.byName = new Map(notes.map(n => [n.name, n]));
  rebuildNotes();
  runFlights();
  renderChip();
  panelListChanged(true);
}

function renderChip() {
  if (!chip) return;
  const n = S.notes.length;
  chip.innerHTML = `<button type="button" class="qd-chip" title="Quadro de anotações (Q)">📌 <b>${n}</b> nota${n === 1 ? '' : 's'} <kbd>Q</kbd></button>`;
}
let chipTimer = 0;
function flashChip(html) {
  if (!chip) return;
  renderChip();
  const b = chip.querySelector('.qd-chip');
  if (!b) return;
  b.classList.add('qd-flash');
  b.innerHTML = html;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(renderChip, 4500);
}

// ============================================================ painel: lista + editor + pré-visualização
const P = {
  h: null, sel: null, base: null, conflict: null, gone: false, saving: false, filter: '', view: 'lado',
  deleted: null, confirmDel: 0, creating: new Set(), tooBig: false, loadSeq: 0,
};
let drafts = new Map();          // nome → {text, etag, ts}  (rascunho não salvo; sobrevive a fechar/recarregar)
const draftKey = () => `esc.quadro.rascunhos:${S.office}`;
function loadDrafts() {
  try { drafts = new Map(Object.entries(JSON.parse(localStorage.getItem(draftKey()) || '{}'))); } catch { drafts = new Map(); }
}
let draftTimer = 0;
function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const arr = [...drafts.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 20);
      localStorage.setItem(draftKey(), JSON.stringify(Object.fromEntries(arr)));
    } catch { /* sem storage: rascunho vale só nesta aba */ }
  }, 400);
}

const $b = sel => P.h?.body.querySelector(sel);
const ta = () => $b('.qd-ed');
const isDirty = () => !!(P.base && ta() && ta().value !== P.base.content);

function stashDraft() {
  const t = ta();
  if (!P.base || !t) return;
  if (t.value !== P.base.content) drafts.set(P.base.name, { text: t.value, etag: P.base.etag, ts: Date.now() });
  else drafts.delete(P.base.name);
  saveDrafts();
}

function panelHtml() {
  return `<div class="qd qd-v-${P.view}">
  <aside class="qd-side">
    <div class="qd-new" hidden>
      <input class="qd-new-in" maxlength="80" placeholder="Título da nota (vira o nome do arquivo)" aria-label="Título da nova nota">
      <div class="qd-new-row"><button type="button" class="qd-new-ok">Criar nota</button><button type="button" class="qd-new-no">Cancelar</button></div>
      <div class="qd-new-err"></div>
    </div>
    <input class="qd-search" type="search" placeholder="Procurar nas notas…" aria-label="Procurar">
    <div class="qd-undo" hidden></div>
    <div class="qd-list" role="listbox"></div>
    <div class="qd-foot"></div>
  </aside>
  <section class="qd-main">
    <div class="qd-bar">
      <div class="qd-file"><b class="qd-t">—</b><small class="qd-fn"></small></div>
      <div class="qd-views" role="group" aria-label="Modo de exibição">
        <button type="button" data-view="editar" title="Só o editor">Editar</button><button type="button" data-view="lado" title="Editor e pré-visualização">Lado a lado</button><button type="button" data-view="ler" title="Só a leitura">Ler</button>
      </div>
      <button type="button" class="qd-save" title="Salvar (Ctrl+S)">Salvar</button>
      <button type="button" class="qd-del" title="Apagar (vai para a lixeira)">Apagar</button>
    </div>
    <div class="qd-alert" hidden></div>
    <div class="qd-split">
      <textarea class="qd-ed" spellcheck="true" placeholder="Escreva em markdown: # título, - [ ] tarefa, **negrito**…" aria-label="Texto da nota" disabled></textarea>
      <div class="qd-pv md" aria-label="Pré-visualização"></div>
    </div>
    <div class="qd-status"><span class="qd-st"></span><span class="qd-size"></span><span class="qd-keys"><kbd>Ctrl</kbd>+<kbd>S</kbd> salvar · <kbd>Esc</kbd> fechar</span></div>
  </section>
</div>`;
}

function openBoard({ select = null, create = false } = {}) {
  if (!S.office) return;
  if (P.h?.isOpen()) {
    if (create) showNewForm();
    else if (select && select !== P.sel) selectNote(select);
    return;
  }
  try { const v = localStorage.getItem(VIEW_KEY); if (['editar', 'lado', 'ler'].includes(v)) P.view = v; } catch { /* sem storage */ }
  if (innerWidth < 760 && P.view === 'lado') P.view = 'editar';
  P.sel = null; P.base = null; P.conflict = null; P.gone = false; P.deleted = null; P.filter = ''; P.tooBig = false;
  const h = api.openPanel({
    title: '📌 Quadro de anotações',
    meta: metaText(),
    html: panelHtml(),
    width: 'min(1180px, calc(100vw - 32px))',
    className: 'qd-panel',
    actions: [{ label: '+ Nova nota', primary: true, title: 'Criar uma nota (C perto do quadro)', onClick: () => showNewForm() }],
    onClose: () => { stashDraft(); P.h = null; },
  });
  P.h = h;
  wirePanel(h);
  renderList();
  const first = select || (S.byName.has(P.lastSel) ? P.lastSel : null) || [...S.notes].sort((a, b) => b.mtime - a.mtime)[0]?.name;
  if (first) selectNote(first, { focus: !create }); else renderEditorEmpty();
  if (create || !first) showNewForm();
  refreshNotes();
}

function metaText() {
  return `${api.office?.name || S.office}/quadro · ${S.notes.length} de ${S.max} notas · cada nota é um arquivo .md — seus funcionários e o seu editor também podem mexer nelas`;
}

function wirePanel(h) {
  const sig = { signal: h.signal };
  const body = h.body;
  // teclas: Ctrl+S em qualquer lugar do painel; Esc fecha (guarda o rascunho) — pega antes do núcleo
  h.el.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); ev.stopPropagation(); save(); return; }
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      if (ev.target.closest?.('.qd-new') && !$b('.qd-new').hidden) { hideNewForm(); return; }
      h.close();
    }
  }, { ...sig, capture: true });
  body.querySelector('.qd-new-ok').addEventListener('click', createFromForm, sig);
  body.querySelector('.qd-new-no').addEventListener('click', hideNewForm, sig);
  body.querySelector('.qd-new-in').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); createFromForm(); } }, sig);
  body.querySelector('.qd-search').addEventListener('input', ev => { P.filter = ev.target.value; renderList(); }, sig);
  body.querySelector('.qd-list').addEventListener('click', ev => {
    const it = ev.target.closest('.qd-it');
    if (it) selectNote(it.dataset.name);
  }, sig);
  body.querySelector('.qd-views').addEventListener('click', ev => {
    const v = ev.target.closest('button')?.dataset.view;
    if (!v) return;
    P.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem storage */ }
    body.querySelector('.qd').className = `qd qd-v-${v}`;
    renderViews();
    if (v !== 'editar') renderPreview();
  }, sig);
  body.querySelector('.qd-save').addEventListener('click', () => save(), sig);
  body.querySelector('.qd-del').addEventListener('click', onDelete, sig);
  const t = body.querySelector('.qd-ed');
  let pvTimer = 0;
  t.addEventListener('input', () => {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(() => { renderPreview(); updateStatus(); stashDraft(); renderListMarks(); }, 120);
    updateStatusQuick();
  }, sig);
  t.addEventListener('keydown', onEditorKey, sig);
  body.querySelector('.qd-pv').addEventListener('click', onPreviewClick, sig);
  body.querySelector('.qd-undo').addEventListener('click', ev => { if (ev.target.closest('button')) undoDelete(); }, sig);
  body.querySelector('.qd-alert').addEventListener('click', onAlertClick, sig);
  renderViews();
}

function renderViews() {
  for (const b of P.h.body.querySelectorAll('.qd-views button')) b.classList.toggle('on', b.dataset.view === P.view);
}

// ---------------- lista
function renderList() {
  if (!P.h?.isOpen()) return;
  const list = $b('.qd-list');
  const f = P.filter.trim().toLowerCase();
  const notes = [...S.notes].sort((a, b) => b.mtime - a.mtime)
    .filter(n => !f || `${n.title} ${n.name} ${n.excerpt}`.toLowerCase().includes(f));
  const scroll = list.scrollTop;
  list.innerHTML = notes.map(n => {
    const p = paperOf(n.name);
    return `<button type="button" class="qd-it${n.name === P.sel ? ' sel' : ''}${drafts.has(n.name) ? ' draft' : ''}" data-name="${U.esc(n.name)}" role="option" aria-selected="${n.name === P.sel}">
      <i style="background:${p.bg}"></i><b>${U.esc(noteTitle(n))}</b><small>${U.esc(n.excerpt || '(vazia)')}</small>
      <em>${U.esc(U.fmtAgo(n.mtime))} · ${U.esc(U.fmtSize(n.size))}${drafts.has(n.name) ? ' · <span class="qd-dot">● rascunho</span>' : ''}</em></button>`;
  }).join('') || `<div class="qd-empty">${S.notes.length ? 'Nada encontrado.' : 'O quadro está vazio.<br>Crie a primeira nota!'}</div>`;
  list.scrollTop = scroll;
  $b('.qd-foot').textContent = `${S.notes.length}/${S.max} notas · pasta quadro/`;
  P.h.update({ meta: metaText() });
}
function renderListMarks() {
  if (!P.h?.isOpen()) return;
  for (const it of P.h.body.querySelectorAll('.qd-it')) {
    const d = drafts.has(it.dataset.name);
    if (d !== it.classList.contains('draft')) { renderList(); return; }
  }
}

function panelListChanged(changed) {
  if (!P.h?.isOpen()) return;
  if (changed) renderList();
  checkOpenNote();
}

// nota aberta mudou por fora (outra aba, funcionário, editor externo)?
async function checkOpenNote() {
  if (!P.base || P.saving || P.gone || P.deleting) return;
  const n = S.byName.get(P.base.name);
  if (!n) { P.gone = true; showAlert('gone'); return; }
  if (n.etag === P.base.etag || (P.conflict && P.conflict.etag === n.etag)) return;
  const seq = P.loadSeq;
  let cur;
  try { cur = await api.request('/api/quadro/note', { office: S.office, name: P.base.name }, 'GET', undefined, { signal: P.h?.signal }); } catch { return; }
  if (seq !== P.loadSeq || !P.base || cur.name !== P.base.name || cur.etag === P.base.etag) return;
  if (!isDirty()) {
    P.base = cur; ta().value = cur.content; renderPreview(); updateStatus('↻ atualizada por fora agora mesmo');
  } else {
    P.conflict = cur; showAlert('conflict', 'externa');
  }
}

// ---------------- editor
function renderEditorEmpty() {
  const t = ta(); if (!t) return;
  t.value = ''; t.disabled = true;
  $b('.qd-t').textContent = S.notes.length ? 'Escolha uma nota' : 'Nenhuma nota ainda';
  $b('.qd-fn').textContent = '';
  $b('.qd-pv').innerHTML = `<div class="qd-hint"><p>Cada post-it do quadro é um arquivo <code>.md</code> na pasta <code>quadro/</code> do escritório.</p><p>Use <b>+ Nova nota</b> (ou <kbd>C</kbd> perto do quadro) para pregar uma nota nova.</p></div>`;
  $b('.qd-save').disabled = true; $b('.qd-del').disabled = true;
  updateStatus();
}

async function selectNote(name, { focus = true } = {}) {
  if (!P.h?.isOpen()) return;
  stashDraft();
  P.sel = name; P.lastSel = name; P.conflict = null; P.gone = false; P.tooBig = false; P.confirmDel = 0;
  const seq = ++P.loadSeq;
  hideAlert();
  renderList();
  const t = ta();
  t.disabled = true;
  $b('.qd-t').textContent = noteTitle(S.byName.get(name) || { name });
  $b('.qd-fn').textContent = name;
  updateStatus('abrindo…');
  let n;
  try {
    n = await api.request('/api/quadro/note', { office: S.office, name }, 'GET', undefined, { signal: P.h.signal, timeout: 15000 });
  } catch (err) {
    if (seq !== P.loadSeq || !P.h?.isOpen()) return;
    P.base = null;
    if (err.status === 413) { P.tooBig = true; showAlert('big', err.message); } else if (err.status === 404) { showAlert('missing'); } else showAlert('error', err.message);
    t.value = ''; $b('.qd-pv').innerHTML = '';
    $b('.qd-save').disabled = true; $b('.qd-del').disabled = true;
    updateStatus();
    return;
  }
  if (seq !== P.loadSeq || !P.h?.isOpen()) return;
  P.base = n;
  const d = drafts.get(name);
  t.value = d ? d.text : n.content;
  t.disabled = false;
  $b('.qd-save').disabled = false; $b('.qd-del').disabled = false; resetDelBtn();
  if (d && d.text !== n.content) {
    if (d.etag !== n.etag) { P.conflict = n; showAlert('conflict', 'rascunho'); } else showAlert('draft');
  } else if (d) { drafts.delete(name); saveDrafts(); }
  renderPreview();
  updateStatus();
  if (focus && P.view !== 'ler' && $b('.qd-new')?.hidden !== false) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.scrollTop = t.scrollHeight; }
}

function renderPreview() {
  const pv = $b('.qd-pv'); const t = ta();
  if (!pv || !t || P.view === 'editar' || !P.base) return;
  pv.innerHTML = t.value.trim() ? api.markdown(t.value) : '<p class="qd-muted">(nota vazia)</p>';   // api.markdown = SEGURO
}

function updateStatusQuick() {
  const st = $b('.qd-st');
  if (st && P.base && !P.saving) { st.textContent = '● não salvo'; st.className = 'qd-st qd-dirty'; }
}
function updateStatus(msg) {
  if (!P.h?.isOpen()) return;
  const st = $b('.qd-st'), sz = $b('.qd-size'), t = ta();
  if (!st) return;
  const bytes = P.base && t ? byteLen(t.value) : 0;
  const over = bytes > S.noteMax;
  sz.textContent = P.base ? `${U.fmtSize(bytes)} de ${U.fmtSize(S.noteMax)}` : '';
  sz.classList.toggle('qd-over', over);
  $b('.qd-save').disabled = !P.base || over || P.saving;
  let cls = 'qd-st', txt = msg || '';
  if (!txt) {
    if (!P.base) txt = '';
    else if (P.saving) txt = 'salvando…';
    else if (over) { txt = `⚠ passou do limite de ${U.fmtSize(S.noteMax)} — corte um pouco`; cls += ' qd-bad'; }
    else if (P.conflict) { txt = '⚠ conflito de edição'; cls += ' qd-bad'; }
    else if (isDirty()) { txt = '● não salvo'; cls += ' qd-dirty'; }
    else { txt = `✓ salvo · ${U.fmtAgo(P.base.mtime)}`; cls += ' qd-ok'; }
  }
  st.textContent = txt; st.className = cls;
}

// atalhos do editor: Tab recua, Enter continua listas, Ctrl+B/I negrito/itálico
function insertText(t, text) {
  t.focus();
  let ok = false;
  const a = t.selectionStart;
  // texto vazio = apagar a seleção: 'insertText' com '' no Chrome joga o cursor para o início do campo
  try { ok = text ? document.execCommand('insertText', false, text) : (t.selectionStart === t.selectionEnd || document.execCommand('delete')); } catch { ok = false; }   // mantém o Ctrl+Z
  if (ok && !text) t.setSelectionRange(a, a);
  if (!ok) { t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input')); }
}
function onEditorKey(ev) {
  const t = ev.target;
  if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey) {
    ev.preventDefault();
    if (ev.shiftKey) {
      const s = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1;
      const m = /^( {1,2}|\t)/.exec(t.value.slice(s));
      if (m) { const a = t.selectionStart, b = t.selectionEnd; t.setSelectionRange(s, s + m[1].length); insertText(t, ''); t.setSelectionRange(Math.max(s, a - m[1].length), Math.max(s, b - m[1].length)); }
    } else insertText(t, '  ');
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ['b', 'i'].includes(ev.key.toLowerCase())) {
    ev.preventDefault();
    const mark = ev.key.toLowerCase() === 'b' ? '**' : '*';
    const a = t.selectionStart, b = t.selectionEnd, sel = t.value.slice(a, b);
    insertText(t, `${mark}${sel}${mark}`);
    if (!sel) t.setSelectionRange(a + mark.length, a + mark.length);
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.isComposing && t.selectionStart === t.selectionEnd) {
    const pos = t.selectionStart;
    const s = t.value.lastIndexOf('\n', pos - 1) + 1;
    const line = t.value.slice(s, pos);
    const m = /^(\s*)([-*+]|\d{1,6}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!m) return;
    ev.preventDefault();
    if (!m[5].trim()) {                                      // item vazio: encerra a lista (tira o marcador)
      t.setSelectionRange(s, pos); insertText(t, '');
      return;
    }
    let marker = m[2];
    const num = /^(\d+)([.)])$/.exec(marker);
    if (num) marker = `${+num[1] + 1}${num[2]}`;
    insertText(t, `\n${m[1]}${marker}${m[3]}${m[4] ? '[ ] ' : ''}`);
  }
}

// checkbox da pré-visualização: alterna "[ ]"/"[x]" no texto e salva
function onPreviewClick(ev) {
  const cb = ev.target.closest?.('input[type=checkbox]');
  if (!cb || !P.base) return;
  ev.preventDefault();
  const all = [...P.h.body.querySelectorAll('.qd-pv input[type=checkbox]')];
  const k = all.indexOf(cb);
  const t = ta(), lines = t.value.split('\n');
  const rx = /^(\s*(?:>\s*)*(?:[-*+]|\d{1,6}[.)])\s+)\[([ xX])\](\s+)/;
  let idx = -1, count = 0, fence = null;
  const dl = +cb.dataset.line;
  if (Number.isInteger(dl) && rx.test(lines[dl] || '') && !/^\s*>/.test(lines[dl])) {
    // data-line confere com o fonte (fora de citação) → usa direto
    idx = dl;
  } else {
    for (let i = 0; i < lines.length; i++) {
      const f = /^\s*(?:>\s*)*(```|~~~)/.exec(lines[i]);
      if (f) { fence = fence === f[1] ? null : (fence || f[1]); continue; }
      if (fence) continue;
      if (rx.test(lines[i])) { if (count === k) { idx = i; break; } count++; }
    }
  }
  if (idx < 0) return;
  lines[idx] = lines[idx].replace(rx, (m0, pre, x, sp) => `${pre}[${x === ' ' ? 'x' : ' '}]${sp}`);
  t.value = lines.join('\n');
  renderPreview(); updateStatus(); stashDraft();
  if (!P.conflict && !P.gone) save();
}

// ---------------- salvar / conflito
async function save({ etag = null } = {}) {
  if (!P.base || P.saving || !P.h?.isOpen()) return;
  const t = ta(), content = t.value, name = P.base.name;
  if (byteLen(content) > S.noteMax) { updateStatus(); return; }
  if (!etag && P.conflict) { showAlert('conflict', 'salvar'); return; }
  if (!etag && content === P.base.content) { updateStatus('✓ nada a salvar'); return; }
  P.saving = true; updateStatus();
  try {
    const n = await api.request('/api/quadro/note', { office: S.office, name }, 'PUT', { office: S.office, content, etag: etag || P.base.etag }, { timeout: 20000 });
    if (P.base?.name === name) {
      P.base = n; P.conflict = null;
      if (ta()?.value === n.content) drafts.delete(name);
      hideAlert();
    }
    saveDrafts();
    P.saving = false;
    updateStatus('✓ salvo');
    refreshNotes();
  } catch (err) {
    P.saving = false;
    if (P.base?.name !== name) return;
    if (err.status === 409 && err.body?.current?.etag) { P.conflict = err.body.current; showAlert('conflict', 'salvar'); }
    else if (err.status === 404) { P.gone = true; showAlert('gone'); }
    else if (err.status === 413) updateStatus(`⚠ ${err.message}`);
    else updateStatus(`⚠ não salvou: ${err.message}`);
  }
}

function showAlert(kind, extra) {
  const el = $b('.qd-alert'); if (!el) return;
  let html = '';
  if (kind === 'conflict') {
    const why = extra === 'externa' ? 'Esta nota foi alterada <b>por fora</b> (outra aba, um funcionário ou um editor) enquanto você editava.'
      : extra === 'rascunho' ? 'Você tem um <b>rascunho não salvo</b>, mas a nota mudou depois dele.'
        : 'A nota mudou desde que você abriu — <b>não salvei</b> para não apagar a versão nova.';
    html = `<div class="qd-al-t">⚠ Conflito de edição</div><div>${why}</div>
      <div class="qd-al-b"><button type="button" data-a="reload">Recarregar a versão nova</button><button type="button" data-a="force">Sobrescrever com a minha</button><button type="button" data-a="copy">Salvar a minha como nova nota</button></div>
      <details><summary>Ver a versão nova (${U.esc(U.fmtAgo(P.conflict?.mtime || 0))})</summary><div class="md qd-other">${api.markdown(P.conflict?.content || '')}</div></details>`;
  } else if (kind === 'gone') {
    html = `<div class="qd-al-t">🗑️ Esta nota foi apagada</div><div>Ela sumiu da pasta (outra aba, um funcionário ou um editor). O seu texto continua aqui.</div>
      <div class="qd-al-b"><button type="button" data-a="recreate">Recriar com o meu texto</button></div>`;
  } else if (kind === 'draft') {
    html = `<div>✏️ Rascunho não salvo restaurado.</div><div class="qd-al-b"><button type="button" data-a="save">Salvar agora</button><button type="button" data-a="discard">Descartar rascunho</button></div>`;
  } else if (kind === 'big') {
    html = `<div class="qd-al-t">📦 Nota grande demais</div><div>${U.esc(extra)}</div>`;
  } else if (kind === 'missing') {
    html = '<div>Essa nota não existe mais.</div>';
  } else if (kind === 'error') {
    html = `<div>⚠ ${U.esc(extra || 'erro')}</div>`;
  }
  el.className = `qd-alert qd-al-${kind}`;
  el.innerHTML = html;
  el.hidden = !html;
  updateStatus();
}
function hideAlert() { const el = $b('.qd-alert'); if (el) { el.hidden = true; el.innerHTML = ''; } }

async function onAlertClick(ev) {
  const a = ev.target.closest('button')?.dataset.a;
  if (!a || !P.base) return;
  const t = ta();
  if (a === 'reload' && P.conflict) {
    P.base = P.conflict; P.conflict = null; t.value = P.base.content; drafts.delete(P.base.name); saveDrafts();
    hideAlert(); renderPreview(); updateStatus('↻ versão nova carregada'); renderList();
  } else if (a === 'force' && P.conflict) {
    await save({ etag: P.conflict.etag });
  } else if (a === 'copy') {
    const title = `${noteTitle(S.byName.get(P.base.name) || P.base)} (minha versão)`;
    const mine = t.value;
    const n = await createNote(title, mine);
    if (n) {
      if (P.conflict) { P.base = P.conflict; P.conflict = null; }
      drafts.delete(P.base.name); saveDrafts();
      selectNote(n.name);
    }
  } else if (a === 'recreate') {
    const mine = t.value;
    const n = await createNote(noteTitle(S.byName.get(P.base.name) || { name: P.base.name }) || P.base.name, mine);
    if (n) { drafts.delete(P.base.name); saveDrafts(); selectNote(n.name); }
  } else if (a === 'save') {
    hideAlert(); save();
  } else if (a === 'discard') {
    drafts.delete(P.base.name); saveDrafts(); t.value = P.base.content; hideAlert(); renderPreview(); updateStatus(); renderList();
  }
}

// ---------------- criar
function showNewForm() {
  const f = $b('.qd-new'); if (!f) return;
  f.hidden = false;
  $b('.qd-new-err').textContent = '';
  const i = $b('.qd-new-in'); i.value = ''; i.focus();
}
function hideNewForm() { const f = $b('.qd-new'); if (f) f.hidden = true; }

async function createNote(title, content) {
  try {
    const n = await api.request('/api/quadro', {}, 'POST', { office: S.office, title, ...(content ? { content } : {}) }, { timeout: 15000 });
    P.creating.add(n.name);
    S.fly.add(n.name);
    await refreshNotes();
    return n;
  } catch (err) {
    const e = $b('.qd-new-err');
    if (e && !$b('.qd-new').hidden) e.textContent = err.message; else updateStatus(`⚠ ${err.message}`);
    return null;
  }
}
async function createFromForm() {
  const i = $b('.qd-new-in'), title = i.value.trim();
  if (!title) { $b('.qd-new-err').textContent = 'Dê um título para a nota.'; i.focus(); return; }
  $b('.qd-new-ok').disabled = true;
  const n = await createNote(title);
  if ($b('.qd-new-ok')) $b('.qd-new-ok').disabled = false;
  if (!n || !P.h?.isOpen()) return;
  hideNewForm();
  await selectNote(n.name);
  updateStatus(`✓ nota criada: ${n.name}`);
}

// ---------------- apagar (com confirmação em dois cliques) e desfazer
function resetDelBtn() { const b = $b('.qd-del'); if (b) { b.textContent = 'Apagar'; b.classList.remove('qd-confirm'); } P.confirmDel = 0; }
async function onDelete() {
  if (!P.base) return;
  const b = $b('.qd-del');
  if (!P.confirmDel || Date.now() - P.confirmDel > 4000) {
    P.confirmDel = Date.now();
    b.textContent = isDirty() ? 'Apagar mesmo? (tem texto não salvo)' : 'Apagar mesmo?';
    b.classList.add('qd-confirm');
    setTimeout(() => { if (P.confirmDel && Date.now() - P.confirmDel >= 3900) resetDelBtn(); }, 4000);
    return;
  }
  resetDelBtn();
  const name = P.base.name, title = noteTitle(S.byName.get(name) || { name });
  P.deleting = true;
  try {
    const r = await api.request('/api/quadro/note', { office: S.office, name, etag: P.base.etag }, 'DELETE', undefined, { timeout: 15000 });
    drafts.delete(name); saveDrafts();
    P.deleted = { trash: r.trash, title };
    const u = $b('.qd-undo');
    u.hidden = false;
    u.innerHTML = `🗑️ “${U.esc(title)}” foi para a lixeira. <button type="button">Desfazer</button>`;
    P.base = null; P.sel = null;
    await refreshNotes();
    const next = [...S.notes].sort((a, b2) => b2.mtime - a.mtime)[0];
    if (next) selectNote(next.name); else renderEditorEmpty();
  } catch (err) {
    if (err.status === 409 && err.body?.current) { P.conflict = err.body.current; showAlert('conflict', 'externa'); }
    else updateStatus(`⚠ não apagou: ${err.message}`);
  } finally { P.deleting = false; }
}
async function undoDelete() {
  if (!P.deleted) return;
  try {
    const n = await api.request('/api/quadro/restore', {}, 'POST', { office: S.office, trash: P.deleted.trash }, { timeout: 15000 });
    P.deleted = null;
    const u = $b('.qd-undo'); if (u) u.hidden = true;
    P.creating.add(n.name); S.fly.add(n.name);
    await refreshNotes();
    selectNote(n.name);
  } catch (err) { const u = $b('.qd-undo'); if (u) u.textContent = `Não deu para desfazer: ${err.message}`; }
}

// ============================================================ CSS (prefixo qd-)
const CSS = `
#panel.qd-panel { height: min(84vh, 800px); }
.qd { display: grid; grid-template-columns: 250px 1fr; height: 100%; min-height: 0; }
.qd-side { display: flex; flex-direction: column; min-height: 0; background: #efe6d2; border-right: 1px solid rgba(31,58,95,.15);
  background-image: radial-gradient(rgba(120,80,40,.07) 1px, transparent 1px); background-size: 7px 7px; }
.qd-search { margin: 10px 10px 6px; }
.qd-new { margin: 10px 10px 4px; padding: 10px; background: #fff27a; border-radius: 2px; box-shadow: 0 3px 8px rgba(0,0,0,.18); rotate: -1deg; }
.qd-new-in { width: 100%; font-family: ${HAND} !important; font-size: 15px !important; background: rgba(255,255,255,.55) !important; }
.qd-new-row { display: flex; gap: 6px; margin-top: 8px; }
.qd-new-row button:first-child { font-weight: 700; background: #1f3a5f !important; color: #fff !important; border-color: #1f3a5f !important; }
.qd-new-err { color: #b03a2e; font-size: 12.5px; min-height: 0; margin-top: 4px; }
.qd-new-err:empty { display: none; }
.qd-undo { margin: 0 10px 6px; padding: 6px 8px; font-size: 12.5px; background: #fff; border: 1px dashed #b88a4a; border-radius: 6px; }
.qd-undo button { margin-left: 6px; padding: 1px 8px !important; font-size: 12px; }
.qd-list { flex: 1; overflow: auto; padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
.qd-it { position: relative; width: 100%; min-width: 0; flex: none; text-align: left; display: flex; flex-direction: column; gap: 1px; padding: 7px 9px 7px 16px !important;
  border-radius: 3px !important; background: #fffdf6 !important; border: 1px solid rgba(31,58,95,.14) !important; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.qd-it:hover { background: #fff !important; box-shadow: 0 2px 6px rgba(0,0,0,.12); }
.qd-it.sel { outline: 2px solid #d9a441; background: #fff !important; }
.qd-it i { position: absolute; left: 0; top: 0; bottom: 0; width: 8px; border-radius: 3px 0 0 3px; }
.qd-it b { max-width: 100%; color: #1f3a5f; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qd-it small { color: #4e5b68; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.qd-it em { color: #7b8794; font-size: 11px; font-style: normal; }
.qd-dot { color: #b0602e; font-weight: 700; }
.qd-empty { color: #6b7783; text-align: center; padding: 30px 8px; font-family: ${HAND}; font-size: 15px; }
.qd-foot { padding: 6px 12px; font-size: 11.5px; color: #6b7783; border-top: 1px solid rgba(31,58,95,.12); }
.qd-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.qd-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(31,58,95,.14); background: #fbf8f1; flex-wrap: wrap; }
.qd-file { flex: 1; min-width: 140px; display: flex; flex-direction: column; line-height: 1.2; }
.qd-t { color: #1f3a5f; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qd-fn { color: #7b8794; font: 11.5px ui-monospace, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qd-views { display: inline-flex; }
.qd-views button { border-radius: 0 !important; margin-left: -1px; font-size: 12.5px; padding: 3px 9px !important; }
.qd-views button:first-child { border-radius: 6px 0 0 6px !important; }
.qd-views button:last-child { border-radius: 0 6px 6px 0 !important; }
.qd-views button.on { background: #1f3a5f !important; color: #fff !important; border-color: #1f3a5f !important; }
.qd-save { font-weight: 700; background: #d9a441 !important; border-color: #c08f30 !important; }
.qd-del.qd-confirm { background: #b03a2e !important; color: #fff !important; border-color: #b03a2e !important; }
.qd-alert { margin: 8px 12px 0; padding: 8px 12px; border-radius: 6px; font-size: 13px; background: #fff4d6; border: 1px solid #e0c270; }
.qd-alert.qd-al-conflict, .qd-alert.qd-al-gone { background: #fde8e4; border-color: #e7a39b; }
.qd-al-t { font-weight: 700; margin-bottom: 2px; }
.qd-al-b { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.qd-al-b button { font-size: 12.5px; }
.qd-alert details { margin-top: 6px; }
.qd-alert summary { cursor: pointer; color: #1f3a5f; }
.qd-other { max-height: 180px; overflow: auto; background: #fff; border-radius: 4px; margin-top: 4px; }
.qd-split { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
.qd-v-editar .qd-split { grid-template-columns: 1fr; } .qd-v-editar .qd-pv { display: none; }
.qd-v-ler .qd-split { grid-template-columns: 1fr; } .qd-v-ler .qd-ed { display: none; }
.qd-ed { height: 100%; resize: none !important; border: 0 !important; border-radius: 0 !important; outline: none; padding: 10px 14px 10px 46px !important;
  font: 14px/24px ui-monospace, "Cascadia Mono", Consolas, monospace !important; color: #22303f !important; tab-size: 2;
  background-color: #fffbe6 !important; background-image: linear-gradient(90deg, transparent 34px, rgba(214,90,90,.45) 34px, rgba(214,90,90,.45) 36px, transparent 36px),
  repeating-linear-gradient(180deg, transparent 0 23px, rgba(90,130,190,.2) 23px 24px) !important; background-attachment: local !important; background-position: 0 10px !important; }
.qd-ed:disabled { opacity: .6; }
.qd-pv { overflow: auto; background: #fff; border-left: 1px solid rgba(31,58,95,.12); }
.qd-v-ler .qd-pv { border-left: 0; padding: 6px 12%; }
.qd-pv li.task input { margin-right: 4px; cursor: pointer; }
.qd-hint { color: #5b6b7a; padding: 22px; line-height: 1.6; }
.qd-muted { color: #8a96a3; font-style: italic; }
.qd-status { display: flex; gap: 14px; align-items: center; padding: 5px 12px; font-size: 12px; color: #5b6b7a; border-top: 1px solid rgba(31,58,95,.12); background: #f6f1e4; }
.qd-st { flex: 1; } .qd-ok { color: #3e7d4f; } .qd-dirty { color: #b0602e; font-weight: 700; } .qd-bad { color: #b03a2e; font-weight: 700; }
.qd-over { color: #b03a2e; font-weight: 700; }
.qd-keys kbd { font-size: 10.5px; }
.qd-chip { pointer-events: auto; cursor: pointer; font-size: 12.5px; padding: 4px 10px; border-radius: 3px; border: 1px solid #e0c96a;
  background: #fff4b8; color: #1f2a36; box-shadow: 0 2px 8px rgba(20,30,45,.18); rotate: -1deg; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qd-chip kbd { font-size: 10.5px; }
.qd-chip.qd-flash { animation: qd-pop .5s ease 2; background: #ffe36b; font-weight: 700; }
@keyframes qd-pop { 50% { transform: scale(1.08) rotate(1deg); } }
@media (max-width: 760px) {
  .qd { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 32%) 1fr; }
  .qd-side { border-right: 0; border-bottom: 1px solid rgba(31,58,95,.15); }
  .qd-split { grid-template-columns: 1fr !important; }
  .qd-v-lado .qd-pv { display: none; }
  .qd-keys { display: none; }
}
`;

// ============================================================ instalação
export function install(a) {
  api = a; U = api.util;
  makeMaterials();
  const st = document.createElement('style');
  st.dataset.feature = 'quadro';
  st.textContent = CSS;
  document.head.append(st);

  api.registerKey('KeyQ', {
    label: 'Q', help: 'quadro de anotações',
    handler: () => { if (P.h?.isOpen()) P.h.close(); else openBoard(); },
  });

  api.on('layoutChanged', () => {
    if (board?.pins) board.pins.dispose();
    for (const f of S.flights) f.mesh.geometry.dispose();
    for (const f of S.falls) f.mesh.geometry.dispose();
    S.flights = []; S.falls = []; S.fly.clear();
    focusSlot = null;
    buildBoard();
  });

  api.on('officeReady', office => {
    S.office = office.id;
    loadDrafts();
    chip = api.hudSlot('quadro', { order: 5 });
    chip.addEventListener('click', ev => { if (ev.target.closest('.qd-chip')) openBoard(); });
    renderChip();
    api.addMinimapMarker({
      pos: () => { const q = api.office?.zones?.quadroWall; return q ? { x: q.x - 0.35, z: (q.z0 + q.z1) / 2 } : null; },
      color: '#b88a4a', size: 3, shape: 'square',
    });
    refreshNotes();
    api.watch(`esc:quadro:${office.id}`, () => refreshNotes());
  });

  api.on('panel', open => { if (!open) setTimeout(runFlights, 150); });

  api.on('update', dt => {
    if (!board) return;
    if (S.flights.length || S.falls.length) tickAnimations(dt);
    const q = api.office.zones.quadroWall;
    if (Math.abs(api.player.x - q.x) < 6 && api.player.z < q.z1 + 4 && api.player.z > q.z0 - 4) updateFocus(dt);
    else if (focusSlot) { focusSlot = null; updateHighlight(); }
  });

  // depuração/testes
  window.__quadro = { S, P, get board() { return board; }, openBoard, refreshNotes };
}
