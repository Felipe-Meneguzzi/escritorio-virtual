// ============================================================ PACOTE ambiente — ambientação "The Office"
// Decoração sobre a planta da fundação: carpete de placas, forro de gesso com luminárias fluorescentes (emissivas,
// SEM luz real; uma pisca de leve), baias bege com monitores CRT/LCD, cadeiras giratórias, recepção com balcão e o
// NOME DO ESCRITÓRIO em letreiro na parede atrás, copa (cafeteira, bebedouro de galão com bolhas, geladeira,
// micro-ondas, mesa com donuts), copiadora com luz verde, plantas, janelas com persiana e vista do estacionamento
// (muda com a hora real), relógios com a hora certa, extintores, mural de avisos, calendário, rodapés, caixilhos,
// sombras falsas (blobs) e som ambiente sintetizado (Web Audio, volume baixo; tecla B = liga/desliga).
//
// ORÇAMENTO (ARCH.md §GPU): tudo o que é estático vai MESCLADO em poucos Mesh — a mobília inteira usa cor por
// vértice num único MeshLambertMaterial (1 draw call); o resto são ~15 malhas com textura de canvas. O que muda
// (luminárias que piscam, ponteiros, donuts, bolhas) é InstancedMesh. Só Lambert/Basic, nenhuma luz nova, nenhuma
// sombra real. Enfeite miúdo segue api.quality.detail e some no nível 'baixa'.
// A colisão dos móveis continua vindo da grade (api.office.furniture): os móveis daqui ocupam as mesmas caixas.
// O que acrescento de sólido (parede do letreiro, mesinhas) entra com api.addCollider/api.blockNavCell (layout:true).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HALF = Math.PI / 2, TAU = Math.PI * 2;
const KEEP_ATTR = new Set(['position', 'normal', 'uv', 'color']);
const WALLISH = new Set(['#', '=', '|', 'W', 'Q', 'E']);
const LS_MUTE = 'esc.amb.mudo', LS_VOL = 'esc.amb.volume', LS_DONUT = 'esc.amb.donuts';
const PLACEHOLDERS = ['R', 'S', 'P', 'K', 'C', 'O', 'F', 'X', 'c', 'B', 'sign', 'chairs'];

// paleta (bege, cinza-azulado, madeira clara, vidro esverdeado)
const COL = {
  wall: '#e6ddc8', wood: '#a8784c', woodDark: '#6f4d31', woodLight: '#d2b48c', deskTop: '#cdbb98', deskEdge: '#8a7a62',
  fabric: '#b5aa90', trim: '#7e8084', metal: '#a9adb2', metalDark: '#55595f', alu: '#b3b8bd', black: '#222427',
  beige: '#d8cfb6', beige2: '#c4bb9f', plastic: '#e8e2d2', chair: '#33363c', paper: '#f7f5ee', counter: '#cbc3b0',
  cabinet: '#e2dbc9', cabDoor: '#d9d1bd', fridge: '#ecebe6', baseboard: '#4a4c51', frame: '#e8e6df', leather: '#6b4a3a',
  navy: '#1f3a5f', mustard: '#d9a441', red: '#b8342a', leaf: '#4f8a4a', leaf2: '#3d7240', leaf3: '#65a052',
};
const MES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

// céu por hora do dia: [hora, topo, horizonte, cor do sol, luz 0..1]
const SKY = [
  [0, '#0a1430', '#243056', '#8fa6ff', 0],
  [5.3, '#0c1836', '#2a3761', '#8fa6ff', 0],
  [6.4, '#5b77ad', '#f0b489', '#ffc48a', 0.55],
  [8, '#5b9ad6', '#cfe4f3', '#fff0d2', 1],
  [16.6, '#5b9ad6', '#d8e8f2', '#fff0d2', 1],
  [18, '#3f518e', '#f08b5b', '#ffae6e', 0.6],
  [19.2, '#0c1836', '#2a3761', '#8fa6ff', 0],
  [24, '#0a1430', '#243056', '#8fa6ff', 0],
];

// ---------------------------------------------------------------- utilidades pequenas
const clamp01 = v => Math.max(0, Math.min(1, v));
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage: vale só nesta aba */ } }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function texOf(c, { repeat = false, mip = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!mip) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  return t;
}
function css(hex, f = 1) { return new THREE.Color(hex).multiplyScalar(f).getStyle(); }
function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const rngOf = s => mulberry(hash(s));
const pickR = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];
// retângulo de pixels [x, y, w, h] de um canvas size×size → uv [u0, v0, u1, v1] (flipY), com 1 px de folga
function uvRect(r, size, sizeY = size) {
  return [(r[0] + 1) / size, 1 - (r[1] + r[3] - 1) / sizeY, (r[0] + r[2] - 1) / size, 1 - (r[1] + 1) / sizeY];
}
function wrapText(g, text, x, y, maxW, lh) {
  const words = String(text).split(/\s+/); let line = '', yy = y;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = t;
  }
  if (line) g.fillText(line, x, yy);
  return yy + lh;
}
function hourNow() {
  try {
    const q = new URLSearchParams(location.search).get('hora');   // ?hora=20.5 (teste/curiosidade)
    if (q !== null && q !== '' && Number.isFinite(+q)) return ((+q % 24) + 24) % 24;
  } catch { /* */ }
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}
function skyAt(h) {
  let i = 0;
  while (i < SKY.length - 2 && h >= SKY[i + 1][0]) i++;
  const a = SKY[i], b = SKY[i + 1], t = clamp01((h - a[0]) / ((b[0] - a[0]) || 1));
  const lc = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t);
  return { top: lc(a[1], b[1]), hor: lc(a[2], b[2]), sun: lc(a[3], b[3]), light: a[4] + (b[4] - a[4]) * t };
}

// ---------------------------------------------------------------- lote de geometria mesclada (1 Mesh por material)
// add(geo, {x,y,z, rx,ry,rz, order, sx,sy,sz, color, grad, uv:[u0,v0,u1,v1], uvRepeat:[su,sv], world})
// A transformação é local ao FRAME atual (setFrame) — exceto com world:true. grad escurece a base (AO falso).
const FRAME = new THREE.Matrix4(), IDENT = new THREE.Matrix4();
const _m = new THREE.Matrix4(), _mw = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
function setFrame(x = 0, y = 0, z = 0, yaw = 0) { FRAME.makeRotationY(yaw); FRAME.setPosition(x, y, z); }
function resetFrame() { FRAME.identity(); }

class Batch {
  constructor() { this.geos = []; this.tris = 0; }
  add(geo, o = {}) {
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0, o.order || 'XYZ');
    _q.setFromEuler(_e);
    _p.set(o.x || 0, o.y || 0, o.z || 0);
    _s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    _m.compose(_p, _q, _s);
    _mw.multiplyMatrices(o.world ? IDENT : FRAME, _m);
    geo.applyMatrix4(_mw);
    for (const k of Object.keys(geo.attributes)) if (!KEEP_ATTR.has(k)) geo.deleteAttribute(k);
    const pos = geo.attributes.position, n = pos.count;
    if (!geo.index) { const idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = i; geo.setIndex(idx); }
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    _c.set(o.color ?? '#ffffff');
    const grad = o.grad || 0;
    let y0 = 0, y1 = 1;
    if (grad) { y0 = Infinity; y1 = -Infinity; for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const f = grad ? 1 - grad * (1 - (pos.getY(i) - y0) / ((y1 - y0) || 1)) : 1;
      col[i * 3] = _c.r * f; col[i * 3 + 1] = _c.g * f; col[i * 3 + 2] = _c.b * f;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (o.uv || o.uvRepeat) {
      const uv = geo.attributes.uv, r = o.uv || [0, 0, 1, 1], [su, sv] = o.uvRepeat || [1, 1];
      for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * su * (r[2] - r[0]), r[1] + uv.getY(i) * sv * (r[3] - r[1]));
    }
    this.geos.push(geo);
    this.tris += geo.index.count / 3;
    return geo;
  }
  build(material, name, parent) {
    if (!this.geos.length) return null;
    const g = mergeGeometries(this.geos, false);
    for (const x of this.geos) x.dispose();
    this.geos = [];
    if (!g) return null;
    const m = new THREE.Mesh(g, material);
    m.name = `ambiente:${name}`; m.matrixAutoUpdate = false; m.updateMatrix();
    parent.add(m);
    return m;
  }
}
// formas
const boxG = (w, h, d) => new THREE.BoxGeometry(Math.max(1e-3, Math.abs(w)), Math.max(1e-3, Math.abs(h)), Math.max(1e-3, Math.abs(d)));
const planeG = (w, h) => new THREE.PlaneGeometry(w, h);
// caixa pelas faixas (coordenadas do frame atual)
function bx(b, x0, x1, y0, y1, z0, z1, color, o = {}) {
  return b.add(boxG(x1 - x0, y1 - y0, z1 - z0), { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, color, ...o });
}
// caixa pelo centro
function bc(b, x, y, z, w, h, d, color, o = {}) { return b.add(boxG(w, h, d), { x, y, z, color, ...o }); }
// cilindro em pé com a base em y0
function cy(b, x, y0, z, r, h, color, seg = 8, o = {}) {
  return b.add(new THREE.CylinderGeometry(o.rt ?? r, o.rb ?? r, h, seg), { x, y: y0 + h / 2, z, color, ...o });
}

// ---------------------------------------------------------------- texturas de canvas (uma vez)
function drawCarpet() {                     // 2 m × 2 m: 4×4 placas de 50 cm, alternando o sentido da fibra
  const c = mkCanvas(256, 256), g = c.getContext('2d'), r = rngOf('carpete');
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    const px = tx * 64, py = ty * 64;
    g.fillStyle = css('#76838f', 0.93 + r() * 0.12); g.fillRect(px, py, 64, 64);
    const horiz = (tx + ty) % 2 === 0;
    for (let i = 0; i < 64; i += 2) {
      g.fillStyle = i % 4 ? 'rgba(150,162,176,.16)' : 'rgba(40,50,62,.16)';
      if (horiz) g.fillRect(px, py + i, 64, 1); else g.fillRect(px + i, py, 1, 64);
    }
  }
  for (let i = 0; i < 3200; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(35,44,56,.32)' : r() < 0.5 ? 'rgba(175,186,198,.28)' : 'rgba(120,112,140,.22)';
    g.fillRect(Math.floor(r() * 256), Math.floor(r() * 256), 1 + (r() < 0.2 ? 1 : 0), 1);
  }
  g.fillStyle = 'rgba(28,34,44,.5)';
  for (let i = 0; i < 256; i += 64) { g.fillRect(i, 0, 1, 256); g.fillRect(0, i, 256, 1); }
  return c;
}
function drawCeiling() {                    // 1,2 m × 1,2 m: 2×2 placas de 60 cm de gesso fissurado + perfil T
  const c = mkCanvas(256, 256), g = c.getContext('2d'), r = rngOf('forro');
  g.fillStyle = '#ebe9e2'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(90,88,80,${0.12 + r() * 0.2})`;
    const x = r() * 256, y = r() * 256;
    g.fillRect(x, y, 1 + r() * 3, 1);
  }
  for (const p of [0, 128]) {
    g.fillStyle = '#c9c7bf'; g.fillRect(p, 0, 4, 256); g.fillRect(0, p, 256, 4);
    g.fillStyle = '#f8f7f3'; g.fillRect(p + 1, 0, 1, 256); g.fillRect(0, p + 1, 256, 1);
  }
  return c;
}
function drawLino() {                       // piso vinílico da copa: 1,2 m = 4×4 placas de 30 cm
  const c = mkCanvas(256, 256), g = c.getContext('2d'), r = rngOf('lino');
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    g.fillStyle = (tx + ty) % 2 ? css('#e6dcc2', 0.97 + r() * 0.05) : css('#b7c2a6', 0.97 + r() * 0.05);
    g.fillRect(tx * 64, ty * 64, 64, 64);
  }
  for (let i = 0; i < 1400; i++) { g.fillStyle = r() < 0.5 ? 'rgba(80,80,70,.18)' : 'rgba(255,255,250,.25)'; g.fillRect(r() * 256, r() * 256, 2, 1); }
  g.fillStyle = 'rgba(90,90,80,.35)';
  for (let i = 0; i < 256; i += 64) { g.fillRect(i, 0, 1, 256); g.fillRect(0, i, 256, 1); }
  return c;
}
function drawBlinds() {                     // lâminas horizontais de persiana (repete em v)
  const c = mkCanvas(32, 32), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 16);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.75, '#e4e0d6'); gr.addColorStop(1, '#b9b5ab');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 16); g.fillRect(0, 16, 32, 16);
  g.fillStyle = '#8f8b82'; g.fillRect(0, 15, 32, 1); g.fillRect(0, 31, 32, 1);
  return c;
}
function drawBlob() {
  const c = mkCanvas(64, 64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(0.6, 'rgba(0,0,0,.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c;
}
function drawStripes() {                    // luz do sol no chão, riscada pela persiana (topo = junto da janela)
  const c = mkCanvas(32, 64), g = c.getContext('2d');
  for (let y = 0; y < 64; y++) {
    const fade = 1 - y / 64, slat = (y % 8) < 5 ? 1 : 0.35;
    g.fillStyle = `rgba(255,255,255,${(fade * fade * slat).toFixed(3)})`;
    g.fillRect(0, y, 32, 1);
  }
  const edge = g.createLinearGradient(0, 0, 32, 0);
  edge.addColorStop(0, 'rgba(0,0,0,1)'); edge.addColorStop(0.15, 'rgba(0,0,0,0)'); edge.addColorStop(0.85, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out'; g.fillStyle = edge; g.fillRect(0, 0, 32, 64);
  return c;
}
function drawLouver() {                     // difusor aletado da luminária 2×4
  const c = mkCanvas(64, 32), g = c.getContext('2d');
  g.fillStyle = '#fbfdf9'; g.fillRect(0, 0, 64, 32);
  for (let x = 0; x < 64; x += 8) for (let y = 0; y < 32; y += 8) {
    const gr = g.createRadialGradient(x + 4, y + 4, 0.5, x + 4, y + 4, 5.5);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#dfe5e3');
    g.fillStyle = gr; g.fillRect(x, y, 8, 8);
  }
  g.fillStyle = '#c9cfcd';
  for (let x = 0; x <= 64; x += 8) g.fillRect(x, 0, 1, 32);
  for (let y = 0; y <= 32; y += 8) g.fillRect(0, y, 64, 1);
  g.fillStyle = '#b8bcba'; g.fillRect(0, 0, 64, 2); g.fillRect(0, 30, 64, 2); g.fillRect(0, 0, 2, 32); g.fillRect(62, 0, 2, 32);
  return c;
}
// telas dos monitores: 4 variantes 128×128 (planilha, área de trabalho, documento, paciência)
function drawScreens() {
  const c = mkCanvas(256, 256), g = c.getContext('2d'), r = rngOf('telas');
  // planilha
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1d6f42'; g.fillRect(0, 0, 128, 12);
  g.fillStyle = '#e8eef0'; g.fillRect(0, 12, 128, 8); g.fillRect(0, 12, 10, 116);
  g.strokeStyle = '#c8d0d4'; g.lineWidth = 1;
  for (let y = 20; y < 128; y += 7) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(128, y + 0.5); g.stroke(); }
  for (let x = 10; x < 128; x += 22) { g.beginPath(); g.moveTo(x + 0.5, 12); g.lineTo(x + 0.5, 128); g.stroke(); }
  for (let i = 0; i < 40; i++) { g.fillStyle = '#6b7478'; g.fillRect(12 + Math.floor(r() * 5) * 22, 22 + Math.floor(r() * 14) * 7, 8 + r() * 10, 3); }
  for (let i = 0; i < 5; i++) { g.fillStyle = ['#2f7fc1', '#d9a441', '#b8342a'][i % 3]; const h = 10 + r() * 26; g.fillRect(80 + i * 8, 120 - h, 6, h); }
  // área de trabalho (colina verde + céu, barra de tarefas azul)
  let gr = g.createLinearGradient(128, 0, 128, 128); gr.addColorStop(0, '#3b7fd9'); gr.addColorStop(0.6, '#a9d3f5'); gr.addColorStop(1, '#a9d3f5');
  g.fillStyle = gr; g.fillRect(128, 0, 128, 128);
  g.fillStyle = '#58a33a'; g.beginPath(); g.moveTo(128, 90); g.quadraticCurveTo(180, 50, 256, 84); g.lineTo(256, 128); g.lineTo(128, 128); g.fill();
  g.fillStyle = '#ffffff'; for (let i = 0; i < 4; i++) g.fillRect(134, 8 + i * 18, 10, 10);
  g.fillStyle = '#245edb'; g.fillRect(128, 116, 128, 12); g.fillStyle = '#3c9a3c'; g.fillRect(128, 116, 22, 12);
  // documento
  g.fillStyle = '#7d8a96'; g.fillRect(0, 128, 128, 128);
  g.fillStyle = '#2b579a'; g.fillRect(0, 128, 128, 12);
  g.fillStyle = '#ffffff'; g.fillRect(18, 146, 92, 110);
  g.fillStyle = '#2a2d31';
  for (let y = 154; y < 250; y += 6) g.fillRect(26, y, 60 + r() * 16, 2);
  // paciência
  g.fillStyle = '#0b7a31'; g.fillRect(128, 128, 128, 128);
  for (let i = 0; i < 7; i++) for (let j = 0; j <= i % 4; j++) {
    const x = 134 + i * 17, y = 150 + j * 12;
    g.fillStyle = j === i % 4 ? '#ffffff' : '#2c4aa8'; g.fillRect(x, y, 13, 18);
    if (j === i % 4) { g.fillStyle = i % 2 ? '#c0392b' : '#111'; g.fillRect(x + 3, y + 4, 4, 4); }
  }
  for (let i = 0; i < 4; i++) { g.strokeStyle = '#9fd3a9'; g.strokeRect(134.5 + i * 17, 132.5, 13, 16); }
  return c;
}
const SCR = [[0, 0, 128, 128], [128, 0, 128, 128], [0, 128, 128, 128], [128, 128, 128, 128]].map(r => uvRect(r, 256));

// atlas de decalques de parede 512×512 (papel, placas, relógio, capacho)
const AT = {
  calendar: [0, 0, 160, 232], bulletin: [160, 0, 352, 232], poster: [0, 232, 160, 208], clock: [160, 232, 128, 128],
  exit: [288, 232, 128, 56], wcM: [288, 288, 64, 64], wcF: [352, 288, 64, 64], mug: [416, 232, 96, 120],
  ext: [416, 352, 96, 64], doormat: [160, 360, 256, 80], nameplate: [0, 440, 320, 72], note: [320, 440, 64, 72],
};
const ATUV = Object.fromEntries(Object.entries(AT).map(([k, r]) => [k, uvRect(r, 512)]));
function paint(g, r, fn) { g.save(); g.translate(r[0], r[1]); g.beginPath(); g.rect(0, 0, r[2], r[3]); g.clip(); fn(g, r[2], r[3]); g.restore(); }
const FONT = '"Trebuchet MS", "Segoe UI", sans-serif';

function drawCalendar(g, w, h, date) {
  const y = date.getFullYear(), m = date.getMonth(), today = date.getDate();
  g.fillStyle = '#fbfaf5'; g.fillRect(0, 0, w, h);
  const sky = g.createLinearGradient(0, 8, 0, 94); sky.addColorStop(0, '#79b0e0'); sky.addColorStop(1, '#dcefff');
  g.fillStyle = sky; g.fillRect(7, 10, w - 14, 84);
  g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(122, 32, 11, 0, TAU); g.fill();
  g.fillStyle = '#6aa84f'; g.beginPath(); g.moveTo(7, 80); g.quadraticCurveTo(60, 48, 110, 74); g.quadraticCurveTo(135, 64, 153, 70); g.lineTo(153, 94); g.lineTo(7, 94); g.fill();
  g.fillStyle = '#4c8a36'; g.beginPath(); g.moveTo(7, 94); g.quadraticCurveTo(70, 70, 153, 90); g.lineTo(153, 94); g.fill();
  g.fillStyle = '#b8342a'; g.fillRect(40, 66, 16, 12); g.fillStyle = '#7a2a22'; g.beginPath(); g.moveTo(37, 67); g.lineTo(48, 58); g.lineTo(59, 67); g.fill();
  g.fillStyle = '#555'; for (let i = 0; i < 9; i++) { g.beginPath(); g.arc(14 + i * 16.5, 5, 2.2, 0, TAU); g.fill(); }
  g.textAlign = 'center'; g.fillStyle = '#b8342a'; g.font = `700 15px ${FONT}`; g.fillText(`${MES[m]} ${y}`, w / 2, 113);
  g.font = `700 10px ${FONT}`;
  ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].forEach((d, i) => { g.fillStyle = i === 0 ? '#b8342a' : '#444'; g.fillText(d, 20 + i * 20, 130); });
  const first = new Date(y, m, 1).getDay(), nd = new Date(y, m + 1, 0).getDate();
  g.font = `600 10.5px ${FONT}`;
  for (let d = 1; d <= nd; d++) {
    const idx = first + d - 1, col = idx % 7, row = Math.floor(idx / 7), cx = 20 + col * 20, cy2 = 147 + row * 15.5;
    if (d === today) { g.strokeStyle = '#d0021b'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy2 - 3.5, 7.5, 0, TAU); g.stroke(); }
    g.fillStyle = col === 0 ? '#b8342a' : '#333'; g.fillText(String(d), cx, cy2);
  }
}
function note(g, x, y, w, h, rot, bg, pin, fn) {
  g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(rot);
  g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(-w / 2 + 2, -h / 2 + 3, w, h);
  g.fillStyle = bg; g.fillRect(-w / 2, -h / 2, w, h);
  g.translate(-w / 2, -h / 2); fn(g, w, h);
  g.fillStyle = pin; g.beginPath(); g.arc(w / 2, 5, 4, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(w / 2 - 1.3, 3.8, 1.3, 0, TAU); g.fill();
  g.restore();
}
function drawBulletin(g, w, h) {
  const r = rngOf('cortiça');
  g.fillStyle = '#b98a57'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2200; i++) { g.fillStyle = r() < 0.5 ? 'rgba(90,55,25,.35)' : 'rgba(230,190,140,.35)'; g.fillRect(r() * w, r() * h, 2, 1.5); }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  note(g, 10, 12, 108, 84, -0.05, '#ffffff', '#c0392b', (c, nw) => {
    c.fillStyle = '#b8342a'; c.font = `700 13px ${FONT}`; c.fillText('AVISO', 8, 22);
    c.fillStyle = '#333'; c.font = `11px ${FONT}`; wrapText(c, 'Quem pegou meu iogurte da geladeira, por favor devolva. Tinha NOME.', 8, 38, nw - 14, 12);
  });
  note(g, 126, 8, 104, 74, 0.04, '#fff27a', '#2f6fb3', c => {
    c.fillStyle = '#9a3412'; c.font = `700 14px ${FONT}`; c.fillText('FESTA DA', 8, 24); c.fillText('PIZZA!', 8, 40);
    c.fillStyle = '#333'; c.font = `11px ${FONT}`; c.fillText('sexta, 16h', 8, 56); c.fillText('traga R$ 10', 8, 68);
  });
  note(g, 240, 14, 102, 96, -0.02, '#ffffff', '#2e8b57', (c, nw) => {
    c.fillStyle = '#1e6b3a'; c.fillRect(0, 12, nw, 24); c.fillStyle = '#fff'; c.font = `700 10.5px ${FONT}`;
    c.fillText('DIAS SEM', 8, 22); c.fillText('ACIDENTES:', 8, 33);
    c.fillStyle = '#c0392b'; c.font = `700 48px ${FONT}`; c.textAlign = 'center'; c.fillText('0', nw / 2, 84); c.textAlign = 'left';
  });
  note(g, 14, 108, 124, 104, 0.03, '#d6ecfb', '#d9a441', (c, nw) => {
    c.fillStyle = '#1f3a5f'; c.font = `700 12.5px ${FONT}`; c.fillText('Comitê de Festas', 8, 24);
    c.fillStyle = '#333'; c.font = `11px ${FONT}`; wrapText(c, 'Reunião quinta na sala de reunião. Pauta: festa do sorvete (de novo).', 8, 40, nw - 14, 12.5);
  });
  note(g, 148, 94, 90, 126, -0.04, '#e3f5d8', '#8e44ad', (c, nw, nh) => {
    c.fillStyle = '#2d5a1e'; c.font = `700 12px ${FONT}`; c.fillText('VENDE-SE', 8, 24);
    c.fillStyle = '#333'; c.font = `10.5px ${FONT}`; wrapText(c, 'Bicicleta ergométrica. Pouco uso. Serve de cabide.', 8, 38, nw - 12, 12);
    c.strokeStyle = '#8aa77a'; for (let i = 0; i < 6; i++) { c.beginPath(); c.moveTo(4 + i * 14, nh - 26); c.lineTo(4 + i * 14, nh); c.stroke(); }
  });
  note(g, 248, 118, 94, 100, 0.05, '#fbd3e0', '#16a085', (c, nw) => {
    c.fillStyle = '#9b2c5a'; c.font = `700 11.5px ${FONT}`; wrapText(c, 'Parabéns aniversariantes do mês!', 8, 22, nw - 12, 13);
    c.fillStyle = '#f6e7c1'; c.fillRect(28, 60, 40, 20); c.fillStyle = '#e07a9b'; c.fillRect(28, 56, 40, 6);
    c.fillStyle = '#d9a441'; for (let i = 0; i < 3; i++) c.fillRect(34 + i * 12, 46, 2, 10);
  });
}
function drawPoster(g, w, h) {
  g.fillStyle = '#111'; g.fillRect(0, 0, w, h);
  const gr = g.createLinearGradient(0, 8, 0, 150); gr.addColorStop(0, '#1c2b4a'); gr.addColorStop(0.6, '#b8567a'); gr.addColorStop(1, '#f2a65a');
  g.fillStyle = gr; g.fillRect(8, 8, w - 16, 142);
  g.fillStyle = '#26203a'; g.beginPath(); g.moveTo(8, 150); g.lineTo(52, 72); g.lineTo(76, 104); g.lineTo(104, 58); g.lineTo(152, 150); g.fill();
  g.fillStyle = '#f5f1e6'; g.beginPath(); g.moveTo(98, 68); g.lineTo(104, 58); g.lineTo(111, 70); g.fill();
  g.strokeStyle = '#111'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(104, 58); g.lineTo(104, 42); g.stroke();
  g.fillStyle = '#d9a441'; g.fillRect(104, 42, 12, 7);
  g.textAlign = 'center'; g.fillStyle = '#f5f1e6'; g.font = `700 14px ${FONT}`; g.fillText('TRABALHO', w / 2, 172); g.fillText('EM EQUIPE', w / 2, 188);
  g.font = `italic 8.5px ${FONT}`; g.fillStyle = '#cfc8b8'; g.fillText('Juntos vamos mais longe (e mais devagar).', w / 2, 201);
}
function drawClock(g, w) {
  const R = w / 2 - 2, cx = w / 2;
  g.fillStyle = '#fbfaf6'; g.beginPath(); g.arc(cx, cx, R, 0, TAU); g.fill();
  g.strokeStyle = '#cfcbc0'; g.lineWidth = 3; g.stroke();
  for (let i = 0; i < 60; i++) {
    const a = i / 60 * TAU, big = i % 5 === 0, r0 = R - (big ? 11 : 6);
    g.strokeStyle = '#222'; g.lineWidth = big ? 3 : 1;
    g.beginPath(); g.moveTo(cx + Math.sin(a) * r0, cx - Math.cos(a) * r0); g.lineTo(cx + Math.sin(a) * (R - 3), cx - Math.cos(a) * (R - 3)); g.stroke();
  }
  g.fillStyle = '#1b1b1b'; g.font = `700 14px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) { const a = i / 12 * TAU; g.fillText(String(i), cx + Math.sin(a) * (R - 22), cx - Math.cos(a) * (R - 22) + 1); }
  g.font = `600 7px ${FONT}`; g.fillStyle = '#8a8578'; g.fillText('QUARTZ', cx, cx + 22);
  g.textBaseline = 'alphabetic';
}
function drawExit(g, w, h) {
  g.fillStyle = '#16874a'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#e8fff0'; g.lineWidth = 2; g.strokeRect(3, 3, w - 6, h - 6);
  g.fillStyle = '#ffffff'; g.font = `700 24px ${FONT}`; g.textAlign = 'left'; g.fillText('SAÍDA', 46, 37);
  g.strokeStyle = '#fff'; g.lineWidth = 3.2; g.lineCap = 'round';
  g.beginPath(); g.arc(26, 13, 3.6, 0, TAU); g.fillStyle = '#fff'; g.fill();
  g.beginPath(); g.moveTo(24, 19); g.lineTo(20, 32); g.lineTo(28, 38); g.lineTo(30, 47); g.moveTo(20, 32); g.lineTo(13, 44); g.moveTo(23, 22); g.lineTo(31, 27); g.lineTo(36, 23); g.moveTo(23, 22); g.lineTo(15, 26); g.stroke();
}
function drawWc(g, w, h, female) {
  g.fillStyle = '#2f5d8a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, 13, 6, 0, TAU); g.fill();
  if (female) { g.beginPath(); g.moveTo(w / 2, 20); g.lineTo(w / 2 + 12, 44); g.lineTo(w / 2 - 12, 44); g.fill(); g.fillRect(w / 2 - 7, 44, 4, 14); g.fillRect(w / 2 + 3, 44, 4, 14); }
  else { g.fillRect(w / 2 - 9, 21, 18, 22); g.fillRect(w / 2 - 8, 43, 6, 16); g.fillRect(w / 2 + 2, 43, 6, 16); }
}
function drawMugNote(g, w, h) {
  g.fillStyle = '#fff5a8'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#b8342a'; g.font = `700 16px "Comic Sans MS", ${FONT}`; g.textAlign = 'center';
  g.fillText('LAVE', w / 2, 30); g.fillText('SUA', w / 2, 50); g.fillText('CANECA!!!', w / 2, 70);
  g.fillStyle = '#333'; g.font = `11px "Comic Sans MS", ${FONT}`; g.fillText('isso vale pra', w / 2, 92); g.fillText('VOCÊ.', w / 2, 106);
  g.strokeStyle = '#b8342a'; g.lineWidth = 2; g.beginPath(); g.moveTo(14, 76); g.lineTo(w - 14, 74); g.stroke();
}
function drawExtSign(g, w, h) {
  g.fillStyle = '#c0281f'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.font = `700 13px ${FONT}`; g.textAlign = 'center'; g.fillText('EXTINTOR', w / 2, h - 12);
  g.beginPath(); g.moveTo(w / 2, 6); g.quadraticCurveTo(w / 2 + 14, 22, w / 2 + 6, 36); g.quadraticCurveTo(w / 2, 28, w / 2 - 6, 36); g.quadraticCurveTo(w / 2 - 14, 22, w / 2, 6); g.fill();
}
function drawDoormat(g, w, h) {
  const r = rngOf('capacho');
  g.fillStyle = '#39332e'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 1500; i++) { g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.35)' : 'rgba(120,110,95,.3)'; g.fillRect(r() * w, r() * h, 1, 2); }
  g.strokeStyle = '#6a5f53'; g.lineWidth = 3; g.strokeRect(8, 8, w - 16, h - 16);
  g.fillStyle = '#cdbd9b'; g.font = `700 30px ${FONT}`; g.textAlign = 'center'; g.fillText('BEM-VINDO', w / 2, h / 2 + 11);
}
function drawNameplate(g, w, h, name) {
  g.fillStyle = '#1f3a5f'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#d9a441'; g.lineWidth = 3; g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = '#f3e4c0'; g.textAlign = 'center';
  let s = 30; do { g.font = `700 ${s}px Georgia, "Times New Roman", serif`; s -= 2; } while (g.measureText(name).width > w - 30 && s > 12);
  g.fillText(name, w / 2, h / 2 + s / 3 + 2);
}
function drawStickyNote(g, w, h) {
  g.fillStyle = '#fff27a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#555'; for (let y = 14; y < h - 6; y += 9) g.fillRect(8, y, w - 16 - (y % 3) * 6, 2);
}
function drawAtlas(c, name, date) {
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 512);
  paint(g, AT.calendar, (x, w, h) => drawCalendar(x, w, h, date));
  paint(g, AT.bulletin, drawBulletin);
  paint(g, AT.poster, drawPoster);
  paint(g, AT.clock, x => drawClock(x, AT.clock[2]));
  paint(g, AT.exit, drawExit);
  paint(g, AT.wcM, (x, w, h) => drawWc(x, w, h, false));
  paint(g, AT.wcF, (x, w, h) => drawWc(x, w, h, true));
  paint(g, AT.mug, drawMugNote);
  paint(g, AT.ext, drawExtSign);
  paint(g, AT.doormat, drawDoormat);
  paint(g, AT.nameplate, (x, w, h) => drawNameplate(x, w, h, name));
  paint(g, AT.note, drawStickyNote);
}
// letreiro da recepção: painel ripado de madeira + letras de metal escovado com o nome do escritório
function drawSign(c, name) {
  const g = c.getContext('2d'), W = c.width, H = c.height, r = rngOf('ripas');
  for (let x = 0, i = 0; x < W; x += 32, i++) {
    g.fillStyle = css(i % 2 ? '#a3714a' : '#ae7c52', 0.94 + r() * 0.1); g.fillRect(x, 0, 32, H);
    for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(70,40,20,.12)'; g.fillRect(x + 3 + r() * 26, 0, 1, H); }
    g.fillStyle = 'rgba(40,22,10,.55)'; g.fillRect(x + 30, 0, 2, H);
  }
  const vg = g.createLinearGradient(0, 0, 0, H); vg.addColorStop(0, 'rgba(0,0,0,.18)'); vg.addColorStop(0.3, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.25)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // logotipo: três folhas de papel empilhadas
  const lx = W / 2, ly = 120;
  const sheets = [[-6, -0.08, '#f4f4f2'], [6, 0.05, '#e9eaec'], [18, -0.03, '#d9a441']];
  for (const [dy, rot, col] of sheets) {
    g.save(); g.translate(lx, ly + dy); g.rotate(rot);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(-58, -7, 120, 20);
    g.fillStyle = col; g.fillRect(-60, -10, 120, 18); g.strokeStyle = '#1f3a5f'; g.lineWidth = 3; g.strokeRect(-60, -10, 120, 18);
    g.restore();
  }
  // nome
  let size = 118;
  const fontOf = s => `700 ${s}px Georgia, "Times New Roman", serif`;
  do { g.font = fontOf(size); size -= 4; } while (g.measureText(name).width > W - 90 && size > 34);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const ny = 262;
  g.fillStyle = 'rgba(20,10,4,.55)'; g.fillText(name, W / 2 + 4, ny + 6);
  const mg = g.createLinearGradient(0, ny - size / 2, 0, ny + size / 2);
  mg.addColorStop(0, '#fbfbf9'); mg.addColorStop(0.45, '#c4c8cc'); mg.addColorStop(0.55, '#aeb3b8'); mg.addColorStop(1, '#eceded');
  g.fillStyle = mg; g.fillText(name, W / 2, ny);
  g.strokeStyle = 'rgba(60,60,60,.5)'; g.lineWidth = 1.5; g.strokeText(name, W / 2, ny);
  // subtítulo
  g.font = `700 30px ${FONT}`;
  const sub = 'E S C R I T Ó R I O   R E G I O N A L';
  g.fillStyle = 'rgba(20,10,4,.5)'; g.fillText(sub, W / 2 + 2, ny + size / 2 + 50);
  g.fillStyle = '#f1e3c8'; g.fillText(sub, W / 2, ny + size / 2 + 48);
  g.textBaseline = 'alphabetic';
}
// adesivo no vidro da entrada (visto de fora; de dentro aparece espelhado, como na vida real)
function drawVinyl(c, name) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.9)';
  let s = 44; do { g.font = `700 ${s}px Georgia, serif`; s -= 2; } while (g.measureText(name).width > W - 20 && s > 14);
  g.fillText(name, W / 2, 56);
  g.font = `22px ${FONT}`; g.fillText('Seg a Sex · 8h às 18h', W / 2, 98);
  g.fillRect(W / 2 - 120, 70, 240, 2);
}
// vista pela janela (panorama que se repete): céu pela hora, prédios, árvores, estacionamento, postes
function drawView(c, s) {
  const g = c.getContext('2d'), W = c.width, H = c.height, r = rngOf('vista');
  const night = s.light < 0.25, L = 0.35 + 0.65 * s.light;
  const sky = g.createLinearGradient(0, 0, 0, 78);
  sky.addColorStop(0, s.top.getStyle()); sky.addColorStop(1, s.hor.getStyle());
  g.fillStyle = sky; g.fillRect(0, 0, W, 80);
  if (night) { for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(255,255,240,${0.35 + r() * 0.6})`; g.fillRect(r() * W, r() * 58, 1, 1); } }
  else {
    for (let i = 0; i < 9; i++) {
      const x = r() * W, y = 10 + r() * 34, w = 40 + r() * 70;
      g.fillStyle = `rgba(255,255,255,${(0.35 + r() * 0.3) * s.light})`;
      g.beginPath(); g.ellipse(x, y, w / 2, 6 + r() * 5, 0, 0, TAU); g.ellipse(x + w * 0.2, y - 5, w / 3, 6, 0, 0, TAU); g.fill();
    }
  }
  // prédios ao longe
  let x = 0;
  while (x < W) {
    const w = 30 + r() * 60, h = 14 + r() * 34;
    g.fillStyle = css(night ? '#1b2233' : '#8d98a4', night ? 1 : (0.8 + r() * 0.25) * L); g.fillRect(x, 76 - h, w, h);
    for (let wy = 76 - h + 4; wy < 72; wy += 6) for (let wx = x + 3; wx < x + w - 4; wx += 6) {
      if (night) { if (r() < 0.3) { g.fillStyle = r() < 0.7 ? '#ffd98a' : '#cfe3ff'; g.fillRect(wx, wy, 3, 3); } }
      else if (r() < 0.6) { g.fillStyle = 'rgba(200,225,245,.55)'; g.fillRect(wx, wy, 3, 3); }
    }
    x += w + r() * 20;
  }
  // árvores
  for (let i = 0; i < 70; i++) { g.fillStyle = css(night ? '#101820' : pickR(['#5f7f55', '#557a4c', '#6a8a5a'], r), night ? 1 : L); g.beginPath(); g.arc(r() * W, 74 + r() * 4, 5 + r() * 7, 0, TAU); g.fill(); }
  // gramado + asfalto
  g.fillStyle = css(night ? '#1a2620' : '#7a9a5c', night ? 1 : L); g.fillRect(0, 76, W, 7);
  g.fillStyle = css(night ? '#22252b' : '#6d7073', night ? 1 : L); g.fillRect(0, 83, W, H - 83);
  g.strokeStyle = night ? 'rgba(200,200,190,.35)' : 'rgba(240,240,230,.75)'; g.lineWidth = 2;
  for (let lx = 0; lx < W + 20; lx += 46) { g.beginPath(); g.moveTo(lx, 92); g.lineTo(lx - 14, 122); g.stroke(); }
  const carCols = ['#8b1e2d', '#2d4f7a', '#c9c3b5', '#3d3f42', '#5a6e4e', '#d9d4c7', '#7a5a2e', '#9aa5ad'];
  for (let lx = 6; lx < W; lx += 46) {
    if (r() < 0.38) continue;
    const cx = lx + 4, col = pickR(carCols, r);
    g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(cx - 2, 116, 36, 4);
    g.fillStyle = css(col, night ? 0.35 : L); if (g.roundRect) { g.beginPath(); g.roundRect(cx, 100, 32, 16, 4); g.fill(); } else g.fillRect(cx, 100, 32, 16);
    g.fillStyle = css(night ? '#0e141c' : '#2e3b4a', 1); g.fillRect(cx + 6, 102, 20, 5);
  }
  // postes
  for (let px = 60; px < W; px += 256) {
    g.fillStyle = '#3c4046'; g.fillRect(px, 52, 3, 50); g.fillRect(px - 8, 52, 14, 3);
    if (night) {
      const gl = g.createRadialGradient(px - 4, 56, 1, px - 4, 56, 26); gl.addColorStop(0, 'rgba(255,220,140,.95)'); gl.addColorStop(1, 'rgba(255,220,140,0)');
      g.fillStyle = gl; g.fillRect(px - 32, 30, 56, 52);
      const pool = g.createRadialGradient(px, 112, 2, px, 112, 40); pool.addColorStop(0, 'rgba(255,210,130,.35)'); pool.addColorStop(1, 'rgba(255,210,130,0)');
      g.fillStyle = pool; g.fillRect(px - 44, 90, 88, 38);
    }
  }
}

// ---------------------------------------------------------------- CSS próprio (prefixo amb-)
function injectCss() {
  if (document.getElementById('amb-style')) return;
  const st = document.createElement('style');
  st.id = 'amb-style';
  st.textContent = `
  .amb-snd { display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:12.5px; color:var(--ink,#1f2a36); }
  .amb-snd button { cursor:pointer; border:1px solid rgba(31,58,95,.25); background:#fff; border-radius:6px; padding:2px 8px; font:inherit; color:inherit; white-space:nowrap; }
  .amb-snd button:hover { background:#f3ecdc; }
  .amb-snd.amb-off button { color:#8a8f96; }
  .amb-snd input[type=range] { width:70px; accent-color:#1f3a5f; }
  .amb-snd.amb-off input[type=range] { opacity:.45; }
  .amb-mural { min-height:100%; padding:18px; background:#b98a57 radial-gradient(rgba(90,55,25,.25) 1px, transparent 1.5px) 0 0/7px 7px;
    display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:16px; align-content:start; }
  .amb-mural .amb-n { position:relative; padding:14px 14px 12px; background:var(--bg,#fff); color:#2a2d31; box-shadow:0 3px 8px rgba(0,0,0,.28); rotate:var(--r,0deg); line-height:1.4; }
  .amb-mural .amb-n::before { content:''; position:absolute; top:-5px; left:calc(50% - 6px); width:12px; height:12px; border-radius:50%; background:var(--pin,#c0392b); box-shadow:0 1px 2px rgba(0,0,0,.45); }
  .amb-mural h3 { margin:0 0 6px; font-size:15px; color:var(--h,#1f3a5f); }
  .amb-mural p { margin:0; font-size:13.5px; }
  .amb-mural .amb-big { font:700 54px/1 Georgia, serif; color:#c0392b; text-align:center; margin-top:4px; }
  .amb-mural .amb-cal { width:100%; border-collapse:collapse; font-size:12px; text-align:center; }
  .amb-mural .amb-cal th { color:#666; font-weight:700; padding:2px 0; }
  .amb-mural .amb-cal td { padding:2px 0; }
  .amb-mural .amb-cal td.amb-dom, .amb-mural .amb-cal th.amb-dom { color:#b8342a; }
  .amb-mural .amb-cal td.amb-hoje { outline:2px solid #d0021b; border-radius:50%; font-weight:700; }
  `;
  document.head.append(st);
}

// ============================================================ install
export function install(api) {
  const { WALL_T, CEIL_H, PART_H, DOOR_H } = api.consts;
  const T2 = WALL_T / 2;
  const DET = api.quality.detail;                  // 1 alta · 0,75 média · 0,5 baixa (fixo até recarregar)
  const RICH = DET >= 0.9, MID = DET >= 0.7;
  injectCss();

  // ---- texturas e materiais (uma vez; compartilhados entre rebuilds)
  const aniso = Math.min(RICH ? 8 : MID ? 4 : 1, api.renderer.capabilities.getMaxAnisotropy?.() || 1);
  const atlasCanvas = mkCanvas(512, 512), signCanvas = mkCanvas(1024, 512), vinylCanvas = mkCanvas(512, 128), viewCanvas = mkCanvas(1024, 128);
  const tex = {
    carpet: texOf(drawCarpet(), { repeat: true }), ceil: texOf(drawCeiling(), { repeat: true }), lino: texOf(drawLino(), { repeat: true }),
    blinds: texOf(drawBlinds(), { repeat: true }), blob: texOf(drawBlob(), { mip: false }), stripes: texOf(drawStripes(), { mip: false }),
    louver: texOf(drawLouver()), screens: texOf(drawScreens()), atlas: texOf(atlasCanvas), sign: texOf(signCanvas),
    vinyl: texOf(vinylCanvas, { mip: false }), view: texOf(viewCanvas, { repeat: true }),
  };
  tex.carpet.anisotropy = aniso; tex.ceil.anisotropy = aniso; tex.lino.anisotropy = aniso; tex.sign.anisotropy = Math.min(4, aniso);
  const shared = m => { m.userData.shared = true; return m; };
  const floorOff = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 };
  const M = {
    vc: shared(new THREE.MeshLambertMaterial({ vertexColors: true })),
    out: shared(new THREE.MeshLambertMaterial({ vertexColors: true })),        // lá fora (escurece à noite)
    glow: shared(new THREE.MeshBasicMaterial({ vertexColors: true })),
    glass: shared(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false })),
    floor: shared(new THREE.MeshLambertMaterial({ vertexColors: true, ...floorOff })),
    lino: shared(new THREE.MeshLambertMaterial({ map: tex.lino, ...floorOff })),
    ceil: shared(new THREE.MeshBasicMaterial({ map: tex.ceil, color: '#dddbd3', depthWrite: false })),
    blinds: shared(new THREE.MeshLambertMaterial({ map: tex.blinds, vertexColors: true })),
    view: shared(new THREE.MeshBasicMaterial({ map: tex.view })),
    screens: shared(new THREE.MeshBasicMaterial({ map: tex.screens, vertexColors: true })),
    decal: shared(new THREE.MeshLambertMaterial({ map: tex.atlas, vertexColors: true })),
    decalGlow: shared(new THREE.MeshBasicMaterial({ map: tex.atlas })),
    sign: shared(new THREE.MeshLambertMaterial({ map: tex.sign })),
    vinyl: shared(new THREE.MeshBasicMaterial({ map: tex.vinyl, transparent: true, depthWrite: false, side: THREE.DoubleSide })),
    lamp: shared(new THREE.MeshBasicMaterial({ map: tex.louver })),
    hands: shared(new THREE.MeshBasicMaterial({ color: '#ffffff' })),
    blob: shared(new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    sun: shared(new THREE.MeshBasicMaterial({ map: tex.stripes, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: '#ffe7b8', opacity: 0.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    bubble: shared(new THREE.MeshBasicMaterial({ color: '#eef9ff', transparent: true, opacity: 0.75, depthWrite: false })),
    led: shared(new THREE.MeshBasicMaterial({ color: '#39d353' })),
    paper: shared(new THREE.MeshLambertMaterial({ color: '#f7f5ee', side: THREE.DoubleSide })),
    donut: shared(new THREE.MeshLambertMaterial({ color: '#ffffff' })),
  };
  // geometrias dos repetidos dinâmicos (compartilhadas: sobrevivem ao esvaziamento do layoutGroup)
  const GEO = {
    lamp: planeG(1.14, 0.54).rotateX(HALF),
    hand: boxG(1, 1, 1),
    donut: new THREE.TorusGeometry(0.036, 0.016, 5, 10).rotateX(HALF),
    bubble: new THREE.SphereGeometry(0.016, 6, 4),
    led: boxG(0.03, 0.016, 0.02),
    sheet: planeG(0.2, 0.28).rotateX(-HALF),
  };
  for (const g of Object.values(GEO)) g.userData.shared = true;

  // ---- estado vivo da cena (recriado a cada layoutChanged)
  const S = {
    lay: null, name: null, atlasDay: '', lamps: null, lampList: [], flicker: [], clocks: [], hands: null, donuts: null,
    bubbles: null, cooler: null, copier: null, sunMesh: null, dynamic: [], ok: false, stats: {},
  };
  const copier = { busy: false, t: 0, dur: 0, jam: 0, pages: 0, nextAuto: performance.now() / 1000 + 150 + Math.random() * 200 };
  const bubbleState = { active: false, t: 0, next: 6 + Math.random() * 10, seeds: [] };
  const donutState = loadDonuts();

  function loadDonuts() {
    const day = new Date().toISOString().slice(0, 10);
    try { const j = JSON.parse(lsGet(LS_DONUT) || 'null'); if (j && j.d === day && Number.isFinite(j.left)) return { d: day, left: Math.max(0, Math.min(12, j.left)) }; } catch { /* */ }
    return { d: day, left: 12 };
  }

  // ============================================================ construção (a cada layoutChanged)

  function build() {
    const office = api.office, lay = office.layout;
    S.lay = lay;
    const grid = lay.grid, W = lay.W, D = lay.D, b0 = lay.b0, b1 = lay.b1, cx = lay.cx, partZ = lay.partZ;
    const chAt = (gx, gz) => (grid[gz] || '')[gx] || ' ';
    const root = api.layoutGroup('ambiente');
    const B = {
      vc: new Batch(), glow: new Batch(), glass: new Batch(), floor: new Batch(), lino: new Batch(), ceil: new Batch(),
      blinds: new Batch(), view: new Batch(), screens: new Batch(), decal: new Batch(), decalGlow: new Batch(),
      sign: new Batch(), vinyl: new Batch(), blob: new Batch(), sun: new Batch(),
      out: new Batch(), outGlow: new Batch(),   // lá fora: desenhado ANTES do forro (que não grava profundidade)
    };
    const allTris = () => Object.values(B).reduce((a, b) => a + b.tris, 0);
    S.stats.sec = {};
    const sec = (name, fn) => {
      const t0 = allTris();
      try { fn(); } catch (err) { console.error(`[ambiente] ${name}:`, err); }
      S.stats.sec[name] = Math.round(allTris() - t0);
    };
    const reserved = new Set();                 // células de parede externa ocupadas por decoração ('W12', 'E4'...)
    const blob = (x, z, w, d, yaw = 0) => B.blob.add(planeG(w, d), { x, y: 0.011, z, rx: -HALF, ry: yaw, order: 'YXZ', world: true });
    const wallFrame = (side, along) => {
      if (side === 'W') setFrame(0.5 + T2, 0, along, HALF);
      else if (side === 'E') setFrame(W - 0.5 - T2, 0, along, -HALF);
      else if (side === 'S') setFrame(along, 0, -0.5 - T2, Math.PI);
      else setFrame(along, 0, -(D - 0.5) + T2, 0);
    };
    const isFree = (gx, gz) => chAt(gx, gz) === '.' && !office.zones.wander?.some(p => Math.floor(p.x) === gx && Math.floor(-p.z) === gz);
    const furn = kind => office.furniture.filter(f => f.kind === kind);
    const clocks = [];

    // ---------------- piso: carpete (textura no material da planta) + recolorir a calçada
    sec('piso', () => {
      const fm = office.materials.floor;
      fm.map = tex.carpet; fm.color.set('#ffffff'); fm.needsUpdate = true;
      tex.carpet.repeat.set(W / 2, D / 2);
      office.materials.outside.color.set('#b7b3a8');
    });

    // ---------------- forro + luminárias
    sec('forro', () => {
      resetFrame();
      B.ceil.add(planeG(W, D), { x: W / 2, y: CEIL_H, z: -D / 2, rx: HALF, uvRepeat: [W / 1.2, D / 1.2], world: true });
      const spots = [];
      for (let z = -D + 0.9; z < -0.4; z += 2.4) for (let x = 1.2; x < W - 0.6; x += 2.4) {
        let ok = true;
        for (const dx of [-0.55, 0, 0.55]) for (const dz of [-0.25, 0.25]) {
          const ch = chAt(Math.floor(x + dx), Math.floor(-(z + dz)));
          if (WALLISH.has(ch) || ch === ' ' || ch === 'k' || ch === 'B') ok = false;
        }
        if (ok) spots.push({ x, z, area: api.getAreaAt(x, z) });
      }
      for (const p of spots) {
        bx(B.vc, p.x - 0.63, p.x + 0.63, CEIL_H - 0.035, CEIL_H - 0.002, p.z - 0.33, p.z + 0.33, '#e4e3dd');
      }
      if (MID) {                                // grelhas de retorno de ar entre as luminárias
        const r = rngOf(`${office.id}:grelhas`);
        for (const p of spots) {
          if (r() > 0.22) continue;
          const gx = p.x + 1.2, gz = p.z;
          const ch = chAt(Math.floor(gx), Math.floor(-gz));
          if (WALLISH.has(ch) || ch === ' ' || ch === 'k') continue;
          bx(B.vc, gx - 0.28, gx + 0.28, CEIL_H - 0.02, CEIL_H - 0.002, gz - 0.28, gz + 0.28, '#d2d0c8');
          B.vc.add(planeG(0.46, 0.46), { x: gx, y: CEIL_H - 0.021, z: gz, rx: HALF, color: '#77796f', world: true });
          for (const i of [-1, 1]) bx(B.vc, gx - 0.23, gx + 0.23, CEIL_H - 0.026, CEIL_H - 0.02, gz + i * 0.09 - 0.025, gz + i * 0.09 + 0.025, '#b9bab3');
        }
      }
      const inst = new THREE.InstancedMesh(GEO.lamp, M.lamp, Math.max(1, spots.length));
      inst.count = spots.length;
      const m4 = new THREE.Matrix4(), white = new THREE.Color('#ffffff');
      spots.forEach((p, i) => { m4.makeTranslation(p.x, CEIL_H - 0.037, p.z); inst.setMatrixAt(i, m4); inst.setColorAt(i, white); });
      inst.name = 'ambiente:luminarias'; inst.computeBoundingSphere();
      root.add(inst); S.dynamic.push(inst);
      S.lamps = inst; S.lampList = spots;
      // quem pisca: uma na área aberta perto da copa (clássico) e outra tremendo de leve em outro canto
      const area = spots.map((p, i) => ({ p, i })).filter(o => o.p.area === 'area');
      const others = spots.map((p, i) => ({ p, i })).filter(o => o.p.area !== 'area' && o.p.area !== 'sala');
      S.flicker = [];
      if (area.length) {
        const dCopa = o => Math.hypot(o.p.x - 3, o.p.z + b0 + 3);            // perto da copa
        const near = area.slice().sort((a, b) => dCopa(a) - dCopa(b));
        const pickA = near[hash(office.id) % Math.min(3, near.length)];
        S.flicker.push({ i: pickA.i, x: pickA.p.x, z: pickA.p.z, mode: 'forte', t: 0, next: 4 + Math.random() * 6, on: true, level: 1 });
      }
      if (others.length) {
        const o = others[hash(office.id + 'b') % others.length];
        S.flicker.push({ i: o.i, x: o.p.x, z: o.p.z, mode: 'leve', t: 0, next: 0, on: true, level: 1 });
      }
    });

    // ---------------- acabamentos das paredes: rodapés, capa da divisória, caixilhos do vidro, batentes
    sec('acabamentos', () => {
      resetFrame();
      const e = 0.012;
      for (const w of office.walls) {
        if (w.kind === 'wall' || w.kind === 'post') bx(B.vc, w.x0 - e, w.x1 + e, 0, 0.09, w.z0 - e, w.z1 + e, COL.baseboard);
        else if (w.kind === 'partition') {
          bx(B.vc, w.x0 - 0.015, w.x1 + 0.015, PART_H, PART_H + 0.035, w.z0 - 0.015, w.z1 + 0.015, '#9b7b55');
          bx(B.vc, w.x0 - e, w.x1 + e, 0, 0.08, w.z0 - e, w.z1 + e, '#6e6a60');
        } else if (w.kind === 'glass') {
          const alongX = (w.x1 - w.x0) >= (w.z1 - w.z0);
          bx(B.vc, w.x0, w.x1, 0, 0.07, w.z0 - 0.012, w.z1 + 0.012, COL.alu);
          bx(B.vc, w.x0, w.x1, CEIL_H - 0.07, CEIL_H, w.z0 - 0.012, w.z1 + 0.012, COL.alu);
          if (alongX) for (let x = Math.ceil(w.x0 + 0.3); x < w.x1 - 0.3; x++) bx(B.vc, x - 0.025, x + 0.025, 0, CEIL_H, w.z0 - 0.012, w.z1 + 0.012, COL.alu);
          else for (let z = Math.ceil(w.z0 + 0.3); z < w.z1 - 0.3; z++) bx(B.vc, w.x0 - 0.012, w.x1 + 0.012, 0, CEIL_H, z - 0.025, z + 0.025, COL.alu);
        } else if (w.kind === 'lintel') {       // vão de porta de sala: batentes de alumínio
          for (const x of [w.x0, w.x1]) bx(B.vc, x - 0.035, x + 0.035, 0, DOOR_H, w.z0 - 0.02, w.z1 + 0.02, COL.alu);
          bx(B.vc, w.x0, w.x1, DOOR_H - 0.05, DOOR_H, w.z0 - 0.02, w.z1 + 0.02, COL.alu);
        } else if (w.kind === 'entrance') {     // porta de vidro da recepção: caixilho, bandeira e puxadores
          const zc = (w.z0 + w.z1) / 2;
          bx(B.vc, w.x0, w.x1, 0, 0.08, w.z0 - 0.01, w.z1 + 0.01, COL.alu);
          bx(B.vc, w.x0, w.x1, DOOR_H, DOOR_H + 0.06, w.z0 - 0.01, w.z1 + 0.01, COL.alu);
          bx(B.vc, w.x0, w.x1, CEIL_H - 0.06, CEIL_H, w.z0 - 0.01, w.z1 + 0.01, COL.alu);
          const mid = (w.x0 + w.x1) / 2;
          for (const x of [w.x0 + 0.03, mid, w.x1 - 0.03]) bx(B.vc, x - 0.03, x + 0.03, 0, CEIL_H, w.z0 - 0.01, w.z1 + 0.01, COL.alu);
          for (const s of [-1, 1]) for (const [a, b] of [[mid - 0.6, mid - 0.1], [mid + 0.1, mid + 0.6]]) bx(B.vc, a, b, 1.0, 1.04, zc + s * 0.11 - 0.015, zc + s * 0.11 + 0.015, '#8d9298');
        }
      }
    });

    // ---------------- janelas com persiana nas paredes externas (vista muda com a hora)
    function windowAt(w, along) {
      const r = rngOf(`${office.id}:jan:${along.toFixed(2)}`);
      const y0 = 0.92, h = 1.36, y1 = y0 + h, cover = 0.2 + r() * 0.55;
      B.view.add(planeG(w, h), { x: 0, y: y0 + h / 2, z: 0.006, uv: [along / 12, 0, (along + w) / 12, 1] });
      const fc = COL.frame;
      bx(B.vc, -w / 2 - 0.05, w / 2 + 0.05, y1, y1 + 0.05, 0, 0.05, fc);
      bx(B.vc, -w / 2 - 0.08, w / 2 + 0.08, y0 - 0.04, y0, 0, 0.14, '#dcd9d0');
      bx(B.vc, -w / 2 - 0.05, -w / 2, y0, y1, 0, 0.05, fc);
      bx(B.vc, w / 2, w / 2 + 0.05, y0, y1, 0, 0.05, fc);
      bx(B.vc, -0.02, 0.02, y0, y1, 0, 0.035, fc);
      const hb = h * cover;
      bx(B.blinds, -w / 2 + 0.02, w / 2 - 0.02, y1 - hb, y1 - 0.03, 0.05, 0.058, r() < 0.7 ? '#ffffff' : '#efe6d2', { uvRepeat: [1, hb / 0.05] });
      bx(B.vc, -w / 2, w / 2, y1 - 0.045, y1 + 0.005, 0.04, 0.09, '#efece4');
      bx(B.vc, -w / 2 + 0.02, w / 2 - 0.02, y1 - hb - 0.025, y1 - hb, 0.045, 0.066, '#e2ded3');
      if (RICH) { bx(B.vc, w / 2 - 0.1, w / 2 - 0.092, y1 - hb - 0.3, y1 - 0.04, 0.075, 0.083, '#d6d2c8'); bc(B.vc, w / 2 - 0.096, y1 - hb - 0.32, 0.079, 0.025, 0.05, 0.025, '#cfcabe'); }
      const Ls = 0.5 + (1 - cover) * 1.7;
      B.sun.add(planeG(w * 0.95, Ls), { x: 0, y: 0.012, z: 0.12 + Ls / 2, rx: -HALF });
    }
    sec('janelas', () => {
      // decoração que ocupa parede externa (reserva antes das janelas)
      for (let gz = b0 + 7; gz <= b0 + 10; gz++) reserved.add(`W${gz}`);          // mural + calendário + relógio
      reserved.add(`E${b1 - 3}`); reserved.add(`W${lay.band0 + 1}`); reserved.add('E4');  // extintores, pôster
      const runs = [];
      const scan = (side, n, wall, inner) => {
        let run = null;
        for (let i = 1; i <= n; i++) {
          const ok = i < n && wall(i) === '#' && inner(i) === '.' && !reserved.has(`${side}${i}`);
          if (ok) { if (!run) run = { side, a: i, b: i }; else run.b = i; } else if (run) { runs.push(run); run = null; }
        }
      };
      scan('W', D - 1, i => chAt(0, i), i => chAt(1, i));
      scan('E', D - 1, i => chAt(W - 1, i), i => chAt(W - 2, i));
      scan('S', W - 1, i => chAt(i, 0), i => chAt(i, 1));
      scan('N', W - 1, i => chAt(i, D - 1), i => chAt(i, D - 2));
      let nWin = 0;
      for (const run of runs) {
        const L = run.b - run.a + 1, n = Math.floor((L - 0.4 + 0.6) / 2.1);
        if (n < 1) continue;
        const step = L / n, w = Math.min(1.5, step - 0.6);
        for (let k = 0; k < n; k++) {
          const c = run.a + step * (k + 0.5);
          if (run.side === 'W' || run.side === 'E') wallFrame(run.side, -c); else wallFrame(run.side, c);
          windowAt(w, c + { W: 0, E: 3.3, S: 6.1, N: 9.7 }[run.side]);
          nWin++;
        }
      }
      S.stats.windows = nWin;
    });

    // ---------------- recepção: parede do letreiro, balcão, sofá, capacho, placa de saída, pôster, adesivo
    sec('recepcao', () => {
      const pz = -(partZ + 0.5), face = pz + T2;
      const lx0 = cx + 3, lx1 = Math.min(cx + 8.6, W - 1.6);
      if (lx1 - lx0 >= 3) {
        resetFrame();
        bx(B.vc, lx0, lx1, PART_H, CEIL_H, pz - T2, pz + T2, COL.wall);
        B.sign.add(planeG(lx1 - lx0 - 0.1, CEIL_H - 0.14), { x: (lx0 + lx1) / 2, y: 0.1 + (CEIL_H - 0.14) / 2, z: face + 0.026, world: true });
        bx(B.vc, lx0, lx0 + 0.05, 0, CEIL_H, face, face + 0.035, COL.woodDark);
        bx(B.vc, lx1 - 0.05, lx1, 0, CEIL_H, face, face + 0.035, COL.woodDark);
        bx(B.vc, lx0, lx1, CEIL_H - 0.05, CEIL_H, face, face + 0.035, COL.woodDark);
        bx(B.vc, lx0, lx1, 0, 0.1, face, face + 0.04, COL.baseboard);
        api.addCollider({ x0: lx0, x1: lx1, z0: pz - T2, z1: pz + T2, y0: 0, y1: CEIL_H }, { layout: true });
        clocks.push({ x: lx1 - 0.55, y: 2.18, z: face + 0.03, yaw: 0, r: 0.19 });
      }
      // balcão em L
      const rx0 = cx + 3, rx1 = cx + 7, zf = -4, zb = -5, zr = -6, e = 0.04;
      resetFrame();
      bx(B.vc, rx0 + e, rx1 - e, 0, 1.08, zf - 0.3, zf - e, COL.wood, { grad: 0.18 });
      bx(B.vc, rx0 + e - 0.004, rx1 - e + 0.004, 0.86, 0.92, zf - 0.3, zf - e + 0.004, COL.navy);
      bx(B.vc, rx0 + e - 0.03, rx1 - e + 0.03, 1.08, 1.12, zf - 0.34, zf - e + 0.05, '#d9cfb8');
      bx(B.vc, rx0 + e, rx0 + 0.3, 0, 1.08, zr + e, zf - 0.3, COL.wood, { grad: 0.18 });
      bx(B.vc, rx0 + e - 0.004, rx0 + 0.3, 0.86, 0.92, zr + e, zf - 0.3, COL.navy);
      bx(B.vc, rx0 + e - 0.05, rx0 + 0.3, 1.08, 1.12, zr + e - 0.03, zf - 0.3, '#d9cfb8');
      bx(B.vc, rx0 + 0.3, rx1 - e, 0.72, 0.76, zb + e, zf - 0.3, COL.deskTop);
      bx(B.vc, rx0 + 0.3, rx0 + 1 - e, 0.72, 0.76, zr + e, zb + e, COL.deskTop);
      bx(B.vc, rx1 - e - 0.04, rx1 - e, 0, 0.72, zb + e, zf - 0.3, COL.woodDark);
      bx(B.vc, rx0 + 1 - e - 0.04, rx0 + 1 - e, 0, 0.72, zr + e, zb + e, COL.woodDark);
      B.decal.add(planeG(1.7, 0.38), { x: (rx0 + rx1) / 2, y: 0.5, z: zf - e + 0.004, uv: ATUV.nameplate, world: true });
      blob((rx0 + rx1) / 2, (zf + zb) / 2, 4.3, 1.4); blob(rx0 + 0.5, -5.5, 1.3, 1.3);
      // mesa da recepcionista
      setFrame(cx + 5.5, 0, -4.5, Math.PI);
      crt(0, 0.76, -0.05, 1, COL.beige);
      bx(B.vc, -0.21, 0.21, 0.76, 0.78, 0.2, 0.34, COL.plastic);
      bx(B.vc, 0.3, 0.36, 0.76, 0.782, 0.24, 0.32, COL.plastic);
      phone(-0.62, 0.76, 0.05, '#2d3036');
      if (MID) { papers(0.7, 0.76, 0.1, rngOf('rec-pap'), 3); pencilCup(-0.9, 0.76, -0.15); }
      resetFrame();
      // campainha, pote de balas, prancheta no tampo do balcão
      cy(B.vc, cx + 4, 1.12, -4.18, 0.05, 0.015, '#3a3a3a', 10);
      B.vc.add(new THREE.SphereGeometry(0.04, 10, 5, 0, TAU, 0, HALF), { x: cx + 4, y: 1.135, z: -4.18, color: '#d4b04a' });
      cy(B.vc, cx + 4, 1.175, -4.18, 0.006, 0.02, '#d4b04a', 6);
      cy(B.glass, cx + 6.2, 1.12, -4.2, 0.075, 0.2, '#dff2f2', 10);
      if (MID) { const rc = rngOf('balas'); for (let i = 0; i < 14; i++) bc(B.vc, cx + 6.2 + (rc() - 0.5) * 0.1, 1.13 + rc() * 0.09, -4.2 + (rc() - 0.5) * 0.1, 0.022, 0.018, 0.018, pickR(['#e74c3c', '#f1c40f', '#27ae60', '#8e44ad', '#e67e22'], rc)); }
      bc(B.vc, cx + 5.2, 1.125, -4.2, 0.24, 0.01, 0.32, '#8a6440', { ry: 0.12 });
      bc(B.vc, cx + 5.2, 1.132, -4.2, 0.21, 0.004, 0.28, COL.paper, { ry: 0.12 });
      // sofá em L (encosto para a janela/parede, assento virado para dentro)
      const sof = COL.leather, sofD = css(COL.leather, 0.8);
      bx(B.vc, 2.06, 5.94, 0.08, 0.42, -2.94, -2.06, sofD);
      bx(B.vc, 2.06, 2.94, 0.08, 0.42, -4.94, -2.94, sofD);
      for (let i = 0; i < 3; i++) bx(B.vc, 2.34 + i * 1.18, 2.34 + (i + 1) * 1.18 - 0.03, 0.4, 0.5, -2.92, -2.32, sof, { grad: 0.2 });
      for (let i = 0; i < 2; i++) bx(B.vc, 2.34, 2.94, 0.4, 0.5, -2.92 - (i + 1) * 1.0 + 0.03, -2.92 - i * 1.0, sof, { grad: 0.2 });
      bx(B.vc, 2.06, 5.94, 0.08, 0.86, -2.34, -2.06, sof, { grad: 0.25 });
      bx(B.vc, 2.06, 2.34, 0.08, 0.86, -4.94, -2.06, sof, { grad: 0.25 });
      bx(B.vc, 5.7, 5.94, 0.08, 0.64, -2.94, -2.06, sof, { grad: 0.2 });
      bx(B.vc, 2.06, 2.94, 0.08, 0.64, -4.94, -4.7, sof, { grad: 0.2 });
      for (const [px, pz2] of [[2.12, -2.12], [5.88, -2.12], [5.88, -2.88], [2.12, -4.88], [2.88, -4.88]]) bc(B.vc, px, 0.04, pz2, 0.06, 0.08, 0.06, COL.black);
      blob(4, -2.5, 4.3, 1.3); blob(2.5, -3.9, 1.3, 2.3);
      // tapete da sala de espera + mesinha de revistas
      resetFrame();
      B.floor.add(planeG(4.6, 3.9), { x: 4.2, y: 0.005, z: -3.95, rx: -HALF, color: '#3f4f66', world: true });
      B.floor.add(planeG(4.2, 3.5), { x: 4.2, y: 0.006, z: -3.95, rx: -HALF, color: '#5b6c84', world: true });
      const tcell = [[5, 4], [5, 3]].find(([gx, gz]) => isFree(gx, gz));
      if (tcell) {
        const tx = tcell[0] + 0.5, tz = -(tcell[1] + 0.5);
        bx(B.vc, tx - 0.38, tx + 0.38, 0.36, 0.4, tz - 0.28, tz + 0.28, COL.woodLight);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(B.vc, tx + sx * 0.33 - 0.02, tx + sx * 0.33 + 0.02, 0, 0.36, tz + sz * 0.23 - 0.02, tz + sz * 0.23 + 0.02, COL.woodDark);
        const rm = rngOf('revistas');
        for (let i = 0; i < 3; i++) bc(B.vc, tx + (rm() - 0.5) * 0.3, 0.405 + i * 0.008, tz + (rm() - 0.5) * 0.15, 0.21, 0.007, 0.28, pickR(['#c0392b', '#2f6fb3', '#f1c40f', '#27ae60', '#ecf0f1'], rm), { ry: (rm() - 0.5) * 0.8 });
        api.addCollider({ x0: tx - 0.4, x1: tx + 0.4, z0: tz - 0.3, z1: tz + 0.3, y1: 0.42 }, { layout: true });
        api.blockNavCell(tx, tz);
        blob(tx, tz, 1.0, 0.8);
      }
      // capacho de boas-vindas (caixa baixa com textura: não briga com o piso)
      bc(B.decal, cx + 0.5, 0.006, -1.25, 2.3, 0.012, 1.0, '#ffffff', { uv: ATUV.doormat });
      // placa de SAÍDA pendurada logo depois da porta
      const ex = cx + 0.5, ez = -0.95;
      bx(B.vc, ex - 0.22, ex + 0.22, 2.36, 2.56, ez - 0.03, ez + 0.03, '#f1f1ec');
      bx(B.vc, ex - 0.015, ex + 0.015, 2.56, CEIL_H, ez - 0.015, ez + 0.015, COL.metal);
      B.decalGlow.add(planeG(0.4, 0.17), { x: ex, y: 2.46, z: ez - 0.032, ry: Math.PI, uv: ATUV.exit, world: true });
      B.decalGlow.add(planeG(0.4, 0.17), { x: ex, y: 2.46, z: ez + 0.032, uv: ATUV.exit, world: true });
      // adesivo com o nome no vidro da entrada
      B.vinyl.add(planeG(1.7, 0.42), { x: cx + 0.5, y: 1.55, z: -0.5 + T2 + 0.006, world: true });
      // pôster motivacional na parede leste
      wallFrame('E', -4.5);
      bx(B.vc, -0.32, 0.32, 1.13, 1.97, 0, 0.02, '#1b1b1b');
      B.decal.add(planeG(0.56, 0.76), { x: 0, y: 1.55, z: 0.022, uv: ATUV.poster });
    });

    // ---------------- copa: bancada, cafeteira, micro-ondas, pia, bebedouro, geladeira, donuts, piso, mural
    sec('copa', () => {
      resetFrame();
      const wx = 0.5 + T2, cz0 = -(b0 + 5) + 0.04, cz1 = -b0 - 0.04;
      // piso vinílico
      const lz1 = -(b0 - 0.5) - T2, lz0 = -(b0 + 8), lx1 = 5.0;
      B.lino.add(planeG(lx1 - wx, lz1 - lz0), { x: (wx + lx1) / 2, y: 0.004, z: (lz0 + lz1) / 2, rx: -HALF, uvRepeat: [(lx1 - wx) / 1.2, (lz1 - lz0) / 1.2], world: true });
      bx(B.vc, lx1 - 0.02, lx1 + 0.02, 0, 0.008, lz0, lz1, COL.alu);
      bx(B.vc, wx, lx1, 0, 0.008, lz0 - 0.02, lz0 + 0.02, COL.alu);
      // bancada
      bx(B.vc, wx, 1.86, 0.1, 0.88, cz0, cz1, COL.cabinet, { grad: 0.12 });
      bx(B.vc, wx, 1.8, 0, 0.1, cz0 + 0.02, cz1 - 0.02, COL.baseboard);
      const nDoors = Math.max(1, Math.round((cz1 - cz0) / 0.62));
      const dl = (cz1 - cz0) / nDoors;
      for (let i = 0; i < nDoors; i++) {
        const s0 = cz0 + i * dl, s1 = s0 + dl, mid = (s0 + s1) / 2;
        bx(B.vc, 1.86, 1.872, 0.14, 0.84, s0 + 0.012, s1 - 0.012, COL.cabDoor);
        bx(B.vc, 1.872, 1.89, 0.72, 0.745, mid - 0.07, mid + 0.07, COL.metal);
        bx(B.vc, wx, wx + 0.36, 1.55, 2.25, s0 + 0.004, s1 - 0.004, COL.cabinet, { grad: 0.08 });
        bx(B.vc, wx + 0.36, wx + 0.372, 1.57, 2.23, s0 + 0.014, s1 - 0.014, COL.cabDoor);
        bx(B.vc, wx + 0.372, wx + 0.39, 1.6, 1.62, mid - 0.07, mid + 0.07, COL.metal);
      }
      bx(B.vc, wx, 1.94, 0.88, 0.92, cz0 - 0.01, cz1 + 0.01, COL.counter);
      bx(B.vc, wx, wx + 0.02, 0.92, 1.4, cz0, cz1, '#d9d3c3');
      blob(1.3, (cz0 + cz1) / 2, 1.6, cz1 - cz0 + 0.3);
      // pia (b0+3)
      let zc = -(b0 + 3.5);
      bx(B.vc, 1.0, 1.62, 0.915, 0.925, zc - 0.28, zc + 0.28, '#9aa0a6');
      bx(B.vc, 1.05, 1.57, 0.921, 0.927, zc - 0.23, zc + 0.23, '#5b6166');
      cy(B.vc, 0.8, 0.92, zc, 0.022, 0.26, COL.metal, 6);
      bx(B.vc, 0.8, 1.06, 1.15, 1.18, zc - 0.015, zc + 0.015, COL.metal);
      // bilhete "lave sua caneca" acima da pia
      setFrame(wx + 0.024, 0, zc, HALF);
      B.decal.add(planeG(0.2, 0.25), { x: 0, y: 1.18, z: 0, uv: ATUV.mug });
      resetFrame();
      // cafeteira (b0+1)
      zc = -(b0 + 1.5);
      bx(B.vc, 0.7, 1.05, 0.92, 1.3, zc - 0.14, zc + 0.14, '#2b2b2e');
      bx(B.vc, 0.7, 1.2, 1.24, 1.32, zc - 0.15, zc + 0.15, '#2b2b2e');
      cy(B.vc, 1.12, 0.92, zc, 0.085, 0.02, '#111', 10);
      cy(B.vc, 1.12, 0.94, zc, 0.068, 0.085, '#3b2413', 10);
      cy(B.glass, 1.12, 0.94, zc, 0.076, 0.17, '#d6eaf0', 10);
      bx(B.vc, 1.2, 1.215, 0.98, 1.08, zc - 0.012, zc + 0.012, COL.black);
      bx(B.glow, 1.051, 1.056, 1.0, 1.02, zc + 0.07, zc + 0.09, '#ff3b30');
      const rm = rngOf(`${office.id}:canecas`);
      for (let i = 0; i < (MID ? 3 : 1); i++) {
        const mx = 1.45 + (i % 2) * 0.16, mz = zc + 0.18 + i * 0.12;
        cy(B.vc, mx, 0.92, mz, 0.042, 0.1, pickR(['#f5f1e6', '#c0392b', '#2f6fb3', '#d9a441', '#27ae60'], rm), 8);
        bx(B.vc, mx + 0.04, mx + 0.07, 0.95, 0.99, mz - 0.008, mz + 0.008, '#e5e0d4');
      }
      bx(B.vc, 1.4, 1.58, 0.92, 1.14, zc - 0.33, zc - 0.21, '#b8322a');
      bx(B.vc, 1.4, 1.58, 1.14, 1.16, zc - 0.33, zc - 0.21, '#3a3a3a');
      // micro-ondas (b0+4)
      zc = -(b0 + 4.5);
      bx(B.vc, 0.66, 1.16, 0.92, 1.22, zc - 0.27, zc + 0.27, '#e9e7e1', { grad: 0.1 });
      bx(B.vc, 1.16, 1.166, 0.97, 1.17, zc - 0.23, zc + 0.08, '#2d3236');
      bx(B.vc, 1.16, 1.166, 0.97, 1.17, zc + 0.11, zc + 0.24, '#c9c6bd');
      bx(B.glow, 1.167, 1.17, 1.13, 1.155, zc + 0.13, zc + 0.22, '#58e07a');
      // porta-toalha de papel na parede
      B.vc.add(new THREE.CylinderGeometry(0.055, 0.055, 0.26, 8), { x: 0.68, y: 1.3, z: -(b0 + 2.55), rx: HALF, color: '#f4f2ea' });
      // bebedouro de galão (b0+5)
      const oc = furn('O')[0];
      if (oc) {
        const xc = 1.42, zo = (oc.z0 + oc.z1) / 2;
        bx(B.vc, xc - 0.17, xc + 0.17, 0, 0.95, zo - 0.17, zo + 0.17, '#e6e2d6', { grad: 0.18 });
        bx(B.vc, xc - 0.19, xc + 0.19, 0.95, 0.99, zo - 0.19, zo + 0.19, '#d4cfc2');
        bx(B.vc, xc + 0.17, xc + 0.21, 0.78, 0.82, zo - 0.08, zo - 0.03, '#2f6fb3');
        bx(B.vc, xc + 0.17, xc + 0.21, 0.78, 0.82, zo + 0.03, zo + 0.08, '#c0392b');
        bx(B.vc, xc + 0.12, xc + 0.23, 0.6, 0.625, zo - 0.11, zo + 0.11, '#8d9196');
        cy(B.glass, xc, 0.99, zo, 0.145, 0.42, '#86c6e6', 12);
        cy(B.vc, xc, 1.41, zo, 0.05, 0.03, '#2f6fb3', 8);
        cy(B.vc, xc - 0.05, 0.4, zo - 0.23, 0.042, 0.4, '#f1efe8', 8);
        blob(xc, zo, 0.7, 0.7);
        S.cooler = { x: xc, z: zo, y0: 1.02, y1: 1.38 };
      }
      // geladeira (b0+6)
      const fr = furn('F')[0];
      if (fr) {
        const zf = (fr.z0 + fr.z1) / 2;
        bx(B.vc, 1.06, 1.9, 0, 1.8, zf - 0.44, zf + 0.44, COL.fridge, { grad: 0.12 });
        bx(B.vc, 1.9, 1.905, 1.22, 1.24, zf - 0.43, zf + 0.43, '#b9b7b0');
        bx(B.vc, 1.905, 1.935, 1.3, 1.62, zf + 0.33, zf + 0.36, '#9ea3a8');
        bx(B.vc, 1.905, 1.935, 0.72, 1.12, zf + 0.33, zf + 0.36, '#9ea3a8');
        if (MID) {
          const rmag = rngOf('ímãs');
          for (let i = 0; i < 5; i++) bx(B.vc, 1.9, 1.912, 1.35 + rmag() * 0.35, 1.39 + rmag() * 0.35, zf - 0.3 + rmag() * 0.5, zf - 0.26 + rmag() * 0.5, pickR(['#e74c3c', '#f1c40f', '#2f6fb3', '#27ae60'], rmag));
          setFrame(1.912, 0, zf - 0.1, HALF);
          B.decal.add(planeG(0.12, 0.14), { x: 0, y: 1.0, z: 0, rz: 0.08, uv: ATUV.note });
          resetFrame();
          bx(B.vc, 1.2, 1.5, 1.8, 2.12, zf - 0.2, zf + 0.02, '#d9a441');
          bx(B.vc, 1.21, 1.49, 1.95, 2.02, zf + 0.02, zf + 0.024, '#b8342a');
        }
        blob(1.5, zf, 1.1, 1.1);
      }
      // mesa com donuts
      const dcell = [[4, b0 + 3], [4, b0 + 2], [4, b0 + 4], [3, b0 + 3]].find(([gx, gz]) => isFree(gx, gz));
      S.donuts = null;
      if (dcell) {
        const dx = dcell[0] + 0.5, dz = -(dcell[1] + 0.5);
        cy(B.vc, dx, 0, dz, 0.24, 0.03, COL.metalDark, 12);
        cy(B.vc, dx, 0.03, dz, 0.035, 0.69, COL.metal, 6);
        cy(B.vc, dx, 0.72, dz, 0.42, 0.035, '#d8cdb5', 16);
        bx(B.vc, dx - 0.2, dx + 0.2, 0.755, 0.8, dz - 0.15, dz + 0.13, '#f6dce4');
        bc(B.vc, dx, 0.9, dz - 0.2, 0.4, 0.26, 0.006, '#f6dce4', { rx: -0.3 });
        cy(B.vc, dx + 0.28, 0.755, dz + 0.12, 0.035, 0.09, '#ffffff', 8);
        cy(B.vc, dx - 0.3, 0.755, dz + 0.1, 0.035, 0.09, '#ffffff', 8);
        if (MID) bc(B.vc, dx + 0.1, 0.758, dz + 0.26, 0.12, 0.004, 0.12, '#fbfaf5', { ry: 0.4 });
        api.addCollider({ x0: dx - 0.42, x1: dx + 0.42, z0: dz - 0.42, z1: dz + 0.42, y1: 0.8 }, { layout: true });
        api.blockNavCell(dx, dz);
        blob(dx, dz, 1.0, 1.0);
        const di = new THREE.InstancedMesh(GEO.donut, M.donut, 12);
        const m4 = new THREE.Matrix4(), rd = rngOf(`${office.id}:donuts`);
        const flav = ['#f08fb0', '#6b3e26', '#e7b36a', '#f5f1e6', '#f08fb0', '#6b3e26'].map(c => new THREE.Color(c));
        for (let i = 0; i < 12; i++) {
          const col = i % 4, row = Math.floor(i / 4);
          m4.makeRotationY(rd() * TAU).setPosition(dx - 0.15 + col * 0.1, 0.815, dz - 0.09 + row * 0.085);
          di.setMatrixAt(i, m4); di.setColorAt(i, pickR(flav, rd));
        }
        di.count = donutState.left; di.name = 'ambiente:donuts'; di.computeBoundingSphere();
        root.add(di); S.dynamic.push(di); S.donuts = { mesh: di, x: dx, z: dz };
      }
      // mural de avisos + calendário + relógio na parede oeste
      wallFrame('W', -(b0 + 9));
      bx(B.vc, -0.78, 0.78, 1.02, 1.98, 0, 0.024, COL.woodDark);
      B.decal.add(planeG(1.46, 0.88), { x: 0, y: 1.5, z: 0.026, uv: ATUV.bulletin });
      clocks.push({ x: 0.5 + T2 + 0.03, y: 2.32, z: -(b0 + 9), yaw: HALF, r: 0.19 });
      wallFrame('W', -(b0 + 10.45));
      B.decal.add(planeG(0.34, 0.49), { x: 0, y: 1.42, z: 0.006, uv: ATUV.calendar });
      bc(B.vc, 0, 1.69, 0.01, 0.012, 0.012, 0.02, '#555');
    });

    // ---------------- baias (ilhas de 4) + cadeiras giratórias
    function crt(bxp, y, bz, variant, beige) {
      bx(B.vc, bxp - 0.13, bxp + 0.13, y, y + 0.03, bz - 0.13, bz + 0.1, beige);
      bx(B.vc, bxp - 0.2, bxp + 0.2, y + 0.03, y + 0.37, bz - 0.05, bz + 0.17, beige, { grad: 0.1 });
      bx(B.vc, bxp - 0.15, bxp + 0.15, y + 0.07, y + 0.33, bz - 0.26, bz - 0.05, css(beige, 0.9));
      B.screens.add(planeG(0.31, 0.235), { x: bxp, y: y + 0.205, z: bz + 0.172, uv: SCR[variant % 4], color: '#e9eef0' });
      if (RICH) bx(B.glow, bxp + 0.15, bxp + 0.17, y + 0.05, y + 0.065, bz + 0.17, bz + 0.175, '#57d16b');
    }
    function lcd(bxp, y, bz, variant) {
      bx(B.vc, bxp - 0.11, bxp + 0.11, y, y + 0.015, bz - 0.09, bz + 0.07, COL.black);
      bx(B.vc, bxp - 0.025, bxp + 0.025, y, y + 0.2, bz - 0.04, bz - 0.01, COL.black);
      bx(B.vc, bxp - 0.23, bxp + 0.23, y + 0.12, y + 0.44, bz - 0.01, bz + 0.025, '#2a2c30');
      B.screens.add(planeG(0.43, 0.29), { x: bxp, y: y + 0.28, z: bz + 0.027, uv: SCR[variant % 4], color: '#f2f5f7' });
    }
    function phone(x, y, z, col) {
      bx(B.vc, x - 0.09, x + 0.09, y, y + 0.05, z - 0.1, z + 0.1, col);
      bx(B.vc, x - 0.1, x + 0.02, y + 0.05, y + 0.08, z - 0.08, z + 0.08, css(col, 0.8));
    }
    function papers(x, y, z, r, n) {
      let yy = y;
      for (let i = 0; i < n; i++) { const h = 0.01 + r() * 0.03; bc(B.vc, x + (r() - 0.5) * 0.04, yy + h / 2, z, 0.22, h, 0.3, i % 3 === 2 ? '#f3e7b0' : COL.paper, { ry: (r() - 0.5) * 0.4 }); yy += h; }
    }
    function pencilCup(x, y, z) {
      cy(B.vc, x, y, z, 0.035, 0.1, '#2b2d31', 8);
      for (let i = 0; i < 3; i++) bc(B.vc, x - 0.012 + i * 0.012, y + 0.12, z + (i - 1) * 0.008, 0.008, 0.1, 0.008, ['#f1c40f', '#c0392b', '#2f6fb3'][i], { rz: (i - 1) * 0.2 });
    }
    function chair(x, z, yaw, col, arms) {
      setFrame(x, 0, z, yaw);
      for (let i = 0; i < 5; i++) {
        const a = i * TAU / 5;
        B.vc.add(boxG(0.045, 0.04, 0.32), { x: Math.sin(a) * 0.16, y: 0.04, z: Math.cos(a) * 0.16, ry: a, color: COL.metalDark });
      }
      cy(B.vc, 0, 0.07, 0, 0.028, 0.33, COL.metal, 6);
      bx(B.vc, -0.1, 0.1, 0.38, 0.42, -0.1, 0.1, COL.metalDark);
      bc(B.vc, 0, 0.46, 0.02, 0.48, 0.08, 0.46, col, { grad: 0.3 });
      bc(B.vc, 0, 0.52, -0.21, 0.05, 0.2, 0.04, COL.metalDark);
      bc(B.vc, 0, 0.85, -0.24, 0.44, 0.5, 0.07, col, { rx: -0.1, grad: 0.25 });
      if (arms) for (const s of [-1, 1]) { bc(B.vc, s * 0.27, 0.575, -0.02, 0.03, 0.15, 0.03, COL.metalDark); bc(B.vc, s * 0.27, 0.66, 0.02, 0.05, 0.025, 0.25, COL.black); }
      resetFrame();
      blob(x, z, 0.72, 0.72);
    }
    sec('baias', () => {
      const isl = office.zones.cubicleIslands || [];
      const nDesks = isl.length * 4;
      const jello = nDesks ? hash(`${office.id}:gelatina`) % nDesks : -1, trophy = nDesks ? hash(`${office.id}:trofeu`) % nDesks : -1;
      let di = 0;
      isl.forEach((b, ii) => {
        resetFrame();
        const zc = (b.z0 + b.z1) / 2, capC = COL.trim;
        bx(B.vc, b.x0 + 0.06, b.x1 - 0.06, 0, 1.25, zc - 0.03, zc + 0.03, COL.fabric, { grad: 0.2 });
        bx(B.vc, b.x0 + 0.05, b.x1 - 0.05, 1.25, 1.28, zc - 0.045, zc + 0.045, capC);
        for (const ex of [b.x0 + 0.04, b.x1 - 0.1]) {
          bx(B.vc, ex, ex + 0.06, 0, 1.25, b.z0 + 0.04, b.z1 - 0.04, COL.fabric, { grad: 0.2 });
          bx(B.vc, ex - 0.012, ex + 0.072, 1.25, 1.28, b.z0 + 0.03, b.z1 - 0.03, capC);
        }
        const mx = b.x0 + 2;
        bx(B.vc, mx - 0.03, mx + 0.03, 0, 1.1, b.z0 + 0.04, b.z1 - 0.04, COL.fabric, { grad: 0.2 });
        bx(B.vc, mx - 0.042, mx + 0.042, 1.1, 1.13, b.z0 + 0.03, b.z1 - 0.03, capC);
        blob((b.x0 + b.x1) / 2, zc, b.x1 - b.x0 + 0.4, b.z1 - b.z0 + 0.4);
        for (const yaw of [0, Math.PI]) for (let k = 0; k < 2; k++) {
          const xm = b.x0 + 2 * k + 1;
          setFrame(xm, 0, zc, yaw);
          const sgn = yaw === 0 ? 1 : -1, cl = 0.5 * sgn;
          const r = rngOf(`${office.id}:baia:${ii}:${k}:${yaw}`);
          bx(B.vc, -0.93, 0.93, 0.72, 0.75, 0.03, 0.95, COL.deskTop);
          bx(B.vc, -0.93, 0.93, 0.7, 0.72, 0.92, 0.95, COL.deskEdge);
          const px = -sgn * 0.62;
          bx(B.vc, px - 0.2, px + 0.2, 0, 0.68, 0.3, 0.86, '#8e9195', { grad: 0.15 });
          for (const y of [0.22, 0.44, 0.62]) bx(B.vc, px - 0.07, px + 0.07, y - 0.05, y - 0.03, 0.86, 0.875, '#b9bcc0');
          const isCrt = r() < 0.78;
          if (isCrt) { crt(cl, 0.75, 0.33, Math.floor(r() * 4), r() < 0.5 ? COL.beige : COL.beige2); bx(B.vc, sgn * 0.66, sgn * 0.86, 0, 0.42, 0.22, 0.68, COL.beige, { grad: 0.12 }); }
          else lcd(cl, 0.75, 0.3, Math.floor(r() * 4));
          bx(B.vc, cl - 0.21, cl + 0.21, 0.75, 0.77, 0.64, 0.79, '#d6d0be');
          bx(B.vc, cl + 0.28, cl + 0.34, 0.75, 0.772, 0.68, 0.77, '#d6d0be');
          if (MID) {
            const ox = -sgn * 0.45;
            if (r() < 0.8) papers(ox, 0.75, 0.55, r, 1 + Math.floor(r() * 3));
            if (r() < 0.7) { const mcol = pickR(['#f5f1e6', '#c0392b', '#2f6fb3', '#d9a441', '#1f3a5f'], r); cy(B.vc, ox + sgn * 0.2, 0.75, 0.8, 0.04, 0.1, mcol, 6); }
            if (r() < 0.6) phone(-sgn * 0.78, 0.75, 0.35, '#2d3036');
            if (RICH && r() < 0.5) bc(B.vc, cl - sgn * 0.3, 0.83, 0.2, 0.12, 0.15, 0.015, COL.woodDark, { rx: -0.25 });
            if (RICH && r() < 0.4) pencilCup(cl + sgn * 0.42, 0.75, 0.2);
            if (r() < 0.8) {                     // papéis presos na divisória
              const n = 1 + Math.floor(r() * 3);
              for (let i = 0; i < n; i++) B.vc.add(planeG(0.2, 0.26), { x: -0.7 + r() * 1.4, y: 0.98 + r() * 0.14, z: 0.036, rz: (r() - 0.5) * 0.2, color: pickR([COL.paper, '#fff27a', '#d6ecfb', '#fbd3e0'], r) });
            }
            if (di === jello) { bc(B.glass, cl - sgn * 0.42, 0.8, 0.72, 0.2, 0.1, 0.1, '#f2d33b'); bc(B.vc, cl - sgn * 0.42, 0.79, 0.72, 0.14, 0.04, 0.04, '#2b2d31'); }
            if (di === trophy) { cy(B.vc, -sgn * 0.5, 0.75, 0.25, 0.05, 0.04, COL.woodDark, 8); cy(B.vc, -sgn * 0.5, 0.79, 0.25, 0.015, 0.1, '#d4af37', 6); B.vc.add(new THREE.SphereGeometry(0.03, 6, 4), { x: -sgn * 0.5, y: 0.92, z: 0.25, color: '#d4af37' }); }
          }
          di++;
        }
      });
      resetFrame();
      const chairCols = ['#33363c', '#2f3441', '#3b3534', '#33363c'];
      const rc = rngOf(`${office.id}:cadeiras`);
      for (const c of office.zones.cubicles || []) chair(c.x, c.z, c.yaw, pickR(chairCols, rc), RICH);
      const rec = (office.zones.reception || []).find(p => p.kind === 'recepcionista');
      if (rec) chair(rec.x, rec.z, rec.yaw, '#1f2f4f', true);
      S.stats.desks = nDesks;
    });

    // ---------------- copiadora (luz verde + folhas saindo quando copia)
    sec('copiadora', () => {
      const xb = furn('X')[0];
      S.copier = null;
      if (!xb) return;
      const xc = (xb.x0 + xb.x1) / 2, zc = (xb.z0 + xb.z1) / 2, yaw = -HALF;
      setFrame(xc, 0, zc, yaw);
      bx(B.vc, -0.42, 0.42, 0, 0.08, -0.36, 0.36, '#4a4d52');
      bx(B.vc, -0.4, 0.4, 0.08, 0.6, -0.35, 0.35, '#d9d7d0', { grad: 0.14 });
      for (const y of [0.24, 0.41, 0.58]) {
        bx(B.vc, -0.38, 0.38, y - 0.006, y + 0.004, 0.35, 0.356, '#9a9892');
        bx(B.vc, -0.12, 0.12, y - 0.06, y - 0.04, 0.35, 0.37, '#6b6e73');
      }
      bx(B.vc, -0.42, 0.42, 0.6, 0.96, -0.37, 0.37, '#e6e4de', { grad: 0.08 });
      bx(B.vc, -0.42, 0.42, 0.96, 1.04, -0.36, 0.3, '#cfcdc6');
      bx(B.vc, -0.43, 0.43, 1.04, 1.085, -0.37, 0.31, '#5d6167');
      bc(B.vc, 0.14, 1.02, 0.34, 0.42, 0.05, 0.16, '#6a6f76', { rx: 0.35 });
      B.glow.add(planeG(0.13, 0.06), { x: 0.04, y: 1.048, z: 0.349, rx: -HALF + 0.35, color: '#9fd8b0' });
      for (let i = 0; i < 4; i++) bc(B.vc, 0.2 + i * 0.045, 1.046, 0.35, 0.03, 0.012, 0.03, i === 3 ? '#27ae60' : '#dcdcdc', { rx: 0.35 });
      bc(B.vc, 0.52, 0.7, 0, 0.2, 0.02, 0.3, '#bfbdb6', { rz: -0.12 });
      bc(B.vc, 0.52, 0.72, 0, 0.19, 0.012, 0.27, COL.paper, { rz: -0.12 });
      bx(B.vc, -0.35, 0.1, 1.085, 1.2, -0.3, 0.25, '#d2d0c9');
      resetFrame();
      blob(xc, zc, 1.2, 1.1);
      // partes dinâmicas: LED e a folha que sai (grupo com a pose da copiadora)
      const grp = new THREE.Group(); grp.position.set(xc, 0, zc); grp.rotation.y = yaw; grp.name = 'ambiente:copiadora';
      const led = new THREE.Mesh(GEO.led, M.led); led.position.set(0.33, 1.06, 0.36); led.rotation.x = 0.35; grp.add(led);
      const sheet = new THREE.Mesh(GEO.sheet, M.paper); sheet.position.set(0.45, 0.74, 0); sheet.rotation.z = -0.12; sheet.visible = false; grp.add(sheet);
      root.add(grp);
      S.copier = { x: xc, z: zc, led, sheet, front: { x: xc - 0.95, z: zc } };
    });

    // ---------------- plantas de vaso
    sec('plantas', () => {
      for (const p of furn('P')) {
        const x = (p.x0 + p.x1) / 2, z = (p.z0 + p.z1) / 2, r = rngOf(`${office.id}:planta:${x}:${z}`);
        resetFrame();
        const pot = pickR(['#b45f3c', '#e8e4da', '#3f4a55', '#c9b28a'], r);
        cy(B.vc, x, 0, z, 0.22, 0.4, pot, 10, { rb: 0.17, grad: 0.2 });
        cy(B.vc, x, 0.38, z, 0.235, 0.05, css(pot, 0.88), 10);
        cy(B.vc, x, 0.4, z, 0.2, 0.012, '#4a3526', 10);
        const type = Math.floor(r() * 3);
        if (type === 0) {
          cy(B.vc, x, 0.4, z, 0.025, 0.55, '#6f4d31', 5);
          for (let i = 0; i < (MID ? 7 : 4); i++) {
            const a = r() * TAU, d = 0.05 + r() * 0.15;
            B.vc.add(new THREE.SphereGeometry(0.17 + r() * 0.1, 7, 5), { x: x + Math.sin(a) * d, y: 0.85 + r() * 0.45, z: z + Math.cos(a) * d, sy: 0.8, color: pickR([COL.leaf, COL.leaf2, COL.leaf3], r) });
          }
        } else if (type === 1) {
          for (let i = 0; i < (MID ? 11 : 6); i++) {
            const a = r() * TAU, h = 0.45 + r() * 0.5, tilt = 0.08 + r() * 0.22;
            B.vc.add(boxG(0.07, h, 0.02), { x: x + Math.sin(a) * 0.06, y: 0.4 + h / 2 * Math.cos(tilt), z: z + Math.cos(a) * 0.06, ry: a, rx: tilt, order: 'YXZ', color: pickR([COL.leaf2, '#2f5e36', '#58804a'], r) });
          }
        } else {
          cy(B.vc, x, 0.4, z, 0.03, 0.5, '#7a8a4a', 5);
          for (let i = 0; i < (MID ? 9 : 5); i++) {
            const a = i / (MID ? 9 : 5) * TAU + r() * 0.4, tilt = 0.9 + r() * 0.5;
            B.vc.add(new THREE.ConeGeometry(0.1, 0.62, 4), { x: x + Math.sin(a) * 0.2, y: 0.95 + r() * 0.15, z: z + Math.cos(a) * 0.2, ry: a, rx: tilt, order: 'YXZ', sx: 1.6, sz: 0.25, color: pickR([COL.leaf, COL.leaf3, '#77ad5a'], r) });
          }
        }
        blob(x, z, 0.75, 0.75);
      }
    });

    // ---------------- banheiros no fim dos corredores laterais
    sec('banheiros', () => {
      furn('B').forEach((b, i) => {
        resetFrame();
        const female = b.x0 > W / 2;
        bx(B.vc, b.x0, b.x1, 0, CEIL_H, b.z0, b.z1, '#ddd4bf');
        bx(B.vc, b.x0 - 0.01, b.x1 + 0.01, 0, 0.09, b.z0 - 0.01, b.z1 + 0.01, COL.baseboard);
        bx(B.vc, b.x0 + 0.06, b.x1 - 0.06, 0, 2.06, b.z1, b.z1 + 0.02, '#c9c4b8');
        bx(B.vc, b.x0 + 0.1, b.x1 - 0.1, 0, 2.02, b.z1 + 0.02, b.z1 + 0.045, '#7d8fa3', { grad: 0.1 });
        bx(B.vc, b.x0 + 0.1, b.x1 - 0.1, 0, 0.22, b.z1 + 0.045, b.z1 + 0.05, COL.metal);
        const hx = female ? b.x0 + 0.2 : b.x1 - 0.2;
        bx(B.vc, hx - 0.03, hx + 0.03, 1.0, 1.04, b.z1 + 0.045, b.z1 + 0.09, COL.metal);
        B.decal.add(planeG(0.2, 0.2), { x: (b.x0 + b.x1) / 2, y: 1.55, z: b.z1 + 0.047, uv: female ? ATUV.wcF : ATUV.wcM, world: true });
        void i;
      });
    });

    // ---------------- extintores (+ placa)
    function extinguisher(side, along) {
      wallFrame(side, along);
      bx(B.vc, -0.05, 0.05, 0.74, 0.8, 0, 0.07, COL.metalDark);
      cy(B.vc, 0, 0.3, 0.1, 0.075, 0.48, '#c0281f', 10, { grad: 0.2 });
      B.vc.add(new THREE.SphereGeometry(0.075, 10, 4, 0, TAU, 0, HALF), { x: 0, y: 0.78, z: 0.1, color: '#c0281f' });
      cy(B.vc, 0, 0.84, 0.1, 0.022, 0.06, COL.black, 6);
      bx(B.vc, -0.01, 0.07, 0.9, 0.915, 0.08, 0.12, COL.black);
      bx(B.vc, 0.06, 0.075, 0.4, 0.88, 0.16, 0.175, COL.black);
      B.decal.add(planeG(0.22, 0.15), { x: 0, y: 1.32, z: 0.006, uv: ATUV.ext });
    }
    sec('extintores', () => {
      if (chAt(W - 2, b1 - 3) === '.') extinguisher('E', -(b1 - 2.5));
      if (chAt(1, lay.band0 + 1) === '.') extinguisher('W', -(lay.band0 + 1.5));
    });

    // ---------------- lá fora: estacionamento, carros, árvores, postes (visto pela porta de vidro)
    function car(x, z, yaw, col) {
      setFrame(x, 0, z, yaw);
      bx(B.out, -0.86, 0.86, 0.22, 0.74, -2.05, 2.05, col, { grad: 0.3 });
      bx(B.out, -0.76, 0.76, 0.74, 1.17, -0.95, 0.9, '#2e3b4a');
      bx(B.out, -0.78, 0.78, 1.17, 1.22, -0.85, 0.8, col);
      bx(B.out, -0.88, 0.88, 0.2, 0.36, 2.0, 2.1, '#3a3d42');
      bx(B.out, -0.88, 0.88, 0.2, 0.36, -2.1, -2.0, '#3a3d42');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.out.add(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 6), { x: sx * 0.8, y: 0.3, z: sz * 1.35, rz: HALF, color: '#1c1d20' });
      for (const sx of [-1, 1]) { bx(B.outGlow, sx * 0.62 - 0.14, sx * 0.62 + 0.14, 0.5, 0.6, 2.05, 2.06, '#fff4d6'); bx(B.outGlow, sx * 0.66 - 0.12, sx * 0.66 + 0.12, 0.52, 0.6, -2.06, -2.05, '#b3261e'); }
      resetFrame();
      blob(x, z, 2.1, 4.5, yaw);
    }
    sec('fora', () => {
      resetFrame();
      const X0 = -14, X1 = W + 14;
      B.out.add(planeG(X1 - X0, 26), { x: (X0 + X1) / 2, y: -0.012, z: 4 + 13, rx: -HALF, color: '#4d5054', world: true });
      bx(B.out, X0, X1, -0.03, 0.12, 3.8, 4.0, '#cfcbc0');
      B.out.add(planeG(X1 - X0, 40), { x: (X0 + X1) / 2, y: -0.01, z: 30 + 20, rx: -HALF, color: '#6f8f55', world: true });
      const rows = [6.8, 18.2];
      for (const zr of rows) for (let x = X0 + 1; x < X1 - 1; x += 2.6) B.out.add(planeG(0.1, 4.6), { x, y: -0.006, z: zr, rx: -HALF, color: '#e8e6dc', world: true });
      const r = rngOf(`${office.id}:carros`);
      const cols = ['#8b1e2d', '#2d4f7a', '#c9c3b5', '#3d3f42', '#5a6e4e', '#d9d4c7', '#7a5a2e', '#9aa5ad'];
      let nCars = 0;
      const maxCars = RICH ? 10 : MID ? 7 : 4;
      for (const [ri, zr] of rows.entries()) for (let x = X0 + 1; x < X1 - 3; x += 2.6) {
        if (nCars >= maxCars || r() > 0.42) continue;
        if (ri === 0 && Math.abs(x + 1.3 - (cx + 0.5)) < 2.6) continue;     // deixa a frente da porta livre
        car(x + 1.3, zr, ri === 0 ? Math.PI : 0, pickR(cols, r)); nCars++;
      }
      if (MID) for (let x = X0 + 3; x < X1; x += 7 + r() * 3) {
        resetFrame();
        const z = 24 + r() * 3;
        cy(B.out, x, 0, z, 0.12, 1.4, '#6f4d31', 6);
        B.out.add(new THREE.SphereGeometry(1.1, 7, 5), { x, y: 2.1, z, color: pickR([COL.leaf, COL.leaf2, '#5f8f4a'], r) });
        B.out.add(new THREE.SphereGeometry(0.8, 7, 5), { x: x + 0.4, y: 2.8, z: z - 0.2, color: COL.leaf3 });
      }
      for (const x of [cx - 9, cx + 10]) { resetFrame(); cy(B.out, x, 0, 12.4, 0.07, 5.2, '#5a5e63', 6); bx(B.out, x - 0.05, x + 0.9, 5.1, 5.2, 12.35, 12.45, '#5a5e63'); bx(B.outGlow, x + 0.5, x + 0.95, 5.02, 5.1, 12.3, 12.5, '#fff1c4'); }
    });

    // ---------------- relógios (mostrador no atlas + ponteiros instanciados)
    sec('relogios', () => {
      for (const c of clocks) {
        setFrame(c.x, 0, c.z, c.yaw);
        B.vc.add(new THREE.CylinderGeometry(c.r, c.r, 0.045, 18), { x: 0, y: c.y, z: 0.0, rx: HALF, color: '#1d1f22' });
        B.decal.add(new THREE.CircleGeometry(c.r - 0.02, 20), { x: 0, y: c.y, z: 0.026, uv: ATUV.clock });
      }
      resetFrame();
      S.clocks = clocks;
      if (clocks.length) {
        const hm = new THREE.InstancedMesh(GEO.hand, M.hands, clocks.length * 3);
        const cols = [new THREE.Color('#1d1f22'), new THREE.Color('#1d1f22'), new THREE.Color('#c0392b')];
        for (let i = 0; i < clocks.length * 3; i++) hm.setColorAt(i, cols[i % 3]);
        hm.frustumCulled = false; hm.name = 'ambiente:ponteiros';
        root.add(hm); S.dynamic.push(hm); S.hands = hm;
        updateClocks(true);
      } else S.hands = null;
    });

    // ---------------- bolhas do galão (instanciadas, escondidas até borbulhar)
    sec('bolhas', () => {
      S.bubbles = null;
      if (!S.cooler) return;
      const bm = new THREE.InstancedMesh(GEO.bubble, M.bubble, 7);
      bm.count = 0; bm.frustumCulled = false; bm.renderOrder = 3; bm.name = 'ambiente:bolhas';
      root.add(bm); S.dynamic.push(bm); S.bubbles = bm;
    });

    // ---------------- monta as malhas
    const order = [
      ['vc', M.vc], ['glow', M.glow], ['floor', M.floor], ['lino', M.lino], ['ceil', M.ceil], ['blinds', M.blinds],
      ['view', M.view], ['screens', M.screens], ['decal', M.decal], ['decalGlow', M.decalGlow], ['sign', M.sign],
      ['glass', M.glass], ['vinyl', M.vinyl], ['blob', M.blob], ['sun', M.sun], ['out', M.out], ['outGlow', M.glow],
    ];
    let tris = 0;
    for (const [k, mat] of order) {
      tris += B[k].tris;
      const mesh = B[k].build(mat, k, root);
      // o forro não grava profundidade (rótulos que passam de 2,7 m continuam visíveis); por isso o que fica lá
      // fora e é mais alto que o forro (postes, árvores) é desenhado ANTES dele, e o forro pinta por cima
      if (k === 'ceil' && mesh) mesh.renderOrder = -1;
      if ((k === 'out' || k === 'outGlow') && mesh) mesh.renderOrder = -2;
      if (k === 'glass' && mesh) mesh.renderOrder = 2;
      if (k === 'sun') S.sunMesh = mesh;
    }
    S.stats.tris = Math.round(tris + S.lampList.length * 2);
    resetFrame();

    // ---------------- interações (layout:true → somem no próximo rebuild)
    addInteractions();
  }

  // ============================================================ interações
  const COFFEE = ['☕ Café requentado das 7h. Encorpado. Muito encorpado.', '☕ Você toma um café e finge que é o primeiro do dia.', '☕ Acabou o açúcar. De novo.', '☕ O café está surpreendentemente bom hoje. Suspeito.'];
  const WATER = ['💧 Glub glub. Hidratado e pronto para mais uma reunião.', '💧 Você observa as bolhas. É o ponto alto da tarde.', '💧 Água gelada. O copinho é minúsculo, como sempre.'];
  const FRIDGE = ['🧊 Um iogurte com um bilhete: "NÃO É SEU."', '🧊 Três marmitas sem nome e um pote misterioso do mês passado.', '🧊 Alguém trouxe bolo! Tem um aviso: "para a reunião das 15h".', '🧊 Só ketchup, mostarda e esperança.'];
  const DONUT = ['🍩 Donut de chocolate. Ninguém viu.', '🍩 Glaceado com granulado. A dieta começa segunda.', '🍩 Você pega um donut e já pensa no segundo.'];

  function addInteractions() {
    const office = api.office, lay = S.lay, b0 = lay.b0;
    const coffeeZ = -(b0 + 1.5);
    api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: 2.35, z: coffeeZ }, radius: 1.3, label: 'Cafeteira', info: 'Café passado hoje cedo. Bem cedo.',
      actionLabel: 'tomar um café', onInteract: () => { ensureAudio(); sndGurgle(); api.player.emote('drink', 3); api.toast(pickR(COFFEE, Math.random), 3200); } });
    if (S.cooler) {
      api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: S.cooler.x + 0.9, z: S.cooler.z }, radius: 1.3, label: 'Bebedouro', info: 'Galão de 20 L · copinhos de 50 mL',
        actionLabel: 'beber água', onInteract: () => { ensureAudio(); startBubbles(true); api.player.emote('drink', 2.4); api.toast(pickR(WATER, Math.random), 3000); } });
    }
    const fr = office.furniture.find(f => f.kind === 'F');
    if (fr) {
      api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: 2.4, z: (fr.z0 + fr.z1) / 2 }, radius: 1.2, label: 'Geladeira', info: 'Tem um bilhete: "etiquete sua marmita"',
        actionLabel: 'abrir a geladeira', onInteract: () => { ensureAudio(); sndThunk(); api.toast(pickR(FRIDGE, Math.random), 3400); } });
    }
    if (S.donuts) {
      api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: S.donuts.x, z: S.donuts.z }, radius: 1.35,
        label: () => `Donuts — ${donutState.left} de 12`, info: () => (donutState.left ? 'Cortesia do Comitê de Festas' : 'Só sobrou o granulado na caixa'),
        actionLabel: () => (donutState.left ? 'pegar um donut' : 'olhar a caixa vazia'), onInteract: eatDonut });
    }
    if (S.copier) {
      api.addInteractable({ layout: true, owner: 'ambiente', pos: S.copier.front, radius: 1.3, label: 'Copiadora',
        info: () => (copier.jam > 0 ? 'PAPEL ATOLADO — bandeja 2' : copier.busy ? `copiando… (${copier.pages} ${copier.pages === 1 ? 'folha' : 'folhas'})` : 'Pronta. Luz verde, humor instável.'),
        actionLabel: 'tirar cópia', onInteract: () => { ensureAudio(); if (copier.jam > 0) api.toast('🖨️ Atolou. Alguém abre a tampa lateral, ninguém sabe fechar.', 3200); else if (copier.busy) api.toast('🖨️ A copiadora já está ocupada.', 2200); else { startCopy(true); api.toast('🖨️ Copiando… frente e verso, por milagre.', 2600); } },
        actions: [{ key: 'KeyV', label: 'dar um tapinha', onInteract: () => { ensureAudio(); slapCopier(); } }] });
    }
    const cx = lay.cx;
    api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: cx + 4, z: -3.45 }, radius: 1.15, label: 'Campainha da recepção', info: 'Toque uma vez. UMA vez.',
      actionLabel: 'tocar a campainha', onInteract: () => { ensureAudio(); sndDing(cx + 4, -4.18); api.toast('🛎️ Ding! Já vai — a recepcionista está numa ligação.', 2600); } });
    api.addInteractable({ layout: true, owner: 'ambiente', pos: { x: 1.45, z: -(b0 + 9) }, radius: 1.5, label: 'Mural de avisos', info: 'Pizza, iogurtes desaparecidos e o placar de acidentes',
      actionLabel: 'ler os avisos', onInteract: openMural });
  }

  function eatDonut() {
    ensureAudio();
    if (!donutState.left) { api.toast('🍩 Acabaram os donuts. Alguém sempre pega dois.', 2800); return; }
    donutState.left--;
    lsSet(LS_DONUT, JSON.stringify(donutState));
    if (S.donuts) S.donuts.mesh.count = donutState.left;
    api.player.emote('drink', 2);
    sndChomp();
    api.toast(pickR(DONUT, Math.random), 2600);
  }

  function openMural() {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    const first = new Date(y, m, 1).getDay(), nd = new Date(y, m + 1, 0).getDate();
    let cells = '', row = '';
    for (let i = 0; i < first; i++) row += '<td></td>';
    for (let day = 1; day <= nd; day++) {
      const col = (first + day - 1) % 7;
      row += `<td class="${col === 0 ? 'amb-dom' : ''}${day === d.getDate() ? ' amb-hoje' : ''}">${day}</td>`;
      if (col === 6) { cells += `<tr>${row}</tr>`; row = ''; }
    }
    if (row) cells += `<tr>${row}</tr>`;
    const days = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((x, i) => `<th class="${i === 0 ? 'amb-dom' : ''}">${x}</th>`).join('');
    const esc = api.util.esc;
    api.openPanel({
      title: '📌 Mural de avisos', meta: `${api.office.name} · copa`, width: 'min(760px, calc(100vw - 32px))',
      html: `<div class="amb-mural">
        <div class="amb-n" style="--r:-1.2deg;--pin:#c0392b"><h3 style="--h:#b8342a">AVISO</h3><p>Quem pegou meu iogurte da geladeira, por favor devolva. Tinha NOME.</p></div>
        <div class="amb-n" style="--r:1deg;--bg:#fff27a;--pin:#2f6fb3"><h3 style="--h:#9a3412">🍕 Festa da pizza!</h3><p>Sexta, 16h, na copa. Traga R$ 10. Sim, de novo tem só muçarela.</p></div>
        <div class="amb-n" style="--r:-.6deg;--pin:#2e8b57"><h3 style="--h:#1e6b3a">Dias sem acidentes</h3><div class="amb-big">0</div><p style="text-align:center">(alguém tropeçou no fio da copiadora)</p></div>
        <div class="amb-n" style="--r:.8deg;--bg:#d6ecfb;--pin:#d9a441"><h3>Comitê de Festas</h3><p>Reunião quinta na sala de reunião. Pauta: festa do sorvete (de novo).</p></div>
        <div class="amb-n" style="--r:-1deg;--bg:#e3f5d8;--pin:#8e44ad"><h3 style="--h:#2d5a1e">Vende-se</h3><p>Bicicleta ergométrica. Pouco uso. Hoje serve de cabide. Ramal 2341.</p></div>
        <div class="amb-n" style="--r:1.3deg;--bg:#fff5a8;--pin:#16a085"><h3 style="--h:#b8342a">Copa</h3><p>LAVE SUA CANECA!!! Isso vale pra VOCÊ. Donuts de hoje: ${donutState.left} de 12.</p></div>
        <div class="amb-n" style="--r:-.4deg;--bg:#fbfaf5;--pin:#555"><h3 style="--h:#b8342a">${MES[m]} ${y}</h3><table class="amb-cal"><tr>${days}</tr>${cells}</table></div>
      </div>`,
    });
  }

  // ============================================================ animação (por frame, barato)
  const _hm = new THREE.Matrix4(), _hb = new THREE.Matrix4(), _hr = new THREE.Matrix4(), _ht = new THREE.Matrix4(), _hs = new THREE.Matrix4();
  let clockAcc = 0;
  function updateClocks(force) {
    if (!S.hands || !S.clocks.length) return;
    const now = new Date();
    const s = now.getSeconds(), m = now.getMinutes() + s / 60, h = (now.getHours() % 12) + m / 60;
    const spec = [[h / 12 * TAU, 0.018, 0.1, 0.008, 0.032], [m / 60 * TAU, 0.012, 0.145, 0.009, 0.038], [s / 60 * TAU, 0.006, 0.155, 0.006, 0.044]];
    S.clocks.forEach((c, i) => {
      _hb.makeRotationY(c.yaw); _hb.setPosition(c.x, c.y, c.z);
      spec.forEach(([ang, w, len, t, dz], j) => {
        _hr.makeRotationZ(-ang);
        _ht.makeTranslation(0, len / 2 - 0.02, dz);
        _hs.makeScale(w, len, t);
        _hm.copy(_hb).multiply(_hr).multiply(_ht).multiply(_hs);
        S.hands.setMatrixAt(i * 3 + j, _hm);
      });
    });
    S.hands.instanceMatrix.needsUpdate = true;
    void force;
  }

  const _fc = new THREE.Color();
  function updateFlicker(dt) {
    if (!S.lamps || !S.flicker.length) return;
    let dirty = false;
    for (const f of S.flicker) {
      let level = 1;
      if (f.mode === 'forte') {
        f.next -= dt;
        if (f.next <= 0 && f.t <= 0) { f.t = 0.25 + Math.random() * 1.1; f.next = 5 + Math.random() * 14; }
        if (f.t > 0) {
          f.t -= dt;
          if (Math.random() < 0.35) f.on = !f.on;
          level = f.on ? 1 : 0.35;
          if (!f.on && Math.random() < 0.3) sndCrackle(f.x, f.z);
          if (f.t <= 0) f.on = true;
        }
      } else {
        f.t += dt;
        level = 0.9 + 0.1 * Math.sin(f.t * 37) * Math.sin(f.t * 3.1);
      }
      if (Math.abs(level - f.level) > 0.02) {
        f.level = level;
        _fc.setRGB(level, level, level * (level < 0.6 ? 0.92 : 1));
        S.lamps.setColorAt(f.i, _fc); dirty = true;
      }
    }
    if (dirty && S.lamps.instanceColor) S.lamps.instanceColor.needsUpdate = true;
  }

  function startBubbles(big = false) {
    if (!S.bubbles) return;
    bubbleState.active = true; bubbleState.t = 0;
    const n = big ? 7 : 3 + Math.floor(Math.random() * 3);
    bubbleState.seeds = Array.from({ length: n }, (_, i) => ({ d: i * (big ? 0.12 : 0.22) + Math.random() * 0.1, x: (Math.random() - 0.5) * 0.12, z: (Math.random() - 0.5) * 0.12, s: 0.6 + Math.random() * 0.8 }));
    S.bubbles.count = n;
    const c = S.cooler;
    if (c && distPlayer(c.x, c.z) < 7) sndGlug(c.x, c.z, big ? 3 : 2);
  }
  function updateBubbles(dt) {
    if (!S.bubbles || !S.cooler) return;
    if (!bubbleState.active) { bubbleState.next -= dt; if (bubbleState.next <= 0) { bubbleState.next = 9 + Math.random() * 16; startBubbles(false); } return; }
    bubbleState.t += dt;
    const c = S.cooler; let alive = 0;
    bubbleState.seeds.forEach((b, i) => {
      const k = bubbleState.t - b.d;
      const y = c.y0 + Math.max(0, k) * 0.42;
      const vis = k >= 0 && y < c.y1;
      if (vis) alive++;
      const sc = vis ? b.s : 0.0001;
      _hm.makeScale(sc, sc, sc).setPosition(c.x + b.x + Math.sin(k * 9 + i) * 0.01, y, c.z + b.z);
      S.bubbles.setMatrixAt(i, _hm);
    });
    S.bubbles.instanceMatrix.needsUpdate = true;
    if (!alive && bubbleState.t > 0.5) { bubbleState.active = false; S.bubbles.count = 0; }
  }

  function startCopy(byPlayer) {
    if (!S.copier || copier.busy || copier.jam > 0) return;
    copier.busy = true; copier.t = 0; copier.dur = byPlayer ? 5.5 : 4 + Math.random() * 5; copier.pages = 0;
    if (A.ctx && !A.muted) sndCopier(copier.dur);
  }
  function slapCopier() {
    if (!S.copier) return;
    sndSlap();
    if (copier.busy || Math.random() < 0.55) {
      copier.busy = false; copier.jam = 4.5;
      if (S.copier) S.copier.sheet.visible = false;
      api.toast('🖨️ PAPEL ATOLADO NA BANDEJA 2. Parabéns.', 3200);
    } else api.toast('🖨️ A copiadora faz um barulho estranho… mas funciona. Por enquanto.', 2800);
    api.player.emote('point', 1.2);
  }
  const WHITE = new THREE.Color('#ffffff');
  const LED_GREEN = new THREE.Color('#39d353'), LED_DIM = new THREE.Color('#1c5a2a'), LED_RED = new THREE.Color('#ff3b30'), LED_OFF = new THREE.Color('#5a1410');
  function updateCopier(dt, t) {
    if (!S.copier) return;
    const now = performance.now() / 1000;
    if (!copier.busy && copier.jam <= 0 && now >= copier.nextAuto) { copier.nextAuto = now + 150 + Math.random() * 260; startCopy(false); }
    const { led, sheet } = S.copier;
    if (copier.jam > 0) {
      copier.jam -= dt;
      M.led.color.copy(Math.floor(t * 4) % 2 ? LED_RED : LED_OFF);
      if (copier.jam <= 0) M.led.color.copy(LED_GREEN);
      return;
    }
    if (copier.busy) {
      copier.t += dt;
      M.led.color.copy(Math.floor(t * 3) % 2 ? LED_GREEN : LED_DIM);
      const k = (copier.t % 1.1) / 1.1;
      sheet.visible = copier.t > 0.4 && k < 0.85;
      sheet.position.set(0.3 + k * 0.28, 0.74 + k * 0.01, 0);
      copier.pages = Math.floor(copier.t / 1.1);
      if (copier.t >= copier.dur) { copier.busy = false; sheet.visible = false; M.led.color.copy(LED_GREEN); }
    }
    void led;
  }

  // ---- hora do dia: vista das janelas, luz do sol no chão, céu lá fora, tom da direcional (leve)
  let lastSkyKey = null, dirLight = null, dirBase = null, skyAcc = 0;
  const _sky = new THREE.Color();
  function applyTime(force = false) {
    const h = hourNow(), s = skyAt(h), key = Math.round(h * 6);
    if (force || key !== lastSkyKey) {
      lastSkyKey = key;
      drawView(viewCanvas, s); tex.view.needsUpdate = true;
    }
    M.sun.color.copy(s.sun); M.sun.opacity = 0.22 * s.light;
    if (S.sunMesh) S.sunMesh.visible = s.light > 0.04;
    M.view.color.setScalar(0.85 + 0.15 * s.light);
    M.out.color.set('#34405e').lerp(WHITE, clamp01(s.light * 1.15));
    api.setSky(_sky.copy(s.hor).lerp(s.top, 0.3));
    if (!dirLight) {
      dirLight = api.lights?.sun || null;
      if (dirLight) dirBase = { color: dirLight.color.clone(), intensity: dirLight.intensity };
    }
    if (dirLight && dirBase) {
      dirLight.color.copy(dirBase.color).lerp(s.sun, 0.3);
      dirLight.intensity = dirBase.intensity * (0.8 + 0.2 * s.light);
    }
  }

  // ---- letreiro/atlas: redesenha quando o nome ou o dia muda
  function refreshTexts() {
    const name = api.office.name || 'Escritório';
    const day = new Date().toDateString();
    if (name !== S.name) {
      S.name = name;
      drawSign(signCanvas, name); tex.sign.needsUpdate = true;
      drawVinyl(vinylCanvas, name); tex.vinyl.needsUpdate = true;
      S.atlasDay = '';
    }
    if (day !== S.atlasDay) { S.atlasDay = day; drawAtlas(atlasCanvas, name, new Date()); tex.atlas.needsUpdate = true; }
  }

  // ============================================================ som ambiente (Web Audio sintetizado, volume baixo)
  const A = { ctx: null, master: null, noise: null, humG: null, buzzG: null, muted: lsGet(LS_MUTE) === '1', vol: 0.35, nextType: 0, nextPhone: 0, acc: 0, copierOut: null };
  { const v = +lsGet(LS_VOL); if (lsGet(LS_VOL) !== null && Number.isFinite(v)) A.vol = Math.max(0, Math.min(1, v / 100)); }
  const clampPan = v => Math.max(-1, Math.min(1, v));
  const distPlayer = (x, z) => Math.hypot(x - api.player.x, z - api.player.z);

  function ensureAudio() {
    if (A.muted) return false;
    if (!A.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { A.ctx = new AC(); } catch { return false; }
      const c = A.ctx;
      A.master = c.createGain(); A.master.gain.value = A.vol * 0.6; A.master.connect(c.destination);
      const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      A.noise = buf;
      // zumbido das fluorescentes: 120 Hz (rede de 60 Hz, bem americano) + harmônico
      const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 120;
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 240;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.7;
      const g2 = c.createGain(); g2.gain.value = 0.4;
      A.humG = c.createGain(); A.humG.gain.value = 0.010;
      o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(A.humG); A.humG.connect(A.master);
      // ar-condicionado: ruído grave contínuo
      const n = c.createBufferSource(); n.buffer = A.noise; n.loop = true;
      const nl = c.createBiquadFilter(); nl.type = 'lowpass'; nl.frequency.value = 360;
      const ng = c.createGain(); ng.gain.value = 0.045;
      n.connect(nl); nl.connect(ng); ng.connect(A.master);
      // zumbido agudo perto da lâmpada que pisca (ganho pela distância)
      const o3 = c.createOscillator(); o3.type = 'square'; o3.frequency.value = 120;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 4;
      A.buzzG = c.createGain(); A.buzzG.gain.value = 0;
      o3.connect(bp); bp.connect(A.buzzG); A.buzzG.connect(A.master);
      o1.start(); o2.start(); o3.start(); n.start();
      A.nextType = c.currentTime + 2; A.nextPhone = c.currentTime + 70 + Math.random() * 120;
    }
    if (A.ctx.state === 'suspended' && !document.hidden) A.ctx.resume().catch(() => {});
    return true;
  }
  const live = () => A.ctx && !A.muted && A.ctx.state === 'running';
  // saída posicional simples: ganho pela distância ao jogador, pan pela direita da câmera
  function outAt(x, z, ref, gain, dur) {
    const c = A.ctx, cam = api.camera, e = cam.matrixWorld.elements;
    const dx = x - cam.position.x, dz = z - cam.position.z, len = Math.hypot(dx, dz) || 1;
    const d = distPlayer(x, z);
    const g = c.createGain(); g.gain.value = gain / (1 + (d / ref) ** 2);
    let p = null;
    if (c.createStereoPanner) { p = c.createStereoPanner(); p.pan.value = clampPan((dx * e[0] + dz * e[2]) / len) * 0.75; g.connect(p); p.connect(A.master); } else g.connect(A.master);
    setTimeout(() => { try { g.disconnect(); p?.disconnect(); } catch { /* */ } }, (dur + 1) * 1000);
    return g;
  }
  function noiseSrc(t, dur, off = Math.random() * 1.5) { const s = A.ctx.createBufferSource(); s.buffer = A.noise; s.start(t, off, dur); return s; }
  function env(g, t, peak, a, dcy) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy); }

  function typingBurst(x, z, keys) {
    const c = A.ctx; let t = c.currentTime + 0.05;
    const out = outAt(x, z, 6, 0.5, keys * 0.2 + 1);
    for (let i = 0; i < keys; i++) {
      const s = noiseSrc(t, 0.05), f = c.createBiquadFilter(), g = c.createGain();
      f.type = 'bandpass'; f.frequency.value = 1700 + Math.random() * 2400; f.Q.value = 1.4;
      env(g, t, 0.18 + Math.random() * 0.2, 0.002, 0.04);
      s.connect(f); f.connect(g); g.connect(out);
      t += 0.06 + Math.random() * 0.12 + (Math.random() < 0.08 ? 0.28 : 0);
    }
    return t - c.currentTime;
  }
  function sndPhone(x, z) {
    const c = A.ctx, rings = 2 + Math.floor(Math.random() * 3), t0 = c.currentTime + 0.05;
    const out = outAt(x, z, 5, 0.16, rings * 3.8);
    const o = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
    o.type = 'triangle'; lp.type = 'lowpass'; lp.frequency.value = 2600; g.gain.value = 0;
    o.connect(lp); lp.connect(g); g.connect(out);
    let t = t0;
    for (let r = 0; r < rings; r++) {
      for (let k = 0; k < 48; k++) o.frequency.setValueAtTime(k % 2 ? 1180 : 940, t + k / 30);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.02); g.gain.setValueAtTime(1, t + 1.55); g.gain.linearRampToValueAtTime(0, t + 1.6);
      t += 3.8;
    }
    o.start(t0); o.stop(t);
  }
  function sndCopier(dur) {
    if (!S.copier) return;
    const c = A.ctx, t0 = c.currentTime + 0.05, { x, z } = S.copier;
    const out = outAt(x, z, 4, 1, dur + 1);
    A.copierOut = out;
    const o = c.createOscillator(), lp = c.createBiquadFilter(), gm = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = 52; lp.type = 'lowpass'; lp.frequency.value = 200;
    gm.gain.setValueAtTime(0.0001, t0); gm.gain.linearRampToValueAtTime(0.16, t0 + 0.4); gm.gain.setValueAtTime(0.16, t0 + dur - 0.3); gm.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp); lp.connect(gm); gm.connect(out); o.start(t0); o.stop(t0 + dur + 0.1);
    const s = c.createBufferSource(); s.buffer = A.noise; s.loop = true;
    const bp = c.createBiquadFilter(), gn = c.createGain(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.8;
    gn.gain.setValueAtTime(0.0001, t0);
    for (let p = 0; t0 + 0.4 + p * 1.1 < t0 + dur - 0.2; p++) {
      const tp = t0 + 0.4 + p * 1.1;
      gn.gain.linearRampToValueAtTime(0.03, tp); gn.gain.linearRampToValueAtTime(0.22, tp + 0.12); gn.gain.linearRampToValueAtTime(0.03, tp + 0.5);
    }
    gn.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    s.connect(bp); bp.connect(gn); gn.connect(out); s.start(t0); s.stop(t0 + dur + 0.1);
    const b = c.createOscillator(), gb = c.createGain(); b.type = 'sine'; b.frequency.value = 1450;
    env(gb, t0 + dur, 0.12, 0.005, 0.15); b.connect(gb); gb.connect(out); b.start(t0 + dur); b.stop(t0 + dur + 0.3);
  }
  function sndDing(x, z) {
    if (!live()) return;
    const c = A.ctx, t = c.currentTime + 0.01, out = outAt(x, z, 4, 0.5, 2);
    for (const [f, a] of [[2093, 1], [5270, 0.35], [7040, 0.12]]) {
      const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f;
      env(g, t, a * 0.5, 0.003, 1.5); o.connect(g); g.connect(out); o.start(t); o.stop(t + 1.6);
    }
  }
  function sndGlug(x, z, n = 2) {
    if (!live()) return;
    const c = A.ctx, out = outAt(x, z, 3, 0.5, n * 0.3 + 1);
    for (let i = 0; i < n; i++) {
      const t = c.currentTime + 0.05 + i * 0.24, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(95, t + 0.16);
      env(g, t, 0.5, 0.01, 0.18); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.25);
    }
  }
  function sndGurgle() {
    if (!live()) return;
    const c = A.ctx, t = c.currentTime + 0.02, out = outAt(api.player.x, api.player.z, 3, 0.35, 3);
    const s = noiseSrc(t, 2.2), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 650; f.Q.value = 6;
    g.gain.setValueAtTime(0.0001, t);
    for (let k = 0; k < 16; k++) g.gain.linearRampToValueAtTime(0.2 + Math.random() * 0.5, t + k * 0.13 + 0.06);
    g.gain.linearRampToValueAtTime(0.0001, t + 2.2);
    for (let k = 0; k < 8; k++) f.frequency.setValueAtTime(400 + Math.random() * 600, t + k * 0.27);
    s.connect(f); f.connect(g); g.connect(out);
  }
  function sndThunk() {
    if (!live()) return;
    const c = A.ctx, t = c.currentTime + 0.01, out = outAt(api.player.x, api.player.z, 3, 0.6, 1);
    const o = c.createOscillator(), g = c.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    env(g, t, 0.6, 0.004, 0.16); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.25);
  }
  function sndChomp() {
    if (!live()) return;
    const c = A.ctx, out = outAt(api.player.x, api.player.z, 3, 0.4, 1.5);
    for (let i = 0; i < 3; i++) {
      const t = c.currentTime + 0.05 + i * 0.28, s = noiseSrc(t, 0.12), f = c.createBiquadFilter(), g = c.createGain();
      f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 500; f.Q.value = 1.5;
      env(g, t, 0.5, 0.01, 0.09); s.connect(f); f.connect(g); g.connect(out);
    }
  }
  function sndSlap() {
    if (!live() || !S.copier) return;
    const c = A.ctx, t = c.currentTime + 0.01, out = outAt(S.copier.x, S.copier.z, 4, 0.8, 2);
    const s = noiseSrc(t, 0.15), f = c.createBiquadFilter(), g = c.createGain(); f.type = 'lowpass'; f.frequency.value = 500;
    env(g, t, 0.9, 0.003, 0.12); s.connect(f); f.connect(g); g.connect(out);
    for (let i = 0; i < 3; i++) { const o = c.createOscillator(), gb = c.createGain(); o.type = 'square'; o.frequency.value = 880; env(gb, t + 0.3 + i * 0.22, 0.08, 0.005, 0.1); o.connect(gb); gb.connect(out); o.start(t + 0.3 + i * 0.22); o.stop(t + 0.5 + i * 0.22); }
  }
  let crackleT = 0;
  function sndCrackle(x, z) {
    if (!live() || performance.now() < crackleT || distPlayer(x, z) > 8) return;
    crackleT = performance.now() + 90;
    const c = A.ctx, t = c.currentTime + 0.005, out = outAt(x, z, 3, 0.25, 0.5);
    const s = noiseSrc(t, 0.03), f = c.createBiquadFilter(), g = c.createGain(); f.type = 'highpass'; f.frequency.value = 2500;
    env(g, t, 0.4, 0.001, 0.025); s.connect(f); f.connect(g); g.connect(out);
  }

  // funcionários trabalhando (para o teclado distante): lista do RH, atualizada pelo canal do hub
  let staffRooms = new Map(), staffOff = null, staffBusy = false, staffAgain = false;
  async function refreshStaff() {
    const id = api.office.id;
    if (!id) return;
    if (staffBusy) { staffAgain = true; return; }
    staffBusy = true;
    try {
      const j = await api.request('/api/rh/funcionarios', { office: id, wait: 0 }, 'GET', undefined, { timeout: 8000 });
      const m = new Map();
      for (const f of j.funcionarios || []) {
        let n = ['trabalhando', 'esperando_equipe', 'contratando'].includes(f.status) ? 1 : 0;
        for (const s of f.subagentes || []) if (s.status === 'trabalhando') n++;
        if (n && f.sala) m.set(f.sala, (m.get(f.sala) || 0) + n);
      }
      staffRooms = m;
    } catch { staffRooms = new Map(); }
    finally { staffBusy = false; if (staffAgain) { staffAgain = false; refreshStaff(); } }
  }

  function updateAudio(dt) {
    if (!live()) return;
    A.acc += dt;
    if (A.acc < 0.2) return;
    A.acc = 0;
    const c = A.ctx, now = c.currentTime;
    const f = S.flicker.find(x => x.mode === 'forte');
    const bz = f ? Math.max(0, 1 - distPlayer(f.x, f.z) / 7) : 0;
    A.buzzG.gain.setTargetAtTime(0.012 * bz * bz, now, 0.3);
    if (A.copierOut && S.copier && copier.busy) A.copierOut.gain.setTargetAtTime(1 / (1 + (distPlayer(S.copier.x, S.copier.z) / 4) ** 2), now, 0.2);
    if (staffRooms.size && now >= A.nextType) {
      let total = 0; for (const n of staffRooms.values()) total += n;
      let k = Math.random() * total, roomId = null;
      for (const [id, n] of staffRooms) { k -= n; if (k <= 0) { roomId = id; break; } }
      const room = api.roomById(roomId || [...staffRooms.keys()][0]);
      const p = room?.center || api.office.zones.spawn;
      const dur = typingBurst(p.x, p.z, 6 + Math.floor(Math.random() * 22));
      A.nextType = now + dur + 0.3 + Math.random() * (3 / Math.min(3, total));
    }
    if (now >= A.nextPhone) {
      A.nextPhone = now + 100 + Math.random() * 220;
      const cubs = api.office.zones.cubicles || [];
      const p = cubs.length ? cubs[Math.floor(Math.random() * cubs.length)] : api.office.zones.spawn;
      if (p) sndPhone(p.x, p.z);
    }
  }

  // ---- HUD: botão de som + volume (tecla B)
  function setMuted(m) {
    A.muted = m; lsSet(LS_MUTE, m ? '1' : '0');
    if (m) { A.ctx?.suspend().catch(() => {}); }
    else ensureAudio();
    renderHud();
  }
  let hudEl = null;
  function renderHud() {
    if (!hudEl) return;
    hudEl.classList.toggle('amb-off', A.muted);
    const b = hudEl.querySelector('button');
    b.textContent = A.muted ? '🔇 som desligado' : '🔊 som ambiente';
    b.title = A.muted ? 'Ligar o som ambiente (B)' : 'Desligar o som ambiente (B)';
    hudEl.querySelector('input').value = Math.round(A.vol * 100);
  }
  function mountHud() {
    const slot = api.hudSlot('ambiente-som', { order: 9 });
    slot.innerHTML = '<div class="amb-snd card"><button type="button"></button><input type="range" min="0" max="100" step="5" aria-label="Volume do som ambiente"></div>';
    hudEl = slot.firstElementChild;
    hudEl.querySelector('button').addEventListener('click', ev => { setMuted(!A.muted); ev.currentTarget.blur(); });
    const rg = hudEl.querySelector('input');
    rg.addEventListener('input', () => {
      A.vol = Math.max(0, Math.min(1, rg.value / 100)); lsSet(LS_VOL, String(Math.round(A.vol * 100)));
      if (A.master) A.master.gain.setTargetAtTime(A.vol * 0.6, A.ctx.currentTime, 0.05);
      if (A.muted && A.vol > 0) setMuted(false);
    });
    rg.addEventListener('change', () => rg.blur());
    rg.addEventListener('pointerup', () => setTimeout(() => rg.blur(), 0));
    renderHud();
  }

  // ============================================================ ligações com o núcleo
  api.on('layoutChanged', () => {
    for (const m of S.dynamic) { try { m.dispose?.(); } catch { /* */ } }
    S.dynamic = []; S.lamps = null; S.hands = null; S.donuts = null; S.bubbles = null; S.copier = null; S.cooler = null; S.sunMesh = null; S.stats = {};
    const t0 = performance.now();
    try {
      refreshTexts();
      build();
      applyTime(true);
      api.setPlaceholderVisible(PLACEHOLDERS, false);
      S.ok = true;
    } catch (err) {
      console.error('[ambiente] falhou ao montar a decoração — placeholders mantidos:', err);
      api.setPlaceholderVisible(PLACEHOLDERS, true);
      S.ok = false;
    }
    S.stats.ms = Math.round(performance.now() - t0);
  });

  api.on('officeReady', office => {
    refreshStaff();
    staffOff?.();
    staffOff = api.watch(`esc:staff:${office.id}`, () => refreshStaff());
  });

  api.on('update', (dt, t) => {
    if (!S.ok) return;
    updateFlicker(dt);
    if ((clockAcc += dt) >= 0.25) { clockAcc = 0; updateClocks(); }
    updateBubbles(dt);
    updateCopier(dt, t);
    if ((skyAcc += dt) >= 30) { skyAcc = 0; applyTime(); refreshTexts(); }
    updateAudio(dt);
  });

  api.on('visibility', visible => {
    if (!A.ctx) return;
    if (!visible) A.ctx.suspend().catch(() => {});
    else if (!A.muted) A.ctx.resume().catch(() => {});
  });

  // o navegador só libera áudio depois de um gesto do usuário
  const unlock = () => { ensureAudio(); removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true); };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);

  if (api.isKeyFree('KeyB')) api.registerKey('KeyB', { label: 'B', help: 'som ambiente (liga/desliga)', handler: () => { setMuted(!A.muted); api.toast(A.muted ? '🔇 Som ambiente desligado' : '🔊 Som ambiente ligado', 1400); } });
  mountHud();

  // depuração (F12): window.__esc.api não expõe isto; deixo um gancho próprio e inofensivo
  window.__ambiente = {
    get stats() { return { ...S.stats, lamps: S.lampList.length, ok: S.ok, staff: Object.fromEntries(staffRooms) }; },
    applyTime, startCopy: () => startCopy(true), startBubbles, audio: A,
    simular(salas) { staffRooms = new Map(Object.entries(salas || {})); if (A.ctx) { A.nextType = 0; A.nextPhone = 0; } },
  };
}
