// ============================================================ PACOTE personagens — bonecos low-poly articulados
// Registra a fábrica de bonecos do Escritório (CONTRATO: ARCH.md §Personagens):
//   api.provideCharacterFactory((opts, ctx) => personagem)
//
// Como é feito (GPU fraca!):
//  - Cada boneco é UM SkinnedMesh com vertex colors e UM material Lambert compartilhado (flatShading, visual low-poly):
//    1 draw call por boneco. As partes (cabeça, tronco, braço, antebraço, mão, coxa, canela, sapato...) são caixas e
//    prismas mesclados, cada uma presa 100% a um osso (skinning rígido, sem pesos misturados).
//  - Os objetos de cena (laptop, caneca, papéis) são ossos extras dentro da MESMA malha: escala 0 = escondido.
//  - A sombra é um blob: TODOS os blobs saem de um único InstancedMesh (1 draw call no total).
//  - Animação procedural por canais (quadril, peito, cabeça, braços, pernas, boca, objetos) com máquina de estados
//    e crossfade entre estados. Longe da câmera (> quality.npcAnimDist) a pose atualiza a 10/5 Hz; o movimento não.
//  - Geometria em cache por aparência (mesma semente + skin = mesma malha, com contagem de referências).
//
// opts: { skin: 'player'|'employee'|'subagent', seed, colors?: {suit, shirt, tie, skin, hair, pants}, name?, manual? }
// personagem (além do contrato): emote(estado, s, depois?) · setProp(prop|null) (objeto carregado em qualquer estado)
//   · height (m, topo da cabeça) · appearance (aparência sorteada) · setName(nome)
// setState(estado, { yaw?, facing?:{x,z}, prop? }) — prop: 'laptop' | 'terminal' (laptop com tela piscando, p/ Bash)
//   | 'mug' (caneca) | 'papers' (lendo papéis) | null. Padrão: type → laptop, drink → mug.
//   Durante um walkTo, um estado "parado" pedido fica na fila e vale ao chegar (o boneco não desliza pela sala).
import * as THREE from 'three';

const STATES = ['idle', 'walk', 'run', 'sit', 'type', 'talk', 'point', 'drink', 'wave', 'cheer'];
const LOCO = new Set(['walk', 'run']);
const SEATED = new Set(['sit', 'type']);
const DEFAULT_PROP = { type: 'laptop', drink: 'mug' };
const PROPS = new Set(['laptop', 'terminal', 'mug', 'papers']);

let API = null;   // guardado no install (cena para os blobs)

// ---------------------------------------------------------------- utilidades locais
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const TAU = Math.PI * 2;
const wrap = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const dampAngle = (a, b, k, dt) => a + wrap(b - a) * (1 - Math.exp(-k * dt));
// ruído suave barato (soma de senos)
const noise = t => Math.sin(t) * 0.5 + Math.sin(t * 2.31 + 1.7) * 0.3 + Math.sin(t * 4.13 + 0.3) * 0.2;
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {
  let a = seed || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];

// ---------------------------------------------------------------- esqueleto (posições de repouso ABSOLUTAS, frente = +Z)
// Lado: L = esquerda DO BONECO (+X), R = direita (−X).
const BONES = [
  ['root', -1, 0, 0, 0],
  ['hips', 0, 0, 0.92, 0],
  ['chest', 1, 0, 1.02, 0],
  ['head', 2, 0, 1.54, 0],
  ['eyes', 3, 0, 1.71, 0.12],
  ['mouth', 3, 0, 1.615, 0.115],
  ['uArmL', 2, 0.235, 1.45, 0],
  ['fArmL', 6, 0.235, 1.15, 0],
  ['uArmR', 2, -0.235, 1.45, 0],
  ['fArmR', 8, -0.235, 1.15, 0],
  ['thighL', 1, 0.095, 0.9, 0],
  ['shinL', 10, 0.095, 0.48, 0],
  ['thighR', 1, -0.095, 0.9, 0],
  ['shinR', 12, -0.095, 0.48, 0],
  ['laptop', 0, 0, 0.77, 0.66],
  ['glow', 14, 0, 0.88, 0.79],
  ['mug', 9, -0.235, 0.855, 0],
  ['papers', 2, 0, 1.27, 0.3],
];
const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));
const REST = Object.fromEntries(BONES.map(b => [b[0], [b[2], b[3], b[4]]]));
const HIP_Y = REST.hips[1];
const SIT_HIP_Y = 0.5;                                    // quadril sentado (assento ~0,45 m)
const SHOULDER = [0.235, REST.uArmL[1] - REST.chest[1]];  // ombro no espaço do peito
const L1 = 0.3, L2 = 0.31;                                // ombro→cotovelo, cotovelo→palma
const LEG = 0.84;                                         // quadril→tornozelo

// ---------------------------------------------------------------- canais da pose
const CH = {};
['hipsY', 'hipsX', 'hipsZ', 'hipsRX', 'hipsRY', 'hipsRZ', 'chestRX', 'chestRY', 'chestRZ', 'headRX', 'headRY', 'headRZ',
  'uLX', 'uLY', 'uLZ', 'fLX', 'fLZ', 'uRX', 'uRY', 'uRZ', 'fRX', 'fRZ', 'tLX', 'tLZ', 'sLX', 'tRX', 'tRZ', 'sRX',
  'mouth', 'rootY', 'lap', 'mug', 'paper', 'mugTilt'].forEach((n, i) => { CH[n] = i; });
const NCH = Object.keys(CH).length;

// ---------------------------------------------------------------- paletas
const SKIN_TONES = ['#f1c9a5', '#e8bd96', '#e0b48f', '#c99670', '#a8744f', '#7a5236', '#5a3a26'];
const HAIR = ['#2b1d14', '#4a3222', '#6b4a2b', '#a57b4f', '#d8b77a', '#8d8d8d', '#1a1a1a', '#7a3b1f', '#b9b9b9'];
const SUITS = ['#4a4f57', '#6b5140', '#26292e', '#5d6470', '#8a7355', '#3b4a63', '#3f3a36', '#55604f'];
const BLAZERS = ['#7a2e3a', '#2f5d62', '#4a4f57', '#26292e', '#6d5a7e', '#8a6a4a', '#34495e'];
const TIES = ['#7a1f2b', '#2c5d8f', '#2f6b3f', '#c28a2c', '#5b2a6e', '#b8452f', '#1f3f5f', '#8f2d56', '#3d7a78'];
const SHIRTS = ['#f4f1ea', '#dfe9f3', '#f3eadf', '#e9f0e4', '#fbfbfb', '#e8e1f0'];
const BLOUSES = ['#f6efe6', '#f2d7d9', '#e3eef5', '#fbfbfb', '#f3e7c9'];
const SUB_SHIRTS = ['#f4f7fb', '#dbe8f5', '#e8f0e0', '#f5ecd8', '#fbfbfb'];
const SUB_PANTS = ['#3b4250', '#5a4a3c', '#2c3036', '#6b6f76', '#4d5a4a'];
const HAIR_M = ['curto', 'curto', 'risca', 'risca', 'topete', 'careca', 'careca'];
const HAIR_F = ['coque', 'chanel', 'longo', 'rabo', 'chanel'];

function makeAppearance(opts) {
  const kind = ['player', 'employee', 'subagent'].includes(opts.skin) ? opts.skin : 'employee';
  const seed = String(opts.seed ?? opts.name ?? Math.floor(Math.random() * 1e9));
  const r = rng(hashStr(`${kind}:${seed}`));
  const C = opts.colors || {};
  const a = { kind, scale: 1, belly: 0, glasses: false, facial: null, jacket: true, badge: false, pocketSquare: false };
  if (kind === 'player') {
    Object.assign(a, { female: false, skinTone: '#e0b48f', hair: 'risca', hairColor: '#3b2a1e', suit: '#1f2d4a', shirt: '#f4f1ea',
      tie: '#b3202a', pants: '#1c2842', shoes: '#18120e', bottom: 'pants', pocketSquare: true });
  } else if (kind === 'employee') {
    a.female = r() < 0.4;
    a.skinTone = pick(SKIN_TONES, r);
    a.hairColor = pick(HAIR, r);
    a.scale = 0.96 + r() * 0.08;
    a.glasses = r() < 0.3;
    if (a.female) {
      a.hair = pick(HAIR_F, r);
      a.suit = pick(BLAZERS, r); a.shirt = pick(BLOUSES, r); a.tie = null;
      a.bottom = r() < 0.55 ? 'skirt' : 'pants';
      a.pants = r() < 0.6 ? a.suit : pick(['#26292e', '#3a3f47', '#4a3a30'], r);
      a.shoes = pick(['#18120e', '#6b1f2a', '#3a2a20'], r);
      a.necklace = r() < 0.5;
    } else {
      a.hair = pick(HAIR_M, r);
      a.suit = pick(SUITS, r); a.shirt = pick(SHIRTS, r); a.tie = pick(TIES, r);
      a.bottom = 'pants';
      a.pants = r() < 0.75 ? a.suit : pick(['#26292e', '#3a3f47', '#5a4a3c'], r);
      a.shoes = pick(['#18120e', '#4a2e1c'], r);
      a.belly = r() < 0.25 ? 0.05 + r() * 0.03 : 0;
      const f = r(); a.facial = f < 0.18 ? 'bigode' : f < 0.28 ? 'barba' : null;
    }
  } else {   // subagent: mangas de camisa + crachá, menorzinho, gravata herdada do chefe (colors.tie)
    a.female = r() < 0.4;
    a.skinTone = pick(SKIN_TONES, r);
    a.hairColor = pick(HAIR.slice(0, 8), r);
    a.scale = 0.86 + r() * 0.04;
    a.glasses = r() < 0.3;
    a.jacket = false; a.badge = true;
    a.shirt = pick(SUB_SHIRTS, r); a.tie = pick(TIES, r); a.suit = a.shirt;
    a.pants = pick(SUB_PANTS, r); a.shoes = pick(['#18120e', '#4a2e1c', '#3a2a20'], r);
    a.hair = a.female ? pick(HAIR_F, r) : pick(HAIR_M.filter(h => h !== 'careca'), r);
    a.bottom = a.female && r() < 0.4 ? 'skirt' : 'pants';
    const f = r(); a.facial = !a.female && f < 0.12 ? 'bigode' : null;
  }
  // cores forçadas pelo chamador
  if (C.suit) a.suit = C.suit;
  if (C.shirt) { a.shirt = C.shirt; if (!a.jacket) a.suit = C.shirt; }
  if (C.tie) a.tie = C.tie;
  if (C.skin) a.skinTone = C.skin;
  if (C.hair) a.hairColor = C.hair;
  if (C.pants) a.pants = C.pants;
  a.armOut = 0.05 + a.belly * 1.4;
  return a;
}

// ---------------------------------------------------------------- construção da malha (vertex colors + skinIndex)
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _col = new THREE.Color();

class Mesher {
  constructor() { this.P = []; this.C = []; this.I = []; }
  // geo: BufferGeometry já na forma local; xf: {x,y,z, rx,ry,rz, sx,sy,sz} aplicado depois
  add(geo, bone, color, xf = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    _m4.compose(_p.set(xf.x || 0, xf.y || 0, xf.z || 0), _q.setFromEuler(_e.set(xf.rx || 0, xf.ry || 0, xf.rz || 0)),
      _s.set(xf.sx ?? 1, xf.sy ?? 1, xf.sz ?? 1));
    g.applyMatrix4(_m4);
    const pos = g.attributes.position.array;
    _col.set(color);
    for (let i = 0; i < pos.length; i += 3) {
      this.P.push(pos[i], pos[i + 1], pos[i + 2]);
      this.C.push(_col.r, _col.g, _col.b);
      this.I.push(bone);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  }
  build() {
    const n = this.I.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = this.I[i]; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.computeVertexNormals();
    return g;
  }
}

// caixa afunilada entre yBot e yTop (larguras/profundidades diferentes em cima e embaixo), centrada em (x, z)
function seg({ x = 0, z = 0, yTop, yBot, wTop, wBot, dTop, dBot }) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? wTop : wBot) + x, top ? yTop : yBot, p.getZ(i) * (top ? dTop : dBot) + z);
  }
  return g;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
// só a face da frente (+Z): detalhes chapados (olhos, botões, telas...) custam 2 triângulos em vez de 12
const quad = (w, h) => new THREE.PlaneGeometry(w, h);
function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([ax, ay, az, bx, by, bz, cx, cy, cz], 3));
  return g;
}
const shade = (hex, f) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();

function buildGeometry(a) {
  const M = new Mesher();
  const B = BI;
  const skinC = a.skinTone, skinD = shade(a.skinTone, 0.9);
  const sleeve = a.jacket ? a.suit : a.shirt;
  const legC = a.bottom === 'skirt' ? shade(a.skinTone, 0.93) : a.pants;

  // ---- pernas e sapatos
  for (const s of [1, -1]) {
    const x = 0.095 * s, th = s > 0 ? B.thighL : B.thighR, sh = s > 0 ? B.shinL : B.shinR;
    M.add(seg({ x, yTop: 0.93, yBot: 0.47, wTop: 0.15, wBot: 0.13, dTop: 0.16, dBot: 0.14 }), th, legC);
    M.add(seg({ x, yTop: 0.49, yBot: 0.085, wTop: 0.13, wBot: 0.115, dTop: 0.14, dBot: 0.125 }), sh, legC);
    if (a.female && a.bottom === 'skirt') {   // scarpin: sapato fino + salto
      M.add(box(0.1, 0.06, 0.22), sh, a.shoes, { x, y: 0.06, z: 0.04 });
      M.add(box(0.035, 0.06, 0.035), sh, a.shoes, { x, y: 0.03, z: -0.05 });
    } else {
      M.add(box(0.12, 0.075, 0.25), sh, a.shoes, { x, y: 0.0475, z: 0.045 });
      M.add(box(0.125, 0.018, 0.26), sh, shade(a.shoes, 0.55), { x, y: 0.009, z: 0.045 });
    }
  }
  // ---- quadril (calça) / saia / cinto
  M.add(seg({ yTop: 0.99, yBot: 0.85, wTop: 0.33, wBot: 0.33, dTop: 0.21, dBot: 0.2 }), B.hips, a.bottom === 'skirt' ? a.pants : a.pants);
  if (a.bottom === 'skirt') M.add(seg({ yTop: 1.0, yBot: 0.5, wTop: 0.34, wBot: 0.4, dTop: 0.22, dBot: 0.26 }), B.hips, a.pants);

  // ---- tronco
  const bw = a.belly;
  const T = a.jacket
    ? (a.female ? { yTop: 1.52, yBot: 1.02, wTop: 0.4, wBot: 0.31, dTop: 0.21, dBot: 0.21 }
      : { yTop: 1.52, yBot: 1.02, wTop: 0.43, wBot: 0.345 + bw, dTop: 0.225, dBot: 0.225 + bw * 1.6 })
    : { yTop: 1.52, yBot: 0.97, wTop: a.female ? 0.37 : 0.39, wBot: a.female ? 0.3 : 0.32 + bw, dTop: 0.2, dBot: 0.2 + bw * 1.4 };
  const fz = y => lerp(T.dBot, T.dTop, (y - T.yBot) / (T.yTop - T.yBot)) / 2;   // frente do tronco na altura y
  M.add(seg(T), B.chest, a.suit);
  if (a.jacket) {
    // aba do paletó sobre o quadril + abertura em V embaixo
    const hw = a.female ? 0.33 : 0.35 + bw, hd = a.female ? 0.22 : 0.235 + bw * 1.6;
    M.add(seg({ yTop: 1.03, yBot: a.female ? 0.86 : 0.8, wTop: T.wBot, wBot: hw, dTop: T.dBot + 0.005, dBot: hd }), B.hips, a.suit);
    const hz = hd / 2 + 0.003, yb = a.female ? 0.86 : 0.8;
    M.add(tri(-0.05, yb, hz, 0.05, yb, hz, 0, yb + 0.09, hz - 0.004), B.hips, a.bottom === 'skirt' ? a.pants : shade(a.pants, 0.8));
    // camisa/blusa em V
    const vBot = a.female ? 1.2 : 1.25;
    M.add(tri(-0.085, 1.52, fz(1.52) + 0.003, 0, vBot, fz(vBot) + 0.003, 0.085, 1.52, fz(1.52) + 0.003), B.chest, a.shirt);
    // lapelas
    const lap = shade(a.suit, 0.78), ang = Math.atan2(0.085, 1.52 - vBot);
    for (const s of [1, -1]) {
      const ym = (1.52 + vBot) / 2 + 0.01;
      M.add(box(0.04, (1.52 - vBot) * 1.05, 0.014), B.chest, lap, { x: s * 0.05, y: ym, z: fz(ym) + 0.006, rz: s * ang });
    }
    // botões
    for (const y of (a.female ? [1.15, 1.08] : [1.19, 1.1])) M.add(quad(0.022, 0.022), B.chest, '#1b1b1d', { y, z: fz(y) + 0.002 });
    if (a.pocketSquare) M.add(tri(0.09, 1.405, 0, 0.15, 1.405, 0, 0.13, 1.44, 0), B.chest, '#fbfbfb', { z: fz(1.415) + 0.002 });
    else if (!a.female) M.add(quad(0.07, 0.01), B.chest, lap, { x: 0.12, y: 1.4, z: fz(1.4) + 0.002 });
  } else {
    // mangas de camisa: cinto + fivela; bolso com caneta
    M.add(box(0.335 + bw, 0.035, 0.215 + bw * 1.4), B.hips, '#2a1d15', { y: 0.975 });
    M.add(quad(0.04, 0.03), B.hips, '#c9a24a', { y: 0.975, z: (0.215 + bw * 1.4) / 2 + 0.002 });
    M.add(quad(0.07, 0.07), B.chest, shade(a.shirt, 0.9), { x: -0.1, y: 1.35, z: fz(1.35) + 0.002 });
    M.add(box(0.012, 0.06, 0.012), B.chest, '#2c5dbf', { x: -0.085, y: 1.39, z: fz(1.39) + 0.008 });
    // botões da camisa
    for (const y of [1.36, 1.22, 1.08]) M.add(quad(0.016, 0.016), B.chest, shade(a.shirt, 0.75), { y, z: fz(y) + 0.002 });
  }
  // gravata (ou lenço/colar)
  if (a.tie && !a.female) {
    const z0 = fz(1.47) + 0.012;
    M.add(box(0.05, 0.045, 0.028), B.chest, shade(a.tie, 0.85), { y: 1.485, z: z0 });
    M.add(seg({ z: fz(1.33) + 0.011, yTop: 1.465, yBot: 1.215, wTop: 0.04, wBot: 0.064, dTop: 0.016, dBot: 0.016 }), B.chest, a.tie);
    M.add(box(0.045, 0.045, 0.016), B.chest, a.tie, { y: 1.215, z: fz(1.215) + 0.011, rz: Math.PI / 4 });
    // listra diagonal (charme)
    M.add(quad(0.058, 0.012), B.chest, shade(a.tie, 1.35), { y: 1.36, z: fz(1.36) + 0.02, rz: 0.5 });
  } else if (a.tie && a.female) {   // lencinho no pescoço (subagente)
    M.add(tri(-0.07, 1.515, fz(1.5) + 0.01, 0, 1.4, fz(1.4) + 0.012, 0.07, 1.515, fz(1.5) + 0.01), B.chest, a.tie);
  } else if (a.necklace) {
    M.add(quad(0.032, 0.032), B.chest, '#d9b44a', { y: 1.44, z: fz(1.44) + 0.003, rz: Math.PI / 4 });
  }
  // gola
  for (const s of [1, -1]) M.add(box(0.075, 0.05, 0.02), B.chest, a.shirt, { x: s * 0.048, y: 1.525, z: fz(1.52) - 0.012, rz: s * 0.55 });
  M.add(box(0.15, 0.045, 0.12), B.chest, a.shirt, { y: 1.515, z: -0.02 });
  // crachá (subagente): cordão + cartão com faixa na cor da gravata
  if (a.badge) {
    const bz = fz(1.33) + 0.012, bc = a.tie || '#2c5d8f';
    M.add(box(0.065, 0.085, 0.01), B.chest, '#fbfbf5', { x: 0.1, y: 1.32, z: bz });
    M.add(quad(0.065, 0.022), B.chest, bc, { x: 0.1, y: 1.352, z: bz + 0.0055 });
    M.add(quad(0.022, 0.026), B.chest, skinD, { x: 0.083, y: 1.315, z: bz + 0.0055 });
    M.add(quad(0.03, 0.006), B.chest, '#8a8f96', { x: 0.113, y: 1.31, z: bz + 0.0055 });
    M.add(quad(0.012, 0.19), B.chest, bc, { x: 0.065, y: 1.44, z: fz(1.44) + 0.004, rz: -0.3 });
  }
  // pescoço
  M.add(seg({ yTop: 1.58, yBot: 1.48, wTop: 0.08, wBot: 0.085, dTop: 0.085, dBot: 0.09, z: -0.005 }), B.chest, skinC);

  // ---- braços
  for (const s of [1, -1]) {
    const x = 0.235 * s, ua = s > 0 ? B.uArmL : B.uArmR, fa = s > 0 ? B.fArmL : B.fArmR;
    M.add(box(0.125, 0.09, 0.14), ua, sleeve, { x: x - s * 0.005, y: 1.47 });
    M.add(seg({ x, yTop: 1.47, yBot: 1.15, wTop: 0.11, wBot: 0.095, dTop: 0.115, dBot: 0.1 }), ua, sleeve);
    if (a.jacket) {
      M.add(seg({ x, yTop: 1.16, yBot: 0.925, wTop: 0.095, wBot: 0.085, dTop: 0.1, dBot: 0.09 }), fa, sleeve);
      M.add(box(0.082, 0.035, 0.088), fa, a.shirt, { x, y: 0.915 });
    } else {   // manga dobrada + antebraço à mostra
      M.add(box(0.108, 0.05, 0.112), fa, shade(a.shirt, 0.94), { x, y: 1.135 });
      M.add(seg({ x, yTop: 1.12, yBot: 0.9, wTop: 0.085, wBot: 0.072, dTop: 0.09, dBot: 0.078 }), fa, skinC);
    }
    // mão (palma virada para o corpo) + polegar
    M.add(box(0.05, 0.09, 0.08), fa, skinC, { x, y: 0.855 });
    M.add(box(0.03, 0.045, 0.03), fa, skinD, { x: x - s * 0.025, y: 0.875, z: 0.035 });
  }

  // ---- cabeça (prisma octogonal afunilado para o queixo; face reta virada para +Z)
  const H0 = 1.555, H1 = 1.825, rT = 0.138, rB = 0.122;
  const hr = y => lerp(rB, rT, (y - H0) / (H1 - H0));
  const face = y => hr(y) * Math.cos(Math.PI / 8);
  M.add(new THREE.CylinderGeometry(rT, rB, H1 - H0, 8, 1, false, -Math.PI / 8), B.head, skinC, { y: (H0 + H1) / 2 });
  const bald = a.hair === 'careca';
  M.add(new THREE.CylinderGeometry(0.1, rT, 0.04, 8, 1, false, -Math.PI / 8), B.head, bald ? skinC : a.hairColor, { y: H1 + 0.02 });
  // orelhas, nariz
  for (const s of [1, -1]) M.add(box(0.03, 0.065, 0.05), B.head, skinD, { x: s * 0.137, y: 1.69, z: -0.005 });
  M.add(box(0.034, 0.055, 0.04), B.head, skinD, { y: 1.668, z: face(1.668) + 0.012 });
  // olhos (osso próprio: piscar)
  for (const s of [1, -1]) {
    M.add(quad(0.054, 0.042), B.eyes, '#fbfaf5', { x: s * 0.05, y: 1.71, z: face(1.71) + 0.003 });
    M.add(quad(0.026, 0.032), B.eyes, '#1d1a18', { x: s * 0.046, y: 1.708, z: face(1.71) + 0.005 });
  }
  // sobrancelhas
  const brow = bald ? shade(a.hairColor, 0.8) : shade(a.hairColor, 0.85);
  for (const s of [1, -1]) M.add(box(0.064, 0.016, 0.012), B.head, brow, { x: s * 0.052, y: 1.753, z: face(1.753) + 0.004, rz: s * 0.1 });
  // boca (osso próprio: falar)
  M.add(quad(0.066, 0.014), B.mouth, '#7a3b33', { y: 1.615, z: face(1.615) + 0.003 });
  if (a.facial === 'bigode') M.add(box(0.09, 0.024, 0.02), B.head, a.hairColor, { y: 1.636, z: face(1.636) + 0.008 });
  if (a.facial === 'barba') {
    M.add(box(0.235, 0.07, 0.17), B.head, a.hairColor, { y: 1.585, z: 0.03 });
    M.add(box(0.1, 0.022, 0.02), B.head, a.hairColor, { y: 1.637, z: face(1.637) + 0.008 });
  }
  if (a.female) for (const s of [1, -1]) M.add(quad(0.03, 0.02), B.head, '#e39a9a', { x: s * 0.078, y: 1.668, z: face(1.668) + 0.002 });   // blush
  // óculos
  if (a.glasses) {
    const gz = face(1.71) + 0.02, fr = '#1d1d1f';
    for (const s of [1, -1]) {
      const cx = s * 0.05;
      M.add(box(0.074, 0.012, 0.012), B.head, fr, { x: cx, y: 1.737, z: gz });
      M.add(box(0.074, 0.01, 0.012), B.head, fr, { x: cx, y: 1.684, z: gz });
      M.add(box(0.01, 0.055, 0.012), B.head, fr, { x: cx + s * 0.035, y: 1.71, z: gz });
      M.add(box(0.01, 0.055, 0.012), B.head, fr, { x: cx - s * 0.035, y: 1.71, z: gz });
      M.add(box(0.01, 0.01, 0.14), B.head, fr, { x: s * 0.134, y: 1.73, z: gz - 0.075 });
    }
  }
  // cabelo
  const hc = a.hairColor, hb = BI.head;
  const cap = () => {
    M.add(new THREE.CylinderGeometry(0.146, 0.149, 0.08, 8, 1, false, -Math.PI / 8), hb, hc, { y: 1.815 });
    M.add(box(0.27, 0.15, 0.05), hb, hc, { y: 1.745, z: -0.112 });                           // nuca
    for (const s of [1, -1]) M.add(box(0.03, 0.085, 0.15), hb, hc, { x: s * 0.137, y: 1.765, z: -0.03 });   // costeletas
  };
  switch (a.hair) {
    case 'curto': cap(); M.add(box(0.23, 0.03, 0.03), hb, hc, { y: 1.8, z: face(1.8) + 0.004 }); break;
    case 'risca': cap(); M.add(box(0.17, 0.04, 0.2), hb, hc, { x: 0.03, y: 1.865, z: 0.02, rz: -0.12 });
      M.add(box(0.2, 0.035, 0.03), hb, hc, { x: 0.02, y: 1.805, z: face(1.8) + 0.004, rz: -0.08 }); break;
    case 'topete': cap(); M.add(box(0.22, 0.065, 0.1), hb, hc, { y: 1.875, z: 0.075, rx: -0.35 }); break;
    case 'careca':
      M.add(box(0.25, 0.07, 0.04), hb, hc, { y: 1.7, z: -0.118 });
      for (const s of [1, -1]) M.add(box(0.03, 0.075, 0.13), hb, hc, { x: s * 0.139, y: 1.715, z: -0.035 });
      break;
    case 'chanel': cap();
      for (const s of [1, -1]) M.add(box(0.035, 0.21, 0.2), hb, hc, { x: s * 0.145, y: 1.7, z: -0.01 });
      M.add(box(0.29, 0.25, 0.05), hb, hc, { y: 1.69, z: -0.122 });
      M.add(box(0.25, 0.04, 0.03), hb, hc, { y: 1.795, z: face(1.795) + 0.005 }); break;
    case 'longo': cap();
      for (const s of [1, -1]) M.add(box(0.035, 0.3, 0.18), hb, hc, { x: s * 0.147, y: 1.66, z: -0.02 });
      M.add(box(0.29, 0.4, 0.06), hb, hc, { y: 1.625, z: -0.13 });
      M.add(box(0.12, 0.035, 0.03), hb, hc, { x: 0.06, y: 1.8, z: face(1.8) + 0.005, rz: 0.2 }); break;
    case 'coque': cap(); M.add(new THREE.IcosahedronGeometry(0.068, 0), hb, hc, { y: 1.84, z: -0.15 });
      M.add(box(0.23, 0.03, 0.03), hb, hc, { y: 1.8, z: face(1.8) + 0.004 }); break;
    case 'rabo': cap(); M.add(box(0.07, 0.07, 0.06), hb, shade(hc, 0.8), { y: 1.79, z: -0.15 });
      M.add(seg({ yTop: 1.78, yBot: 1.56, wTop: 0.065, wBot: 0.035, dTop: 0.06, dBot: 0.035, z: -0.17 }), hb, hc);
      M.add(box(0.23, 0.03, 0.03), hb, hc, { y: 1.8, z: face(1.8) + 0.004 }); break;
    default: cap();
  }

  // ---- objetos de cena (ossos próprios, escondidos com escala 0)
  // laptop (na altura de uma mesa de reunião, 0,76 m, à frente de quem está sentado)
  const lb = BI.laptop;
  M.add(box(0.32, 0.018, 0.22), lb, '#44484f', { y: 0.769, z: 0.66 });
  M.add(quad(0.28, 0.1), lb, '#25272b', { y: 0.7785, z: 0.672, rx: -Math.PI / 2 });
  M.add(quad(0.08, 0.045), lb, '#5d626a', { y: 0.7785, z: 0.587, rx: -Math.PI / 2 });
  const lid = 0.25, hz = 0.768;   // dobradiça em z 0,768, tampa inclinada para trás
  // peça da tampa: back=true vira a face para trás (+Z), senão para quem digita (−Z)
  const lidPart = (g, ox, oy, off, color, bone = lb, back = false) => {
    if (!back && g.type === 'PlaneGeometry') g.rotateY(Math.PI);
    g.translate(ox, 0.105 + oy, off);
    M.add(g, bone, color, { y: 0.778, z: hz, rx: lid });
  };
  lidPart(box(0.32, 0.21, 0.012), 0, 0, 0, '#50555d');
  lidPart(quad(0.29, 0.18), 0, 0, -0.0065, '#5f93c8');
  lidPart(quad(0.035, 0.035), 0, 0, 0.0065, '#d8dde3', lb, true);          // logotipo atrás
  lidPart(quad(0.27, 0.16), 0, 0, -0.0075, '#e3f6ff', BI.glow);             // tela acesa (pisca no 'terminal')
  // linhas de "código" na tela acesa
  for (let i = 0; i < 5; i++) {
    const w = 0.07 + ((i * 37) % 5) * 0.025;
    lidPart(quad(w, 0.012), 0.12 - w / 2 - ((i * 13) % 3) * 0.02, 0.055 - i * 0.027, -0.0085, i % 2 ? '#3f7fbf' : '#2f9a5f', BI.glow);
  }
  // caneca "melhor chefe do mundo" (na mão direita; o osso contra-gira para ela ficar em pé)
  const mb = BI.mug, mx = -0.235 + 0.068, mz = 0.025;
  M.add(new THREE.CylinderGeometry(0.04, 0.036, 0.095, 8), mb, '#f4f1ea', { x: mx, y: 0.855, z: mz });
  M.add(new THREE.CircleGeometry(0.034, 8), mb, '#3b2416', { x: mx, y: 0.899, z: mz, rx: -Math.PI / 2 });
  M.add(box(0.034, 0.05, 0.014), mb, '#f4f1ea', { x: mx - 0.045, y: 0.855, z: mz });
  M.add(quad(0.03, 0.022), mb, '#c0392b', { x: mx, y: 0.86, z: mz + 0.0395 });
  // papéis (presos ao peito, inclinados para o rosto)
  const pb = BI.papers;
  // g já deitado (face para +Y local); inclinado para o rosto
  const paper = (g, ox, oy, oz, color) => { g.translate(ox, oy, oz); M.add(g, pb, color, { y: 1.27, z: 0.3, rx: -1.05 }); };
  const flat = (w, d) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
  paper(box(0.22, 0.006, 0.28), 0, 0, 0, '#f7f5ee');
  paper(box(0.21, 0.004, 0.27), 0.012, -0.004, 0.006, '#e8e2d0');
  for (let i = 0; i < 5; i++) paper(flat(0.15 - (i % 2) * 0.04, 0.012), -0.02 + (i % 2) * -0.02, 0.0035, -0.1 + i * 0.045, '#7d8590');
  paper(flat(0.05, 0.025), 0.07, 0.0035, 0.1, '#c0392b');   // carimbo "URGENTE"

  return M.build();
}

// cache: mesma aparência → mesma geometria (contagem de referências)
const geoCache = new Map();
function acquireGeometry(a) {
  const key = JSON.stringify(a);
  let e = geoCache.get(key);
  if (!e) { e = { geo: buildGeometry(a), refs: 0, key }; e.geo.userData.shared = true; geoCache.set(key, e); }
  e.refs++;
  return e;
}
function releaseGeometry(e) {
  if (--e.refs > 0) return;
  geoCache.delete(e.key);
  e.geo.dispose();
}

// material único (vertex colors). flatShading = facetado low-poly; normais não importam
const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
MAT.userData.shared = true;

// ---------------------------------------------------------------- blobs (sombras falsas): 1 InstancedMesh para todos
const blobs = { mesh: null, cap: 0, list: new Set() };
const blobGeo = new THREE.CircleGeometry(0.33, 14); blobGeo.rotateX(-Math.PI / 2); blobGeo.userData.shared = true;
const blobMat = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false });
blobMat.userData.shared = true;
function ensureBlobCapacity(n) {
  if (!API || (blobs.mesh && n <= blobs.cap)) return;
  const cap = Math.max(32, blobs.cap * 2, n);
  if (blobs.mesh) { API.removeFromScene(blobs.mesh); blobs.mesh.dispose(); }
  const m = new THREE.InstancedMesh(blobGeo, blobMat, cap);
  m.name = 'personagens:sombras';
  m.frustumCulled = false; m.renderOrder = 1; m.count = 0;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blobs.mesh = m; blobs.cap = cap;
  API.addToScene(m);
}
const _bm = new THREE.Matrix4(), _bv = new THREE.Vector3();
function inScene(o) { while (o) { if (!o.visible) return false; if (o.isScene) return true; o = o.parent; } return false; }
function blobPass() {
  if (!blobs.mesh) return;
  let n = 0;
  for (const ch of blobs.list) {
    const g = ch.group;
    if (!inScene(g)) continue;
    if (g.parent.isScene) _bv.copy(g.position); else { g.updateWorldMatrix(true, false); _bv.setFromMatrixPosition(g.matrixWorld); }
    const s = ch._blobScale();
    _bm.makeScale(s, 1, s); _bm.setPosition(_bv.x, _bv.y + 0.014, _bv.z);
    blobs.mesh.setMatrixAt(n++, _bm);
    if (n >= blobs.cap) break;
  }
  blobs.mesh.count = n;
  blobs.mesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- IK de 2 ossos para os braços (no espaço do peito)
const _M = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _E = new THREE.Euler(), _V = new THREE.Vector3(), _Q = new THREE.Quaternion(), _ONE = new THREE.Vector3(1, 1, 1);
// matriz rig → peito a partir dos canais de uma pose
function chestInverse(o) {
  _M.compose(_V.set(o[CH.hipsX], HIP_Y + o[CH.hipsY] + o[CH.rootY], o[CH.hipsZ]), _Q.setFromEuler(_E.set(o[CH.hipsRX], o[CH.hipsRY], o[CH.hipsRZ])), _ONE);
  _M2.compose(_V.set(0, REST.chest[1] - HIP_Y, 0), _Q.setFromEuler(_E.set(o[CH.chestRX], o[CH.chestRY], o[CH.chestRZ])), _ONE);
  return _M.multiply(_M2).invert();
}
// side 1 = esquerdo (+X), −1 = direito. alvo da PALMA em espaço do rig (inv = chestInverse) ou do peito (inv = null).
// Resolve o cotovelo pelo plano do "pólo" (cotovelo para baixo/para fora/para trás) e monta a base do braço:
// Y local = −(direção do braço), Z local = para onde o antebraço dobra, X = dobradiça do cotovelo.
const _S = new THREE.Vector3(), _T = new THREE.Vector3(), _D = new THREE.Vector3(), _P = new THREE.Vector3(), _EL = new THREE.Vector3();
const _u = new THREE.Vector3(), _f = new THREE.Vector3(), _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3();
const _RM = new THREE.Matrix4(), _EU = new THREE.Euler();
function armIK(o, side, tx, ty, tz, inv, pole) {
  _T.set(tx, ty, tz);
  if (inv) _T.applyMatrix4(inv);
  _S.set(SHOULDER[0] * side, SHOULDER[1], 0);
  _D.subVectors(_T, _S);
  const d0 = _D.length();
  if (d0 < 1e-5) _D.set(0, -1, 0); else _D.multiplyScalar(1 / d0);
  const d = clamp(d0, 0.08, L1 + L2 - 0.001);
  if (pole) _P.set(pole[0] * side, pole[1], pole[2]); else _P.set(0.45 * side, -1, -0.3);
  _P.addScaledVector(_D, -_P.dot(_D));
  if (_P.lengthSq() < 1e-6) _P.set(0, 0, -1).addScaledVector(_D, _D.z);
  _P.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _EL.copy(_S).addScaledVector(_D, a).addScaledVector(_P, h);          // cotovelo
  _u.subVectors(_EL, _S).normalize();                                    // braço
  _f.copy(_S).addScaledVector(_D, d).sub(_EL).normalize();               // antebraço
  _Y.copy(_u).negate();
  _Z.copy(_f).addScaledVector(_u, -_f.dot(_u));
  if (_Z.lengthSq() < 1e-6) _Z.set(0, 0, 1).addScaledVector(_u, -_u.z);
  _Z.normalize();
  _X.crossVectors(_Y, _Z);
  _EU.setFromRotationMatrix(_RM.makeBasis(_X, _Y, _Z), 'XYZ');
  const bend = Math.acos(clamp(_u.dot(_f), -1, 1));
  const [ux, uy, uz, fx, fz] = side > 0 ? [CH.uLX, CH.uLY, CH.uLZ, CH.fLX, CH.fLZ] : [CH.uRX, CH.uRY, CH.uRZ, CH.fRX, CH.fRZ];
  o[ux] = _EU.x; o[uy] = _EU.y; o[uz] = _EU.z; o[fx] = -bend; o[fz] = 0;
}
// agachar: abaixa o quadril h metros dobrando os joelhos (pés continuam no chão)
function crouch(o, h) {
  if (h <= 0) return;
  const a = Math.acos(clamp(1 - h / LEG, -1, 1));
  o[CH.tLX] -= a; o[CH.tRX] -= a; o[CH.sLX] += 2 * a; o[CH.sRX] += 2 * a;
}

// ---------------------------------------------------------------- poses por estado
// k = { t, st (tempo no estado), spd, ph (fase da passada), seed (0..1), armOut, prop }
function standBase(o, k) {
  o[CH.uLZ] = k.armOut; o[CH.uRZ] = -k.armOut;
  o[CH.fLX] = -0.14; o[CH.fRX] = -0.14;
}
function breathe(o, k, amt = 1) {
  const b = Math.sin(k.t * 1.7);
  o[CH.chestRX] += 0.018 * b * amt; o[CH.hipsY] += 0.004 * b * amt; o[CH.headRX] -= 0.012 * b * amt;
}
function weightShift(o, k, amt = 1) {
  const w = Math.sin(k.t * 0.42 + k.seed * 6) * amt;
  const hx = 0.022 * w, hrz = -0.035 * w;
  o[CH.hipsX] += hx; o[CH.hipsRZ] += hrz; o[CH.chestRZ] -= hrz * 0.8;
  const legZ = -hrz - hx / LEG;
  o[CH.tLZ] += legZ; o[CH.tRZ] += legZ;
  const bR = Math.max(0, w), bL = Math.max(0, -w);
  o[CH.sRX] += 0.16 * bR; o[CH.tRX] -= 0.08 * bR;
  o[CH.sLX] += 0.16 * bL; o[CH.tLX] -= 0.08 * bL;
}
function lookAround(o, k, amt = 1) {
  o[CH.headRY] += 0.32 * noise(k.t * 0.23 + k.seed * 10) * amt;
  o[CH.headRX] += 0.06 * noise(k.t * 0.31 + 3 + k.seed * 4) * amt;
}
function blendTo(o, idx, val, e) { o[idx] = lerp(o[idx], val, e); }

function poseIdle(o, k) {
  standBase(o, k); breathe(o, k); weightShift(o, k); lookAround(o, k);
  o[CH.uLX] += 0.03 * Math.sin(k.t * 1.1); o[CH.uRX] += 0.03 * Math.sin(k.t * 1.1 + 1);
  // cacoete a cada ~16 s: olhar o relógio ou ajeitar a gravata
  const P = 16, u = k.t + k.seed * P, f = u % P;
  if (f < 2.8) {
    const e = sstep(0, 0.5, f) * (1 - sstep(2.2, 2.8, f));
    if (Math.floor(u / P) % 2 === 0) {
      blendTo(o, CH.uLX, -0.55, e); blendTo(o, CH.uLZ, 0.15, e); blendTo(o, CH.fLX, -1.75, e); blendTo(o, CH.fLZ, -0.5, e);
      blendTo(o, CH.headRX, 0.38, e); blendTo(o, CH.headRY, 0.3, e);
    } else {
      blendTo(o, CH.uRX, -0.45, e); blendTo(o, CH.uRZ, 0.2, e); blendTo(o, CH.fRX, -2.1, e); blendTo(o, CH.fRZ, 0.35, e);
      blendTo(o, CH.headRX, -0.12, e); blendTo(o, CH.headRZ, 0.1 * Math.sin(k.t * 6), e);
    }
  }
}

function poseLoco(o, k, run) {
  standBase(o, k);
  const sp = k.spd, ph = k.ph, s = Math.sin(ph), c = Math.cos(ph);
  if (!run) {
    const A = clamp(sp / 1.5, 0, 1.15);
    o[CH.tLX] = -0.48 * A * s; o[CH.tRX] = 0.48 * A * s;
    o[CH.sLX] = A * (0.08 + 0.75 * Math.max(0, c)); o[CH.sRX] = A * (0.08 + 0.75 * Math.max(0, -c));
    o[CH.uLX] = 0.42 * A * s; o[CH.uRX] = -0.42 * A * s;
    o[CH.fLX] = -0.14 - 0.3 * A * Math.max(0, -s); o[CH.fRX] = -0.14 - 0.3 * A * Math.max(0, s);
    o[CH.hipsY] = A * (0.022 * Math.cos(2 * ph) - 0.012);
    o[CH.hipsRY] = 0.09 * A * s; o[CH.chestRY] = -0.13 * A * s; o[CH.headRY] = 0.05 * A * s;
    o[CH.hipsRZ] = 0.03 * A * c;
    o[CH.chestRX] = 0.04 * A; o[CH.headRX] = -0.02 * A;
    breathe(o, k, 1 - Math.min(1, A));
  } else {
    const A = clamp(sp / 4.5, 0.35, 1.15);
    o[CH.tLX] = -0.2 * A - 0.8 * A * s; o[CH.tRX] = -0.2 * A + 0.8 * A * s;
    o[CH.sLX] = A * (0.35 + 1.25 * Math.max(0, c)); o[CH.sRX] = A * (0.35 + 1.25 * Math.max(0, -c));
    o[CH.uLX] = 0.8 * A * s; o[CH.uRX] = -0.8 * A * s;
    o[CH.uLZ] += 0.1; o[CH.uRZ] -= 0.1;
    o[CH.fLX] = -1.35; o[CH.fRX] = -1.35;
    o[CH.hipsY] = A * (0.05 * Math.abs(c) - 0.06);
    o[CH.chestRX] = 0.22 * A; o[CH.headRX] = -0.16 * A;
    o[CH.hipsRY] = 0.12 * A * s; o[CH.chestRY] = -0.2 * A * s;
  }
}

function sitBase(o, k) {
  o[CH.hipsY] = SIT_HIP_Y - HIP_Y;
  o[CH.tLX] = -1.52; o[CH.tRX] = -1.52; o[CH.sLX] = 1.42; o[CH.sRX] = 1.42;
  o[CH.tLZ] = 0.07; o[CH.tRZ] = -0.07;
}
function poseSit(o, k) {
  sitBase(o, k);
  o[CH.chestRX] = -0.05;
  breathe(o, k); lookAround(o, k, 1.2);
  // balança um pé de leve
  o[CH.sLX] += 0.06 * Math.max(0, Math.sin(k.t * 2.2 + k.seed * 5));
  const inv = chestInverse(o);
  armIK(o, 1, 0.12, 0.63, 0.3 + 0.01 * Math.sin(k.t * 0.8), inv);
  armIK(o, -1, -0.12, 0.63, 0.29, inv);
}
function poseType(o, k) {
  sitBase(o, k);
  const t = k.t;
  // a cada ~9 s encosta e lê a tela por um instante
  const P = 9, f = (t + k.seed * P) % P;
  const pause = f < 1.6 ? sstep(0, 0.3, f) * (1 - sstep(1.3, 1.6, f)) : 0;
  o[CH.chestRX] = 0.26 - 0.14 * pause + 0.01 * Math.sin(t * 1.7);
  o[CH.headRX] = 0.2 - 0.08 * pause + 0.03 * Math.sin(t * 2.3);
  o[CH.headRY] = 0.07 * noise(t * 0.4 + k.seed * 9);
  const act = 1 - pause;
  const tapL = 0.02 * Math.max(0, Math.sin(t * 15 + k.seed * 20)) * act;
  const tapR = 0.02 * Math.max(0, Math.sin(t * 13.3 + 2 + k.seed * 7)) * act;
  const inv = chestInverse(o);
  armIK(o, 1, 0.1 + 0.015 * noise(t * 1.3), 0.795 + tapL + 0.02 * pause, 0.6 - 0.04 * pause, inv);
  armIK(o, -1, -0.1 + 0.015 * noise(t * 1.1 + 4), 0.795 + tapR + 0.02 * pause, 0.6 - 0.04 * pause, inv);
}
function poseTalk(o, k) {
  standBase(o, k); breathe(o, k); weightShift(o, k, 0.6);
  const t = k.t;
  const g1 = noise(t * 1.25 + k.seed * 7), g2 = noise(t * 1.05 + k.seed * 3 + 2);
  o[CH.uRX] = -0.28 - 0.35 * (0.5 + 0.5 * g1); o[CH.uRZ] = -0.18 - 0.1 * g2; o[CH.fRX] = -1.05 - 0.45 * g1; o[CH.fRZ] = 0.25 * g2;
  o[CH.uLX] = -0.22 - 0.3 * (0.5 + 0.5 * g2); o[CH.uLZ] = 0.18 + 0.1 * g1; o[CH.fLX] = -1.0 - 0.4 * g2; o[CH.fLZ] = -0.2 * g1;
  o[CH.chestRY] += 0.08 * g1; o[CH.chestRX] += 0.03;
  o[CH.headRX] += 0.07 * Math.sin(t * 4.2); o[CH.headRY] += 0.18 * noise(t * 0.5 + k.seed);
  o[CH.mouth] = clamp((0.5 + 0.5 * Math.sin(t * 16)) * (0.6 + 0.6 * noise(t * 2.7)), 0, 1);
}
function posePoint(o, k) {
  standBase(o, k); breathe(o, k); weightShift(o, k, 0.4);
  const t = k.t;
  o[CH.uRX] = -1.4 + 0.06 * Math.sin(t * 5); o[CH.uRZ] = -0.1; o[CH.fRX] = -0.15; o[CH.fRZ] = 0;
  o[CH.chestRY] -= 0.12;
  // mão esquerda na cintura
  o[CH.uLX] = 0.25; o[CH.uLZ] = 0.62; o[CH.fLX] = -0.35; o[CH.fLZ] = -1.55;
  // de vez em quando vira para a "plateia" e fala
  const P = 6, f = (t + k.seed * P) % P;
  const e = f > 3.5 ? sstep(3.5, 4, f) * (1 - sstep(5.4, 6, f)) : 0;
  o[CH.headRX] = -0.1; o[CH.headRY] = 0.12 + 0.55 * e;
  o[CH.mouth] = e * clamp(0.5 + 0.5 * Math.sin(t * 15), 0, 1);
}
function poseDrink(o, k) {
  standBase(o, k); breathe(o, k); weightShift(o, k); lookAround(o, k, 0.5);
  // mão esquerda no bolso
  o[CH.uLX] = 0.12; o[CH.uLZ] = 0.16; o[CH.fLX] = -0.35;
  const P = 5.5, f = (k.st + 1.2) % P;
  const sip = sstep(2.6, 3.3, f) * (1 - sstep(4.3, 5.0, f));
  const inv = chestInverse(o);
  armIK(o, -1, lerp(-0.13, -0.075, sip), lerp(1.13, 1.565, sip), lerp(0.22, 0.14, sip), inv, [0.6, -1, -0.1]);
  o[CH.headRX] -= 0.2 * sip; o[CH.headRY] *= 1 - sip;
  o[CH.mugTilt] = 0.75 * sip;
  o[CH.mug] = 1;
}
function poseWave(o, k) {
  standBase(o, k); breathe(o, k); weightShift(o, k, 0.5);
  const t = k.st;
  o[CH.uRZ] = -2.55; o[CH.uRX] = -0.25; o[CH.fRX] = -0.2; o[CH.fRZ] = -0.25 + 0.5 * Math.sin(t * 10);
  o[CH.headRZ] = 0.08; o[CH.headRX] = -0.05; o[CH.chestRZ] = 0.04;
  o[CH.mouth] = 0.35;
}
function poseCheer(o, k) {
  standBase(o, k);
  const t = k.st;
  const j = Math.max(0, Math.sin(t * 7.5)), air = Math.pow(j, 0.8), land = 1 - j;
  o[CH.rootY] = 0.15 * air;
  o[CH.tLX] = -0.5 * air; o[CH.tRX] = -0.5 * air; o[CH.sLX] = 0.9 * air; o[CH.sRX] = 0.9 * air;
  o[CH.hipsY] = -0.05 * land * sstep(0, 0.3, t);
  o[CH.uLZ] = 2.7 + 0.12 * Math.sin(t * 15); o[CH.uRZ] = -2.7 - 0.12 * Math.sin(t * 15);
  o[CH.uLX] = -0.15; o[CH.uRX] = -0.15;
  o[CH.fLZ] = 0.35 * Math.sin(t * 7.5); o[CH.fRZ] = -0.35 * Math.sin(t * 7.5);
  o[CH.headRX] = -0.25; o[CH.mouth] = 0.9;
}
const POSES = { idle: poseIdle, walk: (o, k) => poseLoco(o, k, false), run: (o, k) => poseLoco(o, k, true), sit: poseSit, type: poseType,
  talk: poseTalk, point: posePoint, drink: poseDrink, wave: poseWave, cheer: poseCheer };

// objetos por cima da pose (qualquer estado)
function propOverlay(o, k, state) {
  const p = k.prop;
  if (p === 'laptop' || p === 'terminal') { if (SEATED.has(state)) o[CH.lap] = 1; }
  else if (p === 'mug') {
    o[CH.mug] = 1;
    if (state !== 'drink' && state !== 'cheer' && state !== 'wave') armIK(o, -1, -0.13, 0.1, 0.22, null, [0.6, -1, -0.1]);
  } else if (p === 'papers') {
    o[CH.paper] = 1;
    if (state !== 'cheer' && state !== 'wave') {
      armIK(o, 1, 0.11, 0.15, 0.25, null); armIK(o, -1, -0.11, 0.15, 0.25, null);
      o[CH.headRX] = Math.max(o[CH.headRX], 0.3);
    }
  }
}

// ---------------------------------------------------------------- fábrica
const _qm = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _et = new THREE.Euler();
function createCharacter(opts, ctx) {
  const a = makeAppearance(opts);
  const seedN = (hashStr(String(opts.seed ?? opts.name ?? '')) % 1000) / 1000;
  const entry = acquireGeometry(a);

  // ossos
  const bones = BONES.map(([name]) => { const b = new THREE.Bone(); b.name = name; return b; });
  BONES.forEach(([, parent, x, y, z], i) => {
    const b = bones[i];
    if (parent < 0) b.position.set(x, y, z);
    else { const pr = BONES[parent]; b.position.set(x - pr[2], y - pr[3], z - pr[4]); bones[parent].add(b); }
  });
  const mesh = new THREE.SkinnedMesh(entry.geo, MAT);
  mesh.name = 'personagem:malha';
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.scale.setScalar(a.scale);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.3);   // cobre todas as poses (culling barato)
  const Bn = Object.fromEntries(BONES.map(([n], i) => [n, bones[i]]));

  const group = new THREE.Group();
  group.name = `personagem:${a.kind}`;
  group.add(mesh);
  const height = 1.9 * a.scale;

  // rótulos
  const LBL = { player: { bg: '#1f3a5f', fg: '#ffffff' }, employee: { bg: '#fbf8f1', fg: '#1f2a36', border: '#1f3a5f' }, subagent: { bg: '#d9a441', fg: '#1f2a36', border: '#1f2a36' } }[a.kind];
  let nameTag = null, bubble = null, bubbleT = 0;
  const makeTag = n => {
    const t = ctx.makeLabel(String(n).slice(0, 40), { size: 0.19, bg: LBL.bg, fg: LBL.fg, border: LBL.border ?? null });
    t.position.y = height + 0.06; t.name = 'personagem:crachá';
    group.add(t);
    return t;
  };
  if (opts.name && ctx.makeLabel) nameTag = makeTag(opts.name);

  // estado
  let state = 'idle', stateOpts = {}, stateTime = 0, pending = null;
  let carry = null;                 // objeto carregado (setProp)
  let yawTarget = null, path = null, onArrive = null, moveSpeed = 1.35;
  let t = seedN * 50, spd = 0, phase = 0, lastX = null, lastZ = 0;
  let animAcc = 0, blinkT = 1 + seedN * 3, blinkOn = 0, glowT = 0, glowOn = true;
  let emoteTimer = 0, emoteBack = null, disposed = false;
  const from = new Float32Array(NCH), to = new Float32Array(NCH), out = new Float32Array(NCH);
  let fade = 1, fadeDur = 0.25;
  const k = { t: 0, st: 0, spd: 0, ph: 0, seed: seedN, armOut: a.armOut, prop: null };
  const farDist = ctx.quality?.npcAnimDist ?? 28;

  const propFor = () => (stateOpts && stateOpts.prop !== undefined ? stateOpts.prop : (DEFAULT_PROP[state] ?? carry));

  function enter(s, o) {
    if (s !== state) {
      from.set(out); fade = 0;
      fadeDur = SEATED.has(s) !== SEATED.has(state) ? 0.42 : (LOCO.has(s) && LOCO.has(state)) ? 0.3 : 0.24;
      state = s; stateTime = 0;
    }
    stateOpts = o || {};
    if (stateOpts.prop !== undefined && stateOpts.prop !== null && !PROPS.has(stateOpts.prop)) {
      console.warn(`[personagens] objeto desconhecido: ${stateOpts.prop}`); stateOpts = { ...stateOpts, prop: null };
    }
    if (stateOpts.yaw !== undefined && stateOpts.yaw !== null) yawTarget = stateOpts.yaw;
    if (stateOpts.facing) ch.lookAt(stateOpts.facing.x, stateOpts.facing.z);
  }
  function finishPath(ok) {
    path = null;
    const cb = onArrive; onArrive = null;
    if (ok) {
      const p = pending; pending = null;
      if (p) enter(p.s, p.o); else if (LOCO.has(state)) enter('idle', {});
    } else pending = null;
    if (cb) cb(ok);
  }

  function animate(dt) {
    k.t = t; k.st = stateTime; k.spd = spd; k.ph = phase; k.prop = propFor();
    to.fill(0);
    (POSES[state] || poseIdle)(to, k);
    propOverlay(to, k, state);
    if (!SEATED.has(state) && to[CH.hipsY] < 0 && state !== 'cheer') crouch(to, -to[CH.hipsY] * 0.9);
    if (fade < 1) {
      fade = Math.min(1, fade + dt / fadeDur);
      const e = fade * fade * (3 - 2 * fade);
      for (let i = 0; i < NCH; i++) out[i] = from[i] + (to[i] - from[i]) * e;
    } else out.set(to);
    apply(dt);
  }
  function apply(dt) {
    const o = out;
    Bn.root.position.y = o[CH.rootY];
    Bn.hips.position.set(o[CH.hipsX], HIP_Y + o[CH.hipsY], o[CH.hipsZ]);
    Bn.hips.rotation.set(o[CH.hipsRX], o[CH.hipsRY], o[CH.hipsRZ]);
    Bn.chest.rotation.set(o[CH.chestRX], o[CH.chestRY], o[CH.chestRZ]);
    Bn.head.rotation.set(o[CH.headRX], o[CH.headRY], o[CH.headRZ]);
    Bn.uArmL.rotation.set(o[CH.uLX], o[CH.uLY], o[CH.uLZ]); Bn.fArmL.rotation.set(o[CH.fLX], 0, o[CH.fLZ]);
    Bn.uArmR.rotation.set(o[CH.uRX], o[CH.uRY], o[CH.uRZ]); Bn.fArmR.rotation.set(o[CH.fRX], 0, o[CH.fRZ]);
    Bn.thighL.rotation.set(o[CH.tLX], 0, o[CH.tLZ]); Bn.shinL.rotation.x = o[CH.sLX];
    Bn.thighR.rotation.set(o[CH.tRX], 0, o[CH.tRZ]); Bn.shinR.rotation.x = o[CH.sRX];
    Bn.mouth.scale.y = 1 + 2.4 * o[CH.mouth];
    // piscar
    Bn.eyes.scale.y = blinkOn > 0 ? 0.12 : 1;
    // objetos
    const sc = v => Math.max(1e-4, v);
    Bn.laptop.scale.setScalar(sc(o[CH.lap]));
    Bn.papers.scale.setScalar(sc(o[CH.paper]));
    Bn.mug.scale.setScalar(sc(o[CH.mug]));
    // caneca sempre em pé (contra-gira a cadeia do braço), inclinando para a boca no gole
    if (o[CH.mug] > 0.001) {
      _qm.copy(Bn.hips.quaternion).multiply(Bn.chest.quaternion).multiply(Bn.uArmR.quaternion).multiply(Bn.fArmR.quaternion).invert();
      Bn.mug.quaternion.copy(_qm).multiply(_qt.setFromEuler(_et.set(-o[CH.mugTilt], 0, 0)));
    }
    // tela: acesa; no 'terminal' pisca
    if (k.prop === 'terminal') {
      if ((glowT -= dt) <= 0) { glowOn = !glowOn; glowT = glowOn ? 0.08 + Math.random() * 0.35 : 0.04 + Math.random() * 0.08; }
    } else glowOn = true;
    Bn.glow.scale.setScalar(glowOn ? 1 : 1e-4);
  }

  const ch = {
    group,
    get state() { return state; },
    get height() { return height; },
    appearance: a,
    setState(s, o = {}) {
      if (!STATES.includes(s)) { console.warn(`[personagens] estado desconhecido: ${s}`); return; }
      emoteTimer = 0; emoteBack = null;
      if (path && !LOCO.has(s)) { pending = { s, o: o || {} }; return; }   // aplica ao chegar
      if (path && LOCO.has(s)) { moveSpeed = s === 'run' ? Math.max(moveSpeed, 3.2) : Math.min(moveSpeed, 1.6); }
      enter(s, o || {});
    },
    // estado temporário; depois volta ao anterior e chama after() (se houver)
    emote(s, secs = 1.8, after) {
      if (!STATES.includes(s) || path) return;
      const back = { s: state, o: stateOpts };
      enter(s, {});
      emoteTimer = secs; emoteBack = () => { enter(back.s, back.o); if (after) after(); };
    },
    setProp(p) { carry = PROPS.has(p) ? p : null; },
    // anda até (x, z) pelo A* do núcleo; onArrive(true) ao chegar, onArrive(false) se interrompido
    walkTo(x, z, cb, o = {}) {
      const fromP = { x: group.position.x, z: group.position.z };
      const p = ctx.findPath ? ctx.findPath(fromP, { x, z }) : [fromP, { x, z }];
      if (onArrive) { const f = onArrive; onArrive = null; f(false); }
      pending = null; emoteTimer = 0; emoteBack = null;
      if (!p || p.length < 2) { path = null; if (cb) cb(!!p); return !!p; }
      path = p.slice(1); onArrive = cb || null;
      moveSpeed = o.run ? 3.2 : (o.speed || 1.35);
      enter(o.run || moveSpeed > 2.6 ? 'run' : 'walk', {});
      return true;
    },
    stop() {
      const had = !!path;
      path = null; pending = null;
      if (onArrive) { const f = onArrive; onArrive = null; f(false); }
      if (had || LOCO.has(state)) enter('idle', {});
    },
    isWalking: () => !!path,
    lookAt(x, z) { yawTarget = Math.atan2(x - group.position.x, z - group.position.z); },
    say(text, o = {}) {
      if (bubble) { ctx.disposeLabel(bubble); bubble = null; }
      if (!text || !ctx.makeLabel) return;
      bubble = ctx.makeLabel(String(text).slice(0, 140), { size: 0.24, tail: true, maxWidth: 420, bg: '#ffffff', border: '#1f2a36' });
      bubble.position.y = height + (nameTag ? 0.3 : 0.1);
      bubble.name = 'personagem:balão';
      group.add(bubble);
      bubbleT = o.ms ? o.ms / 1000 : 0;   // 0 = fica até say(null)
    },
    setName(n) {
      if (!ctx.makeLabel) return;
      if (!n) { if (nameTag) { ctx.disposeLabel(nameTag); nameTag = null; } return; }
      if (nameTag) ctx.setLabel(nameTag, String(n).slice(0, 40)); else nameTag = makeTag(n);
      if (bubble) bubble.position.y = height + 0.3;
    },
    update(dt, camDist = 0) {
      if (!(dt > 0)) dt = 0;
      t += dt; stateTime += dt;
      // balão encolhe quando a câmera encosta no boneco (senão cobre a tela inteira)
      if (bubble) {
        const b = bubble.userData.base || (bubble.userData.base = bubble.scale.clone());
        const k = camDist > 0 ? Math.min(1, Math.max(0.4, camDist / 3.6)) : 1;
        bubble.scale.set(b.x * k, b.y * k, 1);
      }
      // movimento pelo caminho (sempre, mesmo longe)
      if (path && path.length) {
        const tgt = path[0], p = group.position;
        const dx = tgt.x - p.x, dz = tgt.z - p.z, d = Math.hypot(dx, dz);
        const step = moveSpeed * dt;
        if (d <= step) { p.x = tgt.x; p.z = tgt.z; path.shift(); }
        else { p.x += dx / d * step; p.z += dz / d * step; yawTarget = Math.atan2(dx, dz); }
        if (!path.length) finishPath(true);
      }
      if (yawTarget !== null) group.rotation.y = dampAngle(group.rotation.y, yawTarget, 10, dt);
      // velocidade real (serve também para o jogador, que o núcleo move por fora)
      const px = group.position.x, pz = group.position.z;
      if (lastX === null) { lastX = px; lastZ = pz; }
      const moved = Math.hypot(px - lastX, pz - lastZ);
      lastX = px; lastZ = pz;
      const v = dt > 0 && moved < 1.5 ? moved / dt : 0;
      spd += (v - spd) * (1 - Math.exp(-10 * dt));
      phase = (phase + spd * dt / (state === 'run' ? 2.3 : 1.5) * TAU) % (TAU * 1000);
      // emote temporário
      if (emoteTimer > 0 && (emoteTimer -= dt) <= 0) { const f = emoteBack; emoteBack = null; emoteTimer = 0; if (f) f(); }
      // piscar
      if (blinkOn > 0) blinkOn -= dt;
      else if ((blinkT -= dt) <= 0) { blinkOn = 0.12; blinkT = 2 + Math.random() * 3.5; }
      // balão temporário
      if (bubble && bubbleT > 0 && (bubbleT -= dt) <= 0) ch.say(null);
      if (nameTag) nameTag.visible = camDist < 24;
      // pose (LOD: longe, anima a 10 Hz; muito longe, a 5 Hz — o crossfade usa o dt acumulado)
      if (!group.visible) { animAcc += dt; return; }
      animAcc += dt;
      const every = camDist > farDist * 1.8 ? 0.2 : camDist > farDist ? 0.1 : 0;
      if (animAcc >= every) { animate(animAcc); animAcc = 0; }
    },
    _blobScale() { return a.scale * (1 - Math.min(0.5, out[CH.rootY] * 2.2)); },
    dispose() {
      if (disposed) return;
      disposed = true;
      path = null; onArrive = null; pending = null;
      blobs.list.delete(ch);
      if (bubble) { ctx.disposeLabel(bubble); bubble = null; }
      if (nameTag) { ctx.disposeLabel(nameTag); nameTag = null; }
      group.removeFromParent();
      skeleton.dispose();
      releaseGeometry(entry);
    },
  };
  group.userData.character = ch;
  // pose inicial (sem crossfade)
  animate(0); fade = 1; animate(0);
  blobs.list.add(ch);
  ensureBlobCapacity(blobs.list.size);
  return ch;
}

// ---------------------------------------------------------------- install
export function install(api) {
  API = api;
  ensureBlobCapacity(32);
  api.on('update', blobPass);
  api.provideCharacterFactory((opts, ctx) => createCharacter(opts || {}, ctx || {}));
  // emotes do jogador (1–4); o Espaço (acenar) é do núcleo
  const EMOTES = [['Digit1', 'cheer', 2.4, 'comemorar'], ['Digit2', 'drink', 6, 'tomar um café'], ['Digit3', 'point', 3.5, 'apontar'], ['Digit4', 'talk', 3.5, 'discursar']];
  for (const [code, st, secs, help] of EMOTES) {
    if (!api.isKeyFree(code)) continue;
    api.registerKey(code, { label: code.slice(5), help, handler: () => { if (!api.isPanelOpen() && api.player.character) api.player.emote(st, secs); } });
  }
}
