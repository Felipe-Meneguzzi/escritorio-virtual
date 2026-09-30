// ============================================================ colisão por AABB (jogador e câmera)
// Caixas { x0, x1, z0, z1, y0?, y1? } em mundo, num hash espacial de 2 m. Estáticas vêm do layout (paredes finas +
// móveis); features acrescentam as suas com api.addCollider (opção layout:true = some no próximo rebuild).
const CELL = 2;
let boxes = [];                 // todas as caixas vivas
let hash = new Map();           // "cx,cz" -> [box]
const key = (cx, cz) => `${cx},${cz}`;

function insert(b) {
  for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++)
    for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
      const k = key(cx, cz);
      let arr = hash.get(k);
      if (!arr) hash.set(k, arr = []);
      arr.push(b);
    }
}
function remove(b) {
  for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++)
    for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
      const arr = hash.get(key(cx, cz));
      if (arr) { const i = arr.indexOf(b); if (i >= 0) arr.splice(i, 1); }
    }
}

// troca as caixas estáticas (layout) mantendo as dinâmicas persistentes (layout:false)
export function setStatic(list) {
  const keep = boxes.filter(b => b._dyn && !b._layout);
  boxes = []; hash = new Map();
  for (const b of list) { boxes.push(b); insert(b); }
  for (const b of keep) { boxes.push(b); insert(b); }
}

// api.addCollider({x0,x1,z0,z1,y0?,y1?}, { layout=false, solid=true }) → remove()
export function addCollider(box, { layout = false } = {}) {
  const b = { y0: 0, y1: 2.7, ...box, _dyn: true, _layout: layout };
  if (b.x1 < b.x0) [b.x0, b.x1] = [b.x1, b.x0];
  if (b.z1 < b.z0) [b.z0, b.z1] = [b.z1, b.z0];
  boxes.push(b); insert(b);
  let done = false;
  return () => { if (done) return; done = true; remove(b); const i = boxes.indexOf(b); if (i >= 0) boxes.splice(i, 1); };
}

function near(x0, x1, z0, z1) {
  const out = new Set();
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const arr = hash.get(key(cx, cz));
      if (arr) for (const b of arr) out.add(b);
    }
  return out;
}

// empurra um círculo (x, z, raio) para fora das caixas cuja altura corta a faixa [yLo, yHi]. Devolve {x, z, hit}
export function resolveCircle(x, z, r, yLo = 0.05, yHi = 1.7) {
  let hit = false;
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (const b of near(x - r, x + r, z - r, z + r)) {
      if (b.y1 <= yLo || b.y0 >= yHi) continue;
      const px = Math.max(b.x0, Math.min(x, b.x1)), pz = Math.max(b.z0, Math.min(z, b.z1));
      let dx = x - px, dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = moved = true;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2), push = r - d;
        x += dx / d * push; z += dz / d * push;
      } else {   // centro dentro da caixa: sai pelo lado mais perto
        const opts = [[b.x0 - r - x, 0], [b.x1 + r - x, 0], [0, b.z0 - r - z], [0, b.z1 + r - z]];
        opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
        x += opts[0][0]; z += opts[0][1];
      }
    }
    if (!moved) break;
  }
  return { x, z, hit };
}

// ponto dentro de alguma caixa (com folga r)?
export function blockedAt(x, z, r = 0, yLo = 0.05, yHi = 1.7) {
  for (const b of near(x - r, x + r, z - r, z + r)) {
    if (b.y1 <= yLo || b.y0 >= yHi) continue;
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
  }
  return false;
}

// raio 3D (origem o, direção unitária d, até maxT) contra as caixas → menor t de acerto ou Infinity
export function raycast(o, d, maxT) {
  const ex = o.x + d.x * maxT, ez = o.z + d.z * maxT;
  let best = Infinity;
  for (const b of near(Math.min(o.x, ex), Math.max(o.x, ex), Math.min(o.z, ez), Math.max(o.z, ez))) {
    let t0 = 0, t1 = maxT;
    for (const [oa, da, lo, hi] of [[o.x, d.x, b.x0, b.x1], [o.y, d.y, b.y0 ?? 0, b.y1 ?? 2.7], [o.z, d.z, b.z0, b.z1]]) {
      if (Math.abs(da) < 1e-9) { if (oa < lo || oa > hi) { t0 = Infinity; break; } continue; }
      let ta = (lo - oa) / da, tb = (hi - oa) / da;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { t0 = Infinity; break; }
    }
    if (t0 < best) best = t0;
  }
  return best;
}

export const colliderCount = () => boxes.length;
