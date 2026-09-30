// ============================================================ LAYOUT do prédio (módulo PURO: sem THREE, sem DOM)
// Fonte única da planta do escritório. Testável com node (tests/layout.test.mjs). Portado de layout.py (viabilidade).
//
// GRADE: 1 célula = 1 m. Coordenadas de grade (gx, gz): gx cresce para o leste, gz cresce para o "norte" (fundo).
// MUNDO (Three.js): X = gx, Z = -gz  →  a célula (gx, gz) ocupa x∈[gx, gx+1], z∈[-(gz+1), -gz].
//   A porta de entrada fica em z≈0 e o prédio cresce para z NEGATIVO. Quem entra olha para -Z (yaw = π) e vê
//   +X à direita (copa à esquerda, quadro de anotações à direita). Toda saída deste módulo já vem em MUNDO,
//   exceto `grid` / `cells` (grade crua) e os campos com sufixo `Cell`.
// yaw: rotação em Y de um objeto cuja FRENTE é +Z (padrão dos bonecos). yaw = atan2(dx, dz) da direção olhada.
//   face 'S' (+Z, para a entrada) = 0 · 'N' (-Z, fundo) = π · 'E' (+X) = π/2 · 'W' (-X) = -π/2
//
// Caracteres da grade:
//   #  parede            =  vidro+persiana (porta D)   |  divisória baixa (recepção ↔ área aberta)
//   E  porta de vidro da entrada   D  vão de porta de sala   R recepção   S sofá   P planta
//   c  ilha de baias     h  cadeira (andável)   K copa (balcão)   C cafeteira   O bebedouro   F geladeira
//   Q  QUADRO de anotações (na parede)   X copiadora   T mesa de reunião   W quadro branco (na parede)
//   _  vaga "Nova sala" (andável)   k  depósito (fechado)   B banheiro   .  piso andável
export const HALL = 3;          // corredor lateral
export const RW = 8, RD = 7;    // sala: tamanho externo com paredes (vizinhas dividem parede → passo RW-1 / RD-1)
export const REC_D = 7, BULL_D = 12, COR_D = 3;
export const WALL_H = 2.7;      // altura das paredes (= forro)
export const CEIL_H = 2.7;
export const WALL_T = 0.16;     // espessura renderizada/colidível das paredes (a grade é de 1 m)
export const PART_H = 1.25;     // divisória baixa '|'
export const DOOR_H = 2.12;     // altura do vão das portas (acima vem a verga)

export const WALLISH = new Set(['#', '=', '|', 'W', 'Q', 'E']);
export const WALK = new Set(['.', 'D', 'E', 'h', '_']);           // navegação dos NPCs
export const FURNITURE = new Set(['R', 'S', 'P', 'K', 'C', 'O', 'F', 'X', 'T', 'c', 'B', 'k']);
// altura de colisão/placeholder por móvel (m)
export const FURN_H = { R: 1.1, S: 0.8, P: 1.3, K: 0.95, C: 1.35, O: 1.25, F: 1.85, X: 1.2, T: 0.76, c: 1.25, B: 2.1, k: 2.7, h: 0.9 };
export const WALL_KIND = { '#': 'wall', 'W': 'wall', 'Q': 'wall', '=': 'glass', '|': 'partition', 'E': 'entrance' };
const FACE_YAW = { N: Math.PI, S: 0, E: Math.PI / 2, W: -Math.PI / 2 };
export const faceYaw = f => FACE_YAW[f] ?? 0;

export function colsFor(nSlots) { return nSlots <= 6 ? 3 : nSlots <= 16 ? 4 : 5; }

// ponto em coordenadas "de layout.py" (x, z com z crescendo para o fundo) → mundo
const W_ = (x, z, extra) => ({ x, z: -z, ...extra });
// retângulo de células inclusivo → caixa em mundo
const R_ = (x0, z0, x1, z1) => ({ x0, x1: x1 + 1, z0: -(z1 + 1), z1: -z0 });

// generateLayout(ids) — ids = pastas das salas NA ORDEM do office.json. Determinístico.
export function generateLayout(ids = []) {
  const n = ids.length;
  const slots = n + 1;                                   // +1 vaga "Nova sala"
  const cols = colsFor(slots);
  const rows = Math.ceil(slots / cols);
  const W = 2 + 2 * HALL + cols * (RW - 1) + 1;
  let z = 1 + REC_D + 1 + BULL_D;
  const band0 = z;
  const rowZ = [], corridors = [];
  for (let r = 0; r < rows; r++) {
    if (r === 0) { rowZ.push([z, 'S']); z += RD - 1; }
    else if (r % 2 === 1) { rowZ.push([z, 'N']); z += RD - 1; corridors.push([z + 1, z + COR_D]); z += COR_D + 1; }
    else { rowZ.push([z, 'S']); z += RD - 1; }
  }
  const D = z + 1;
  const g = Array.from({ length: D }, () => Array(W).fill(' '));
  const put = (x, zz, ch) => { if (x >= 0 && x < W && zz >= 0 && zz < D) g[zz][x] = ch; };
  const rect = (x0, z0, x1, z1, ch) => { for (let zz = z0; zz <= z1; zz++) for (let x = x0; x <= x1; x++) put(x, zz, ch); };
  const box = (x0, z0, x1, z1, ch = '#') => {
    for (let x = x0; x <= x1; x++) { put(x, z0, ch); put(x, z1, ch); }
    for (let zz = z0; zz <= z1; zz++) { put(x0, zz, ch); put(x1, zz, ch); }
  };

  rect(0, 0, W - 1, D - 1, '#');
  rect(1, 1, W - 2, band0 - 1, '.');
  const cx = Math.floor(W / 2);
  const Z = { reception: [], copa: [], quadro: [], copier: [], cubicles: [], wander: [] };
  // ---------------- recepção
  for (let x = cx - 1; x <= cx + 1; x++) put(x, 0, 'E');
  rect(cx + 3, 4, cx + 6, 4, 'R'); put(cx + 3, 5, 'R');            // balcão em L da recepcionista
  put(cx + 5, 5, 'h');
  Z.reception.push(W_(cx + 5.5, 5.5, { yaw: faceYaw('S'), kind: 'recepcionista' }));
  rect(2, 2, 5, 2, 'S'); rect(2, 3, 2, 4, 'S');                     // sofá em L
  Z.reception.push(W_(3.5, 3.5, { yaw: faceYaw('E'), kind: 'sofa' }), W_(4.5, 3.5, { yaw: faceYaw('N'), kind: 'sofa' }));
  for (const [px, pz] of [[1, 1], [W - 2, 1], [1, REC_D], [W - 2, REC_D]]) put(px, pz, 'P');
  const partZ = 1 + REC_D;
  rect(1, partZ, W - 2, partZ, '|');
  for (let x = cx - 2; x <= cx + 2; x++) put(x, partZ, '.');
  // ---------------- área aberta
  const b0 = partZ + 1, b1 = band0 - 1;
  rect(1, b0, 1, b0 + 4, 'K'); put(1, b0 + 1, 'C'); put(1, b0 + 5, 'O'); put(1, b0 + 6, 'F');
  Z.copa = [1, 3, 5].map(i => W_(2.5, b0 + i + 0.5, { yaw: faceYaw('W') }));
  for (let zz = b0 + 1; zz <= b0 + 4; zz++) put(W - 1, zz, 'Q');
  Z.quadro = [1, 2, 3, 4].map(i => W_(W - 2.5, b0 + i + 0.5, { yaw: faceYaw('E') }));
  put(W - 2, b1 - 1, 'X'); Z.copier = [W_(W - 3.5, b1 - 0.5, { yaw: faceYaw('E') })];
  put(W - 2, b0, 'P'); put(1, b1, 'P');
  const xStart = 5, xEnd = W - 6;
  const ncl = Math.max(1, Math.floor((xEnd - xStart + 2) / 6));
  const off = xStart + Math.floor(((xEnd - xStart + 2) - ncl * 6) / 2);
  const cubicleIslands = [];
  for (const rz of [b0 + 2, b0 + 7]) {
    if (rz + 3 > b1 - 1) continue;
    for (let k = 0; k < ncl; k++) {
      const x0 = off + k * 6;
      rect(x0, rz + 1, x0 + 3, rz + 2, 'c');
      cubicleIslands.push(R_(x0, rz + 1, x0 + 3, rz + 2));
      for (const dx of [0, 2]) {
        put(x0 + dx + 1, rz, 'h'); put(x0 + dx + 1, rz + 3, 'h');
        Z.cubicles.push(W_(x0 + dx + 1.5, rz + 0.5, { yaw: faceYaw('N') }), W_(x0 + dx + 1.5, rz + 3.5, { yaw: faceYaw('S') }));
      }
    }
  }
  // ---------------- faixa de salas
  const innerX0 = 1 + HALL;
  const slotList = [];
  rowZ.forEach(([zs, door], r) => { for (let c = 0; c < cols; c++) slotList.push([r, c, zs, door]); });
  const cellRooms = [], later = [], storageCells = [];
  slotList.forEach(([r, c, zs, door], i) => {
    const x0 = innerX0 + c * (RW - 1), z0 = zs, x1 = x0 + RW - 1, z1 = z0 + RD - 1;
    const used = i < n, isNew = i === n;
    if (i > n) {                                           // vaga extra da última fileira: depósito
      rect(x0, z0, x1, z1, '#'); rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, 'k');
      storageCells.push({ slot: i, row: r, col: c, rect: [x0, z0, x1, z1] });
      return;
    }
    box(x0, z0, x1, z1, '#');
    rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1, used ? '.' : '_');
    const dz = door === 'S' ? z0 : z1;
    for (let x = x0 + 1; x < x1; x++) put(x, dz, '=');
    const dx0 = x0 + 3;
    put(dx0, dz, 'D'); put(dx0 + 1, dz, 'D');
    const room = { slot: i, row: r, col: c, id: used ? ids[i] : null, isNew, side: door,
      rectCell: [x0, z0, x1, z1], interiorCell: [x0 + 1, z0 + 1, x1 - 1, z1 - 1], doorCells: [[dx0, dz], [dx0 + 1, dz]],
      dz, dx0, zones: {} };
    cellRooms.push(room);
    later.push(room);
  });
  for (const room of later) {
    const door = room.side;
    const [ix0, iz0, ix1, iz1] = room.interiorCell;
    const [, rz0, , rz1] = room.rectCell;
    const near = door === 'S' ? iz0 : iz1, far = door === 'S' ? iz1 - 1 : iz0 + 1;
    const tz = door === 'S' ? [iz0 + 1, iz0 + 2] : [iz1 - 2, iz1 - 1];
    const bz = door === 'S' ? rz1 : rz0;                    // quadro branco na parede oposta à porta
    const boardRow = door === 'S' ? iz1 : iz0;
    if (room.id !== null) {                                // sala ocupada: mesa 4x2, 6 cadeiras, quadro branco
      rect(ix0 + 1, tz[0], ix0 + 4, tz[1], 'T');
      for (const x of [ix0 + 1, ix0 + 4]) put(x, near, 'h');
      for (let x = ix0 + 1; x <= ix0 + 4; x++) put(x, far, 'h');
      for (let x = ix0 + 1; x <= ix0 + 4; x++) put(x, bz, 'W');
    }
    const seats = [];
    for (const x of [ix0 + 1, ix0 + 4]) seats.push(W_(x + 0.5, near + 0.5, { yaw: faceYaw(door === 'S' ? 'N' : 'S') }));
    for (let x = ix0 + 1; x <= ix0 + 4; x++) seats.push(W_(x + 0.5, far + 0.5, { yaw: faceYaw(door === 'S' ? 'S' : 'N') }));
    room.zones = {
      seats,
      board: [1, 2, 3, 4].map(k => W_(ix0 + k + 0.5, boardRow + 0.5, { yaw: faceYaw(door === 'S' ? 'N' : 'S') })),
      pace: [], work: [],
      files: [W_(ix1 + 0.5, (iz0 + iz1) / 2 + 0.5, { yaw: faceYaw('E'), kind: 'gaveteiro' })],   // olha para o gaveteiro (parede E)
      table: R_(ix0 + 1, tz[0], ix0 + 4, tz[1]),
      whiteboard: {
        x0: ix0 + 1, x1: ix0 + 5, y0: 0.9, y1: 2.0,
        z: door === 'S' ? -(bz + 0.5) + WALL_T / 2 : -(bz + 0.5) - WALL_T / 2,
        yaw: door === 'S' ? 0 : Math.PI,                    // frente do quadro olha para dentro da sala
      },
    };
  }
  // corredores laterais e entre fileiras
  const zmax = D - 2;
  rect(1, band0, HALL, zmax, '.');
  rect(W - 1 - HALL, band0, W - 2, zmax, '.');
  for (const [za, zb] of corridors) rect(1, za, W - 2, zb, '.');
  put(1, zmax, 'B'); put(W - 2, zmax, 'B');
  // pace/work: bordas livres das salas ocupadas (agora que a grade está pronta)
  for (const room of later) {
    const [ix0, iz0, ix1, iz1] = room.interiorCell;
    const doorIn = room.side === 'S' ? iz0 : iz1;
    for (let zz = iz0; zz <= iz1; zz++) for (const x of [ix0, ix1]) {
      if (g[zz][x] !== '.' && g[zz][x] !== '_') continue;
      const p = W_(x + 0.5, zz + 0.5, { yaw: faceYaw(x === ix0 ? 'E' : 'W') });
      room.zones.pace.push(p);
      if (zz !== doorIn) room.zones.work.push(p);
    }
  }
  const walkCell = (x, zz) => x >= 0 && x < W && zz >= 0 && zz < D && WALK.has(g[zz][x]);
  const wander = [];
  for (let zz = 0; zz < D; zz++) for (let x = 0; x < W; x++) {
    if (g[zz][x] !== '.') continue;
    const inHall = x <= HALL || x >= W - 1 - HALL || corridors.some(([a, b]) => a <= zz && zz <= b);
    if ((zz >= band0 && inHall) || (zz > 1 && zz < partZ)) wander.push(W_(x + 0.5, zz + 0.5));
  }
  Z.wander = wander.filter((_, i) => i % 7 === 0).slice(0, 80);

  // ---------------- saída em MUNDO
  const doorOf = r => {
    const [dx0, dz] = [r.dx0, r.dz];
    const S = r.side === 'S';
    return {
      side: r.side,
      x: dx0 + 1, z: -(dz + 0.5),                           // centro do vão (na linha da parede)
      width: 2,
      cells: r.doorCells.map(([x, zz]) => W_(x + 0.5, zz + 0.5)),
      outside: W_(dx0 + 1, S ? dz - 0.5 : dz + 1.5),
      inside: W_(dx0 + 1, S ? dz + 1.5 : dz - 0.5),
      yaw: faceYaw(S ? 'N' : 'S'),                          // direção de quem ENTRA
    };
  };
  const roomOut = r => {
    const [x0, z0, x1, z1] = r.rectCell, [ix0, iz0, ix1, iz1] = r.interiorCell;
    return {
      slot: r.slot, row: r.row, col: r.col, id: r.id, isNew: r.isNew,
      rect: R_(x0, z0, x1, z1), interior: R_(ix0, iz0, ix1, iz1),
      center: W_((ix0 + ix1 + 1) / 2, (iz0 + iz1 + 1) / 2),
      door: doorOf(r), glass: [r.side], zones: r.zones,
      rectCell: r.rectCell, interiorCell: r.interiorCell,
    };
  };
  const rooms = cellRooms.map(roomOut);
  const occupied = rooms.filter(r => r.id !== null);
  const newSlot = rooms.find(r => r.isNew) || null;
  const storage = storageCells.map(s => ({ ...s, rect: R_(...s.rect), rectCell: s.rect }));
  const zones = {
    entrance: { x: cx + 0.5, z: -1.5, yaw: faceYaw('N'), outside: { x: cx + 0.5, z: 0.9 }, door: { x0: cx - 1, x1: cx + 2, z: -0.5 } },
    spawn: { x: cx + 0.5, z: -4.0, yaw: faceYaw('N') },
    reception: Z.reception, copa: Z.copa, quadro: Z.quadro, copier: Z.copier, cubicles: Z.cubicles, wander: Z.wander,
    cubicleIslands,
    // parede do quadro de anotações: face interna da parede leste, olhando para -X (oeste)
    quadroWall: { x: W - 0.5 - WALL_T / 2, z0: -(b0 + 5), z1: -(b0 + 1), y0: 0.8, y1: 2.2, yaw: -Math.PI / 2 },
    // placa com o nome do escritório: face sul da divisória, acima do vão, olhando para +Z (entrada)
    sign: { x: cx + 0.5, z: -(partZ + 0.5) + WALL_T / 2 + 0.02, y: 2.25, yaw: 0, width: 3.4 },
    restrooms: [W_(1.5, zmax + 0.5), W_(W - 1.5, zmax + 0.5)],
  };
  const areas = {
    reception: R_(1, 1, W - 2, partZ),
    open: R_(1, b0, W - 2, b1),
  };
  return {
    version: 1, n, cols, rows, W, D, band0, partZ, b0, b1, cx,
    grid: g.map(row => row.join('')),
    bounds: { x0: 0, x1: W, z0: -D, z1: 0 },
    rooms: occupied, newSlot, slots: rooms, storage, zones, areas,
    corridors: corridors.map(([a, b]) => R_(1, a, W - 2, b)),
    walkCell,
  };
}

// ---------------- consultas sobre a grade
export const cellOf = (x, z) => [Math.floor(x), Math.floor(-z)];
export const cellCenter = (gx, gz) => ({ x: gx + 0.5, z: -(gz + 0.5) });
export function charAt(lay, gx, gz) { return (lay.grid[gz] || '')[gx] || ' '; }
export function isWalkable(lay, x, z) { const [gx, gz] = cellOf(x, z); return WALK.has(charAt(lay, gx, gz)); }
export function inRect(r, x, z, pad = 0) { return x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad; }

// sala (ocupada ou vaga nova) cujo interior (+ vão da porta) contém o ponto
export function roomAt(lay, x, z) {
  for (const r of lay.slots) {
    if (inRect(r.interior, x, z)) return r;
    const d = r.door;
    if (Math.abs(x - d.x) <= 1 && Math.abs(z - d.z) <= 0.5) return r;
  }
  return null;
}
export function areaAt(lay, x, z) {
  const r = roomAt(lay, x, z);
  if (r) return r.isNew ? 'nova' : 'sala';
  if (inRect(lay.areas.reception, x, z)) return 'recepcao';
  if (inRect(lay.areas.open, x, z)) return 'area';
  return 'corredor';
}

// ---------------- paredes finas: runs de células de parede → caixas (colisão + geometria mesclada)
// Cada caixa: { x0, x1, z0, z1, y0, y1, kind: 'wall'|'glass'|'partition'|'entrance'|'lintel'|'post' }
export function wallBoxes(lay) {
  const g = lay.grid, D = g.length, W = g[0].length, t = WALL_T / 2;
  const at = (x, z) => (x >= 0 && x < W && z >= 0 && z < D ? g[z][x] : ' ');
  const wallish = (x, z) => WALLISH.has(at(x, z));
  const hN = (x, z) => wallish(x - 1, z) || wallish(x + 1, z);
  const vN = (x, z) => wallish(x, z - 1) || wallish(x, z + 1);
  const hgt = ch => (ch === '|' ? PART_H : WALL_H);
  const out = [];
  // horizontais (ao longo de x)
  for (let z = 0; z < D; z++) {
    let x = 0;
    while (x < W) {
      if (!wallish(x, z)) { x++; continue; }
      const a = x;
      while (x < W && wallish(x, z)) x++;
      const b = x - 1;
      if (b === a) continue;
      let s = a;
      while (s <= b) {
        const ch = at(s, z);
        let e = s;
        while (e + 1 <= b && at(e + 1, z) === ch) e++;
        const xs = s === a ? (vN(a, z) ? a + 0.5 : a) : s;
        const xe = e === b ? (vN(b, z) ? b + 0.5 : b + 1) : e + 1;
        out.push({ x0: xs, x1: xe, z0: -(z + 0.5) - t, z1: -(z + 0.5) + t, y0: 0, y1: hgt(ch), kind: WALL_KIND[ch] });
        s = e + 1;
      }
    }
  }
  // verticais (ao longo de z de grade)
  for (let x = 0; x < W; x++) {
    let z = 0;
    while (z < D) {
      if (!wallish(x, z)) { z++; continue; }
      const a = z;
      while (z < D && wallish(x, z)) z++;
      const b = z - 1;
      if (b === a) continue;
      let s = a;
      while (s <= b) {
        const ch = at(x, s);
        let e = s;
        while (e + 1 <= b && at(x, e + 1) === ch) e++;
        const zs = s === a ? (hN(x, a) ? a + 0.5 : a) : s;
        const ze = e === b ? (hN(x, b) ? b + 0.5 : b + 1) : e + 1;
        out.push({ x0: x + 0.5 - t, x1: x + 0.5 + t, z0: -ze, z1: -zs, y0: 0, y1: hgt(ch), kind: WALL_KIND[ch] });
        s = e + 1;
      }
    }
  }
  // postes: junções (vizinho horizontal E vertical) e células isoladas
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (!wallish(x, z)) continue;
    const h = hN(x, z), v = vN(x, z);
    if ((h && v) || (!h && !v)) {
      const ch = at(x, z);
      out.push({ x0: x + 0.5 - t, x1: x + 0.5 + t, z0: -(z + 0.5) - t, z1: -(z + 0.5) + t, y0: 0, y1: hgt(ch),
        kind: ch === '|' ? 'partition' : 'post' });
    }
  }
  // vergas acima dos vãos de porta 'D' (runs horizontais)
  for (let z = 0; z < D; z++) {
    let x = 0;
    while (x < W) {
      if (at(x, z) !== 'D') { x++; continue; }
      const a = x;
      while (x < W && at(x, z) === 'D') x++;
      out.push({ x0: a, x1: x, z0: -(z + 0.5) - t, z1: -(z + 0.5) + t, y0: DOOR_H, y1: WALL_H, kind: 'lintel' });
    }
  }
  return out;
}

// móveis bloqueantes: runs horizontais do mesmo caractere fundidos verticalmente → caixas
// { x0, x1, z0, z1, y0, y1, kind: <char> } (encolhidas 4 cm para não colar nas paredes)
export function furnitureBoxes(lay, chars = FURNITURE) {
  const g = lay.grid, D = g.length, W = g[0].length;
  const runs = new Map();
  for (let z = 0; z < D; z++) {
    let x = 0;
    while (x < W) {
      const ch = g[z][x];
      if (!chars.has(ch)) { x++; continue; }
      const a = x;
      while (x < W && g[z][x] === ch) x++;
      const k = `${a},${x},${ch}`;
      if (!runs.has(k)) runs.set(k, []);
      runs.get(k).push(z);
    }
  }
  const out = [], e = 0.04;
  for (const [k, zs] of runs) {
    const [a, b, ch] = k.split(',');
    const x0 = +a, x1 = +b;
    let start = zs[0], prev = zs[0];
    for (const zz of [...zs.slice(1), null]) {
      if (zz !== null && zz === prev + 1) { prev = zz; continue; }
      out.push({ x0: x0 + e, x1: x1 - e, z0: -(prev + 1) + e, z1: -start - e, y0: 0, y1: FURN_H[ch] ?? 1, kind: ch });
      if (zz !== null) { start = prev = zz; }
    }
  }
  return out;
}

// cadeiras 'h' (não bloqueiam o jogador; só enfeite/placeholder)
export function chairCells(lay) {
  const out = [];
  lay.grid.forEach((row, z) => { for (let x = 0; x < row.length; x++) if (row[x] === 'h') out.push(cellCenter(x, z)); });
  return out;
}

// BFS a partir da entrada: toda sala, assento, quadro branco e zona global alcançáveis (usado nos testes)
export function checkLayout(lay) {
  const g = lay.grid, D = g.length, W = g[0].length;
  const ok = (x, z) => x >= 0 && x < W && z >= 0 && z < D && WALK.has(g[z][x]);
  const start = [lay.cx, 1];
  const key = (x, z) => z * W + x;
  const seen = new Set([key(...start)]);
  const q = [start];
  while (q.length) {
    const [x, z] = q.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!seen.has(key(nx, nz)) && ok(nx, nz)) { seen.add(key(nx, nz)); q.push([nx, nz]); }
    }
  }
  const reach = p => { const [gx, gz] = cellOf(p.x, p.z); return seen.has(key(gx, gz)); };
  const probs = [];
  for (const r of lay.slots) {
    if (!reach(r.door.inside)) probs.push(`sala ${r.slot} inalcançável`);
    if (!reach(r.door.outside)) probs.push(`porta da sala ${r.slot} inalcançável`);
    if (r.id !== null) for (const s of [...r.zones.seats, ...r.zones.board, ...r.zones.work]) if (!reach(s)) probs.push(`sala ${r.slot} ponto ${s.x},${s.z}`);
  }
  for (const k of ['quadro', 'copa', 'copier', 'reception', 'cubicles']) for (const s of lay.zones[k]) if (!reach(s)) probs.push(`${k} ${s.x},${s.z}`);
  if (!reach(lay.zones.spawn)) probs.push('spawn inalcançável');
  return { probs, reachable: seen.size };
}

// texto ASCII (norte = fundo em cima) para depuração
export function asciiLayout(lay) { return [...lay.grid].reverse().join('\n'); }
