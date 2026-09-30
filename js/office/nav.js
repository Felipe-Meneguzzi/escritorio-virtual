// ============================================================ navegação dos NPCs na grade do layout (módulo PURO)
// A* 8-direções (sem cortar quina) + "puxar o barbante" (linha de visada) → poucos pontos, caminho natural.
// Tudo em coordenadas de MUNDO ({x, z}); a grade é a do layout.js (célula = 1 m, z de grade = -z do mundo).
import { WALK, cellOf, cellCenter } from './layout.js';

export function makeNav(lay, { walk = WALK } = {}) {
  const g = lay.grid, D = g.length, W = g[0].length;
  const blocked = new Uint8Array(W * D);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) blocked[z * W + x] = walk.has(g[z][x]) ? 0 : 1;
  const extra = new Map();                     // bloqueios dinâmicos (ex.: gaveteiro de uma feature) idx → contagem
  const free = (x, z) => x >= 0 && x < W && z >= 0 && z < D && !blocked[z * W + x] && !extra.get(z * W + x);

  function nearestFree(gx, gz, maxR = 12) {
    if (free(gx, gz)) return [gx, gz];
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (free(gx + dx, gz + dz)) { const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = [gx + dx, gz + dz]; } }
      }
      if (best) return best;
    }
    return null;
  }

  // linha de visada entre dois pontos do mundo: amostra a cada 0,2 m, com folga lateral (raio do boneco)
  function lineOfSight(a, b, radius = 0.22) {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    const nx = -dz / len * radius, nz = dx / len * radius;
    const steps = Math.ceil(len / 0.2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = a.x + dx * t, z = a.z + dz * t;
      for (const [ox, oz] of [[0, 0], [nx, nz], [-nx, -nz]]) {
        const [gx, gz] = cellOf(x + ox, z + oz);
        if (!free(gx, gz)) return false;
      }
    }
    return true;
  }

  // A* → lista de células [[gx,gz],...] ou null
  function astar(s, t) {
    const N = W * D, start = s[1] * W + s[0], goal = t[1] * W + t[0];
    const gS = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const heap = [];   // [f, idx]
    const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    const h = i => { const dx = Math.abs(i % W - t[0]), dz = Math.abs(((i / W) | 0) - t[1]); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
    gS[start] = 0; push(h(start), start);
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    while (heap.length) {
      const [, cur] = pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % W, cz = (cur / W) | 0;
      for (const [dx, dz, cost] of dirs) {
        const nx = cx + dx, nz = cz + dz;
        if (!free(nx, nz)) continue;
        if (dx && dz && (!free(cx + dx, cz) || !free(cx, cz + dz))) continue;   // sem cortar quina
        const ni = nz * W + nx, ng = gS[cur] + cost;
        if (ng < gS[ni]) { gS[ni] = ng; came[ni] = cur; push(ng + h(ni), ni); }
      }
    }
    if (start !== goal && came[goal] < 0) return null;
    const cells = [];
    for (let i = goal; i !== -1; i = i === start ? -1 : came[i]) cells.push([i % W, (i / W) | 0]);
    return cells.reverse();
  }

  // findPath(from, to) → [{x,z}, ...] (começa perto de from, termina EXATAMENTE em to se to for livre) | null
  function findPath(from, to) {
    const s = nearestFree(...cellOf(from.x, from.z));
    const tRaw = cellOf(to.x, to.z);
    const t = nearestFree(...tRaw);
    if (!s || !t) return null;
    const cells = astar(s, t);
    if (!cells) return null;
    const pts = cells.map(([x, z]) => cellCenter(x, z));
    const end = (t[0] === tRaw[0] && t[1] === tRaw[1]) ? { x: to.x, z: to.z } : pts[pts.length - 1];
    pts[pts.length - 1] = end;
    const startPt = free(...cellOf(from.x, from.z)) ? { x: from.x, z: from.z } : pts[0];
    pts[0] = startPt;
    // puxar o barbante
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !lineOfSight(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  return {
    W, D,
    isFree: (x, z) => free(...cellOf(x, z)),
    cellFree: free,
    nearestFree: (x, z) => { const c = nearestFree(...cellOf(x, z)); return c ? cellCenter(...c) : null; },
    lineOfSight, findPath,
    // bloqueio dinâmico de células (móvel de feature que o NPC deve contornar) → função que libera
    block(x, z) {
      const [gx, gz] = cellOf(x, z);
      if (gx < 0 || gx >= W || gz < 0 || gz >= D) return () => {};
      const i = gz * W + gx;
      extra.set(i, (extra.get(i) || 0) + 1);
      let done = false;
      return () => { if (done) return; done = true; const v = (extra.get(i) || 1) - 1; if (v <= 0) extra.delete(i); else extra.set(i, v); };
    },
  };
}
