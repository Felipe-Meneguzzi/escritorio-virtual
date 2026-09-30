// ============================================================ bonecos: registro da fábrica + PLACEHOLDER
// CONTRATO (ARCH.md §Personagens). O pacote "personagens" registra a fábrica de verdade com
//   api.provideCharacterFactory((opts, ctx) => personagem)
// e api.createCharacter(opts) passa a usá-la. Até lá (ou se ela falhar) vale o placeholder abaixo — cápsula + caixas,
// com a MESMA interface, para os outros pacotes testarem.
//
// opts: { skin: 'player'|'employee'|'subagent', seed (string|number), colors?: {suit, shirt, tie, skin, hair, pants},
//         name?: string (crachá flutuante), manual?: bool (núcleo NÃO adiciona à cena nem chama update) }
// personagem: { group, state, setState(state, opts?), walkTo(x, z, onArrive?, opts?), lookAt(x, z), say(text|null, opts?),
//               update(dt, camDist?), dispose(), isWalking?(), stop?() }
// estados: 'idle','walk','run','sit','type','talk','point','drink','wave','cheer'
// ctx (2º argumento da fábrica): { findPath(from, to), makeLabel, setLabel, disposeLabel, quality, hashStr, rng }
import * as THREE from 'three';
import { hashStr, rng, dampAngle } from './util.js';
import { makeLabel, setLabel, disposeLabel } from './labels.js';

export const STATES = ['idle', 'walk', 'run', 'sit', 'type', 'talk', 'point', 'drink', 'wave', 'cheer'];

// ---------------- placeholder
const geo = {
  body: new THREE.CapsuleGeometry(0.2, 0.55, 3, 8),
  head: new THREE.BoxGeometry(0.28, 0.3, 0.28),
  arm: new THREE.BoxGeometry(0.09, 0.5, 0.09),
  leg: new THREE.BoxGeometry(0.12, 0.62, 0.12),
  tie: new THREE.BoxGeometry(0.06, 0.3, 0.02),
  eye: new THREE.BoxGeometry(0.04, 0.04, 0.02),
  blob: new THREE.CircleGeometry(0.34, 12),
};
for (const g of Object.values(geo)) g.userData.shared = true;
geo.arm.translate(0, -0.25, 0);   // pivô no ombro
geo.leg.translate(0, -0.31, 0);   // pivô no quadril
geo.blob.rotateX(-Math.PI / 2);
const mats = new Map();
const mat = c => { if (!mats.has(c)) { const m = new THREE.MeshLambertMaterial({ color: c }); m.userData.shared = true; mats.set(c, m); } return mats.get(c); };
const blobMat = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.22, depthWrite: false });
blobMat.userData.shared = true;

const SKIN_COLORS = {
  player: { suit: '#1f2f4f', shirt: '#f4f1ea', tie: '#a3242a', skin: '#e0b48f', pants: '#1a2742' },
  employee: { suit: '#3a3f47', shirt: '#eef2f5', tie: '#2c5d8f', skin: '#d9a77f', pants: '#2c3036' },
  subagent: { suit: '#6b7686', shirt: '#dfe8ef', tie: '#d9a441', skin: '#c99670', pants: '#4a5260' },
};

export function createPlaceholder(opts = {}, ctx = {}) {
  const r = rng(hashStr(String(opts.seed ?? opts.name ?? Math.random())));
  const skin = SKIN_COLORS[opts.skin] || SKIN_COLORS.employee;
  const C = { ...skin, ...(opts.colors || {}) };
  if (!opts.colors?.skin) C.skin = ['#f1c9a5', '#e0b48f', '#c99670', '#a8744f', '#7a5236'][Math.floor(r() * 5)];
  const scale = opts.skin === 'subagent' ? 0.86 : 1;
  const group = new THREE.Group();
  group.name = `personagem:${opts.skin || 'employee'}`;
  const rig = new THREE.Group(); group.add(rig);
  rig.scale.setScalar(scale);
  const body = new THREE.Mesh(geo.body, mat(C.suit)); body.position.y = 1.02; rig.add(body);
  const shirt = new THREE.Mesh(geo.tie, mat(C.shirt)); shirt.scale.set(2.2, 0.8, 1); shirt.position.set(0, 1.28, 0.19); rig.add(shirt);
  const tie = new THREE.Mesh(geo.tie, mat(C.tie)); tie.position.set(0, 1.18, 0.205); rig.add(tie);
  const head = new THREE.Mesh(geo.head, mat(C.skin)); head.position.y = 1.62; rig.add(head);
  for (const sx of [-0.065, 0.065]) { const e = new THREE.Mesh(geo.eye, mat('#1b1b1b')); e.position.set(sx, 1.65, 0.145); rig.add(e); }
  const armL = new THREE.Mesh(geo.arm, mat(C.suit)); armL.position.set(-0.27, 1.42, 0); rig.add(armL);
  const armR = new THREE.Mesh(geo.arm, mat(C.suit)); armR.position.set(0.27, 1.42, 0); rig.add(armR);
  const legL = new THREE.Mesh(geo.leg, mat(C.pants)); legL.position.set(-0.1, 0.66, 0); rig.add(legL);
  const legR = new THREE.Mesh(geo.leg, mat(C.pants)); legR.position.set(0.1, 0.66, 0); rig.add(legR);
  const blob = new THREE.Mesh(geo.blob, blobMat); blob.position.y = 0.012; blob.renderOrder = 1; group.add(blob);

  let nameTag = null;
  if (opts.name) { nameTag = makeLabel(opts.name, { size: 0.2, bg: '#1f3a5f', fg: '#fff', border: null }); nameTag.position.y = 1.95 * scale; group.add(nameTag); }
  let bubble = null, bubbleT = 0;

  let state = 'idle', t = r() * 10, yawTarget = null, path = null, onArrive = null, speed = 1.35, stateOpts = {};
  const ch = {
    group,
    get state() { return state; },
    setState(s, o = {}) {
      if (!STATES.includes(s)) { console.warn(`[escritório] estado de personagem desconhecido: ${s}`); return; }
      state = s; stateOpts = o || {};
      if (o.yaw !== undefined) yawTarget = o.yaw;
      if (o.facing) ch.lookAt(o.facing.x, o.facing.z);
    },
    // anda até (x, z) pelo caminho da navegação (A*); onArrive(true) ao chegar, onArrive(false) se interrompido
    walkTo(x, z, cb, o = {}) {
      const from = { x: group.position.x, z: group.position.z };
      const p = ctx.findPath ? ctx.findPath(from, { x, z }) : [from, { x, z }];
      if (onArrive) { const f = onArrive; onArrive = null; f(false); }
      if (!p || p.length < 2) { path = null; if (cb) cb(!!p); return !!p; }
      path = p.slice(1); onArrive = cb || null;
      speed = o.run ? 3.2 : (o.speed || 1.35);
      state = o.run ? 'run' : 'walk';
      return true;
    },
    stop() { path = null; if (onArrive) { const f = onArrive; onArrive = null; f(false); } if (state === 'walk' || state === 'run') state = 'idle'; },
    isWalking: () => !!path,
    lookAt(x, z) { yawTarget = Math.atan2(x - group.position.x, z - group.position.z); },
    say(text, o = {}) {
      if (bubble) { disposeLabel(bubble); bubble = null; }
      if (!text) return;
      bubble = makeLabel(String(text).slice(0, 140), { size: 0.24, tail: true, maxWidth: 420, bg: '#ffffff', border: '#1f2a36' });
      bubble.position.y = (opts.name ? 2.15 : 1.98) * scale;
      group.add(bubble);
      bubbleT = o.ms ? o.ms / 1000 : 0;   // 0 = fica até say(null)
    },
    update(dt) {
      t += dt;
      // movimento pelo caminho
      if (path && path.length) {
        const tgt = path[0], p = group.position;
        const dx = tgt.x - p.x, dz = tgt.z - p.z, d = Math.hypot(dx, dz);
        const step = speed * dt;
        if (d <= step) { p.x = tgt.x; p.z = tgt.z; path.shift(); }
        else { p.x += dx / d * step; p.z += dz / d * step; yawTarget = Math.atan2(dx, dz); }
        if (!path.length) {
          path = null; state = 'idle';
          if (onArrive) { const f = onArrive; onArrive = null; f(true); }
        }
      }
      if (yawTarget !== null) group.rotation.y = dampAngle(group.rotation.y, yawTarget, 10, dt);
      // pose
      const moving = state === 'walk' || state === 'run';
      const f = state === 'run' ? 11 : 7.5, sw = Math.sin(t * f) * (state === 'run' ? 0.9 : 0.55);
      let aL = 0, aR = 0, lL = 0, lR = 0, y = 0, lean = 0, aLz = 0, aRz = 0;
      if (moving) { aL = sw; aR = -sw; lL = -sw; lR = sw; y = Math.abs(Math.sin(t * f)) * 0.04; lean = state === 'run' ? 0.12 : 0.03; }
      else if (state === 'sit' || state === 'type') { lL = lR = -1.45; y = -0.42; if (state === 'type') { aL = aR = -1.2 + Math.sin(t * 18) * 0.08; aR = -1.2 + Math.cos(t * 17) * 0.08; } }
      else if (state === 'talk') { aR = -0.5 + Math.sin(t * 5) * 0.35; y = Math.abs(Math.sin(t * 3)) * 0.015; }
      else if (state === 'point') { aR = -2.2; }
      else if (state === 'drink') { aR = -2.0 + Math.sin(t * 1.5) * 0.15; }
      else if (state === 'wave') { aRz = 2.6 + Math.sin(t * 9) * 0.35; }
      else if (state === 'cheer') { aLz = -2.7; aRz = 2.7; y = Math.abs(Math.sin(t * 6)) * 0.12; }
      else { aL = Math.sin(t * 1.3) * 0.04; aR = -aL; y = Math.sin(t * 1.6) * 0.006; }
      armL.rotation.set(aL, 0, aLz); armR.rotation.set(aR, 0, aRz);
      legL.rotation.x = lL; legR.rotation.x = lR;
      rig.position.y = y; rig.rotation.x = lean;
      if (bubble && bubbleT > 0 && (bubbleT -= dt) <= 0) ch.say(null);
    },
    setName(n) { if (nameTag) setLabel(nameTag, n); },
    dispose() {
      path = null; onArrive = null;
      if (bubble) disposeLabel(bubble);
      if (nameTag) disposeLabel(nameTag);
      group.removeFromParent();
    },
  };
  group.rotation.y = 0;
  return ch;
}

// ---------------- registro
let factory = null;
export function provideCharacterFactory(fn) {
  if (typeof fn !== 'function') throw new Error('provideCharacterFactory precisa de uma função (opts, ctx) => personagem');
  factory = fn;
}
export const hasCustomFactory = () => !!factory;

export function buildCharacter(opts, ctx) {
  if (factory) {
    try {
      const c = factory(opts, ctx);
      if (c && c.group && typeof c.update === 'function') return c;
      console.error('[escritório] fábrica de personagens devolveu objeto sem group/update — usando placeholder');
    } catch (err) { console.error('[escritório] fábrica de personagens falhou — usando placeholder:', err); }
  }
  return createPlaceholder(opts, ctx);
}
