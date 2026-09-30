// ============================================================ PACOTE salas — salas de reunião = projetos
// • Vaga "Nova sala": E (ou N de qualquer lugar) abre o assistente — do zero (mkdir + README + git init) ou clonar do git.
// • Durante o clone a vaga fica EM OBRAS (cones, fita zebrada, andaime, operário martelando, cavalete com a % e
//   rótulo flutuante); ao concluir, INAUGURAÇÃO (fita vermelha cortada + confete). Erro de clone vira "obra embargada".
// • Mobília de toda sala: mesa de reunião, 6 cadeiras, tapete na cor da sala, telefone de conferência, quadro branco
//   (nome, extensões, rabiscos) + TV (git), persiana na parede de vidro, placa sobre a porta (nome · branch · sujos).
// • ARQUIVOS DIEGÉTICOS: arquivo de aço com 4 gavetas por gaveteiro = pastas do 1º nível (etiquetas), pilhas de papel =
//   arquivos soltos na raiz, pastas suspensas coloridas pela extensão dominante. Interagir abre o navegador de arquivos
//   (árvore, leitura com realce simples, markdown seguro, imagem via blob, voltar) — SOMENTE LEITURA.
// • Refresh leve: canal do hub esc:sala:<office>/<sala> (1º nível + .git/index) enquanto o jogador está na sala,
//   visão geral a cada 30 s e canal esc:clones para as obras.
// GPU: tudo repetido é InstancedMesh (pools persistentes), o que é único por sala usa UMA textura de canvas por sala
// (placa + quadro + TV + etiquetas num atlas 512²) → 1 draw call por sala. Só Lambert/Basic, nenhuma luz.
// Backend: features/salas.py. CONTRATO: ARCH.md §Salas.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const KEEP_ERR_S = 180;          // obra embargada fica visível por até 3 min (ou até o usuário dispensar)
const OVERVIEW_EVERY = 30000;    // ms entre visões gerais (placas/gaveteiros)

export function install(api) {
  const { util } = api;
  const esc = util.esc;
  injectCss();

  // ---------------------------------------------------------------- estado
  const data = new Map();          // sala → {summary, top, git}
  let clones = [];                 // CLONE[] do escritório (em curso + terminados há pouco)
  const cloneStatus = new Map();   // id → último status visto (transições)
  const myClones = new Set();      // clones iniciados nesta aba
  const dismissed = new Set();     // erros de clone dispensados
  const pendingInaug = new Set();  // salas a inaugurar quando aparecerem na planta
  const anims = new Set();         // animações avulsas (confete, fita)
  let clonePanel = null;           // {h, id} painel de progresso aberto
  let fb = null;                   // navegador de arquivos aberto
  let roomWatch = null;            // {id, off}
  let overviewTimer = 0, overviewBusy = null, lastOverview = 0;
  let officeId = null;
  let hudEl = null, obraMarker = null;

  // raiz própria (pools persistentes; nada aqui é descartado pelo rebuild do layout)
  const root = new THREE.Group(); root.name = 'salas';
  api.addToScene(root);
  const constructionG = new THREE.Group(); constructionG.name = 'salas:obras'; root.add(constructionG);
  let colliders = [], interacts = [];

  // ---------------------------------------------------------------- materiais (uma vez)
  const shared = m => { m.userData.shared = true; return m; };
  const vcMat = shared(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const rugTex = makeRugTexture();
  const rugMat = shared(new THREE.MeshLambertMaterial({ map: rugTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const blindTex = makeBlindTexture();
  const blindMat = shared(new THREE.MeshLambertMaterial({ map: blindTex, alphaTest: 0.5, side: THREE.DoubleSide }));
  const tapeTex = makeTapeTexture();
  const tapeMat = shared(new THREE.MeshLambertMaterial({ map: tapeTex, side: THREE.DoubleSide }));
  const frostMat = shared(new THREE.MeshBasicMaterial({ color: '#f4f7f5', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
  const slotCanvas = document.createElement('canvas'); slotCanvas.width = 512; slotCanvas.height = 128;
  const slotTex = canvasTex(slotCanvas);
  const slotMat = shared(new THREE.MeshLambertMaterial({ map: slotTex }));

  // ---------------------------------------------------------------- geometrias (uma vez, compartilhadas)
  const GEO = buildGeometries();
  const pools = {
    table: new Pool(GEO.table, vcMat, 'mesa'), chair: new Pool(GEO.chair, vcMat, 'cadeira'),
    board: new Pool(GEO.board, vcMat, 'quadro-branco'), credenza: new Pool(GEO.credenza, vcMat, 'aparador'),
    cabinet: new Pool(GEO.cabinet, vcMat, 'gaveteiro'), paper: new Pool(GEO.paper, vcMat, 'papel'),
    crate: new Pool(GEO.crate, vcMat, 'caixa-pastas'), folder: new Pool(GEO.folder, vcMat, 'pasta', true),
    phone: new Pool(GEO.phone, vcMat, 'telefone'), rug: new Pool(GEO.rug, rugMat, 'tapete', true),
    box: new Pool(GEO.box, vcMat, 'caixa'),
  };
  for (const p of Object.values(pools)) p.parent = root;
  let blindsMesh = null, miscMesh = null, frostMesh = null, slotMesh = null;
  const roomGfx = new Map();       // sala → {canvas, tex, mat, mesh, key, k}

  // ================================================================ eventos
  api.on('layoutChanged', ev => {
    officeId = api.office.id;
    api.setPlaceholderVisible(['T', 'roomChairs', 'roomLabels', 'newSlot'], false);
    if (ev.initial && Array.isArray(api.office.info?.clones)) applyClones(api.office.info.clones, true);
    for (const id of ev.removed || []) dropRoomGfx(id);
    rebuildAll();
    rebuildConstruction();
    scheduleOverview(ev.initial ? 0 : 120);
    tryInaugurate();
    if (fb && !api.roomById(fb.room.id)) fb.h?.close();
    const cur = api.currentRoom;
    watchRoom(cur && !cur.isNew ? cur.id : null);
  });

  api.on('officeReady', office => {
    api.watch('esc:clones', () => fetchClones());
    overviewTimer = setInterval(() => { if (!document.hidden) scheduleOverview(0); }, OVERVIEW_EVERY);
    void office;
  });

  api.on('enterRoom', r => {
    if (r?.isNew) { hintNewSlot(); return; }
    if (r?.id) watchRoom(r.id);
  });
  api.on('leaveRoom', r => { if (r?.id && roomWatch?.id === r.id) watchRoom(null); });
  api.on('visibility', v => { if (v && Date.now() - lastOverview > OVERVIEW_EVERY) scheduleOverview(0); });

  api.on('update', (dt, t) => {
    for (const a of [...anims]) {
      a.t += dt;
      if (a.t >= a.dur) { anims.delete(a); util.safeCall('salas.anim.fim', a.done); } else util.safeCall('salas.anim', a.step, dt, a.t);
    }
    animateConstruction(dt, t);
  });

  api.registerKey('KeyN', { label: 'N', help: 'nova sala (projeto)', handler: () => { if (!api.isPanelOpen() && api.office.id) openNewRoom(); } });

  // ================================================================ dados do servidor
  function scheduleOverview(ms) {
    clearTimeout(scheduleOverview.t);
    scheduleOverview.t = setTimeout(() => fetchOverview().catch(err => console.warn('[salas] visão geral:', err.message)), ms);
  }
  async function fetchOverview(roomId = null, fresh = false) {
    if (!api.office.id) return;
    if (!roomId && overviewBusy) return overviewBusy;
    const run = (async () => {
      const j = await api.request('/api/rooms/overview', { office: api.office.id, room: roomId || undefined, fresh: fresh ? 1 : undefined }, 'GET', undefined, { timeout: 20000 });
      let changed = false;
      for (const [id, d] of Object.entries(j.rooms || {})) {
        if (d.error) continue;
        const prev = data.get(id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(d)) { data.set(id, d); changed = true; }
      }
      if (!roomId) lastOverview = Date.now();
      if (changed) rebuildAll();
    })();
    if (!roomId) { overviewBusy = run; run.finally(() => { overviewBusy = null; }); }
    return run;
  }

  function watchRoom(id) {
    if (roomWatch?.id === id) return;
    roomWatch?.off();
    roomWatch = null;
    if (!id || !api.office.id) return;
    let first = true;
    const off = api.watch(`esc:sala:${api.office.id}/${id}`, () => {
      if (first) { first = false; return; }
      fetchOverview(id, true).catch(() => {});
      if (fb && fb.room.id === id) fbRefresh();
    });
    roomWatch = { id, off };
  }

  async function fetchClones() {
    if (!api.office.id) return;
    try {
      const j = await api.request('/api/rooms/clones', { office: api.office.id });
      applyClones(j.clones || [], false);
    } catch (err) { console.warn('[salas] clones:', err.message); }
  }

  function applyClones(list, initial) {
    const before = runningKey();
    let refresh = false;
    for (const c of list) {
      const prev = cloneStatus.get(c.id);
      if (prev === 'running' && c.status === 'done' || (!prev && c.status === 'done' && myClones.has(c.id))) {
        pendingInaug.add(c.room);
        refresh = true;
      }
      if (prev === 'running' && c.status === 'error' && !initial) {
        api.toast(`🚧 Obra embargada: <b>${esc(c.display)}</b> — ${esc(c.error || 'o clone falhou')}`, 7000);
      }
      if (prev === 'running' && c.status === 'cancelled' && !initial) api.toast(`🚧 Obra cancelada: <b>${esc(c.display)}</b>`, 3000);
      cloneStatus.set(c.id, c.status);
    }
    clones = list;
    if (runningKey() !== before) rebuildConstruction();
    else updateConstructionTexts();
    renderHud();
    if (clonePanel?.h.isOpen()) renderClonePanel();
    if (refresh) { api.refreshLayout().then(tryInaugurate).catch(() => {}); tryInaugurate(); }
  }
  const running = () => clones.filter(c => c.status === 'running');
  const failed = () => clones.filter(c => c.status === 'error' && !dismissed.has(c.id) && Date.now() / 1000 - (c.ended || 0) < KEEP_ERR_S);
  const runningKey = () => `${running().map(c => c.id).join(',')}|${failed().map(c => c.id).join(',')}`;

  // ================================================================ construção da cena (mobília de todas as salas)
  function rebuildAll() {
    const office = api.office;
    if (!office.layout) return;
    for (const off of colliders) off();
    for (const it of interacts) it.remove();
    colliders = []; interacts = [];
    for (const p of Object.values(pools)) p.begin();
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
    const mat = (x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) => M.compose(V.set(x, y, z), Q.setFromAxisAngle(UP, yaw), S.set(sx, sy, sz));
    const miscParts = [], blindParts = [];

    for (const room of office.rooms) {
      const d = data.get(room.id) || null;
      const rnd = util.rng(`sala:${room.id}`);
      const t = room.zones.table;
      const tcx = (t.x0 + t.x1) / 2, tcz = (t.z0 + t.z1) / 2;
      // mesa, cadeiras, tapete, telefone
      pools.table.add(mat(tcx, 0, tcz));
      for (const s of room.zones.seats) pools.chair.add(mat(s.x, 0, s.z, s.yaw + (rnd() - 0.5) * 0.35));
      pools.rug.add(mat(tcx, 0.014, tcz), new THREE.Color(room.color).multiplyScalar(0.8));
      pools.phone.add(mat(tcx + 0.15, 0.76, tcz, rnd() * Math.PI));
      // quadro branco + TV (parede oposta à porta)
      const wb = room.zones.whiteboard;
      const bcx = (wb.x0 + wb.x1) / 2;
      pools.board.add(mat(bcx, 0, wb.z, wb.yaw));
      // aparador na parede oeste (dentro da meia célula da parede) — papéis soltos e planta
      const cx0 = room.interior.x0 - 0.42 + 0.23, czc = room.center.z;
      pools.credenza.add(mat(cx0, 0, czc, Math.PI / 2));
      colliders.push(api.addCollider({ x0: room.interior.x0 - 0.42, x1: room.interior.x0 + 0.05, z0: czc - 0.82, z1: czc + 0.82, y1: 0.78 }));
      // ARQUIVOS: gaveteiros (pastas do 1º nível) na parede leste
      const dirsTotal = d?.top?.dirs_total ?? 0;
      const nCab = Math.max(1, Math.min(4, Math.ceil(dirsTotal / 4)));
      const f = room.zones.files[0];
      const cabX = room.interior.x1 + 0.42 - 0.31;
      const cabZ = [];
      for (let i = 0; i < nCab; i++) cabZ.push(f.z + (i - (nCab - 1) / 2) * 0.56);
      for (const z of cabZ) pools.cabinet.add(mat(cabX, 0, z, -Math.PI / 2));
      colliders.push(api.addCollider({ x0: cabX - 0.31, x1: cabX + 0.31, z0: cabZ[0] - 0.27, z1: cabZ[cabZ.length - 1] + 0.27, y1: 1.32 }));
      room.state.salas = { cabX, cabZ, nCab };
      // pilhas de papel = arquivos soltos na raiz
      const nFiles = d?.top?.files_total ?? 0;
      const stacks = nFiles ? Math.min(8, Math.ceil(nFiles / 4)) : 0;
      const spotsTable = [[tcx - 1.3, tcz + 0.35], [tcx + 1.25, tcz - 0.4], [tcx - 0.4, tcz - 0.45]];
      for (let i = 0; i < stacks; i++) {
        const share = Math.max(1, Math.round(nFiles / stacks));
        const h = Math.min(0.2, 0.012 + share * 0.006 + rnd() * 0.01);
        if (i < 3 && i < Math.ceil(stacks / 2)) {
          const [x, z] = spotsTable[i];
          pools.paper.add(mat(x, 0.76, z, (rnd() - 0.5) * 0.6, 1, h, 1));
        } else {
          const k = i - Math.min(3, Math.ceil(stacks / 2));
          pools.paper.add(mat(cx0 + 0.02, 0.765, czc - 0.55 + k * 0.33, Math.PI / 2 + (rnd() - 0.5) * 0.4, 1, h, 1));
        }
      }
      // pastas suspensas coloridas pela extensão (caixa na ponta da mesa)
      const tops = (d?.summary?.top_ext || []).slice(0, 6);
      if (tops.length) {
        const bx = tcx + 1.55, bz = tcz + 0.35;
        pools.crate.add(mat(bx, 0.76, bz));
        tops.forEach(([ext], i) => pools.folder.add(mat(bx - 0.11 + i * 0.045, 0.775, bz, 0, 1, 0.8 + rnd() * 0.3, 1), new THREE.Color(extColor(ext))));
      }
      // persiana na parede de vidro da porta
      addBlinds(room, rnd, blindParts, miscParts);
      // textura da sala (placa, quadro, TV, etiquetas) + malha com os quads dela
      buildRoomGfx(room, d, rnd);
      // interativos
      addRoomInteractables(room, d, tcx, tcz, cabX, f);
    }

    // vaga nova: caixas de mudança (quando não está em obras) + placa/vidro fosco
    const ns = office.newSlot;
    if (ns) {
      const rnd = util.rng('vaga');
      const c = ns.center;
      if (!running().length) {
        const bx = ns.interior.x1 - 1.0, bz = c.z + (ns.door.side === 'S' ? -1.2 : 1.2);
        for (let i = 0; i < 5; i++) {
          const lvl = i < 3 ? 0 : 1;
          pools.box.add(mat(bx + (i % 3) * 0.02 - (lvl ? 0.2 : 0) + (i < 3 ? (i - 1) * 0.56 : (i - 3.5) * 0.56), lvl * 0.42, bz + (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.4));
        }
      }
      addFrost(ns, miscParts);
      addNewSlotInteractables(ns);
    }

    for (const p of Object.values(pools)) p.end();
    // malhas mescladas por layout (persianas, trilhos, vidro fosco)
    blindsMesh = replaceMesh(blindsMesh, blindParts, blindMat, 'persianas');
    miscMesh = replaceMesh(miscMesh, miscParts.filter(p => !p.userData.frost), vcMat, 'salas:misc');
    frostMesh = replaceMesh(frostMesh, miscParts.filter(p => p.userData.frost), frostMat, 'vidro-fosco');
    if (frostMesh) frostMesh.renderOrder = 3;
    buildSlotSign();
  }

  function replaceMesh(old, parts, material, name) {
    if (old) { old.removeFromParent(); old.geometry.dispose(); }
    if (!parts.length) return null;
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    const m = new THREE.Mesh(g, material);
    m.name = name; m.matrixAutoUpdate = false;
    root.add(m);
    return m;
  }

  // persiana (plano com textura de lâminas, alphaTest) nos trechos de vidro da parede da porta
  function addBlinds(room, rnd, parts, misc) {
    const d = room.door, S = d.side === 'S';
    const zIn = d.z + (S ? -0.12 : 0.12);
    const segs = [[room.rect.x0 + 0.62, d.x - 1.02], [d.x + 1.02, room.rect.x1 - 0.62]];
    const drop = 0.55 + rnd() * 1.15;     // quanto a persiana desce (cada sala de um jeito)
    for (const [a, b] of segs) {
      if (b - a < 0.3) continue;
      const w = b - a, top = 2.6, h = drop;
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 0.5, uv.getY(i) * h / 0.045);
      g.translate((a + b) / 2, top - h / 2, zIn);
      parts.push(g);
      misc.push(colorBox(w + 0.04, 0.04, 0.05, '#d8d2c2', (a + b) / 2, top + 0.03, zIn));          // trilho
      misc.push(colorBox(w, 0.025, 0.035, '#bdb6a4', (a + b) / 2, top - h - 0.01, zIn));             // barra de baixo
    }
  }

  // vidro fosco com adesivo na vaga disponível
  function addFrost(ns, misc) {
    const d = ns.door, S = d.side === 'S';
    const z = d.z + (S ? 0.1 : -0.1);
    for (const [a, b] of [[ns.rect.x0 + 0.6, d.x - 1.02], [d.x + 1.02, ns.rect.x1 - 0.6]]) {
      if (b - a < 0.3) continue;
      const g = new THREE.PlaneGeometry(b - a, 1.0);
      g.translate((a + b) / 2, 1.45, z);
      addColor(g, '#ffffff');
      g.userData.frost = true;
      misc.push(g);
    }
  }

  // ---------------------------------------------------------------- textura + quads por sala
  function roomGfxOf(id) {
    let g = roomGfx.get(id);
    if (!g) {
      const k = api.quality.tier === 'baixa' ? 0.5 : 1;
      const canvas = document.createElement('canvas');
      canvas.width = 512 * k; canvas.height = 512 * k;
      const tex = canvasTex(canvas, true);
      const mat = shared(new THREE.MeshLambertMaterial({ map: tex }));
      g = { canvas, tex, mat, mesh: null, key: '', k };
      roomGfx.set(id, g);
    }
    return g;
  }
  function dropRoomGfx(id) {
    const g = roomGfx.get(id);
    if (!g) return;
    if (g.mesh) { g.mesh.removeFromParent(); g.mesh.geometry.dispose(); }
    g.tex.dispose(); g.mat.dispose();
    roomGfx.delete(id);
    data.delete(id);
  }

  function buildRoomGfx(room, d, rnd) {
    const g = roomGfxOf(room.id);
    const key = JSON.stringify([room.name, room.color, room.source, d]);
    if (key !== g.key) { g.key = key; drawRoomCanvas(g, room, d); g.tex.needsUpdate = true; }
    const quads = [];
    const dr = room.door, S = dr.side === 'S';
    const out = S ? 1 : -1;
    // placa sobre a porta (fora e dentro)
    quads.push(quad(1.68, 0.42, R(0, 0, 512, 128), dr.x, 2.41, dr.z + out * 0.095, S ? 0 : Math.PI));
    quads.push(quad(1.68, 0.42, R(0, 0, 512, 128), dr.x, 2.41, dr.z - out * 0.095, S ? Math.PI : 0));
    // quadro branco e TV (coordenadas locais da parede)
    const wb = room.zones.whiteboard;
    const bcx = (wb.x0 + wb.x1) / 2;
    const toWorld = (lx, ly, lz) => {
      const c = Math.cos(wb.yaw), s = Math.sin(wb.yaw);
      return [bcx + lx * c + lz * s, ly, wb.z - lx * s + lz * c];
    };
    let p = toWorld(-0.7, 1.45, 0.024);
    quads.push(quad(2.44, 1.04, R(0, 128, 512, 216), p[0], p[1], p[2], wb.yaw));
    p = toWorld(1.35, 1.55, 0.058);
    quads.push(quad(0.97, 0.546, R(0, 344, 256, 144), p[0], p[1], p[2], wb.yaw));
    // etiquetas das gavetas (frente dos gaveteiros olha para −X)
    const st = room.state.salas;
    if (st) {
      st.cabZ.forEach((z, ci) => {
        for (let dz = 0; dz < 4; dz++) {
          const i = ci * 4 + dz;
          const y = 0.18 + (3 - dz) * 0.31 + 0.09;
          quads.push(quad(0.28, 0.05, R(256 + (i % 2) * 128, 344 + Math.floor(i / 2) * 21, 128, 21), st.cabX - 0.334, y, z, -Math.PI / 2));
        }
      });
    }
    if (g.mesh) { g.mesh.removeFromParent(); g.mesh.geometry.dispose(); }
    const geo = mergeGeometries(quads, false);
    for (const q of quads) q.dispose();
    g.mesh = new THREE.Mesh(geo, g.mat);
    g.mesh.name = `sala:${room.id}`; g.mesh.matrixAutoUpdate = false;
    root.add(g.mesh);
    void rnd;
  }

  function drawRoomCanvas(g, room, d) {
    const x = g.canvas.getContext('2d');
    x.setTransform(g.k, 0, 0, g.k, 0, 0);
    x.clearRect(0, 0, 512, 512);
    drawSign(x, room.name, signSub(room, d), room.color);
    drawBoard(x, room, d);
    drawTV(x, d?.git);
    drawLabels(x, d?.top);
  }

  function signSub(room, d) {
    const gi = d?.git;
    const parts = [];
    if (gi?.repo) {
      if (gi.suspicious) parts.push('git: config suspeita');
      else {
        parts.push(`⎇ ${gi.branch || '?'}`);
        const n = (gi.dirty || 0) + (gi.untracked || 0);
        parts.push(n ? `${n} ${n === 1 ? 'alteração' : 'alterações'}` : 'limpo');
        if (gi.ahead) parts.push(`↑${gi.ahead}`);
        if (gi.behind) parts.push(`↓${gi.behind}`);
      }
    } else if (d) parts.push('sem git');
    if (room.source?.kind === 'clone' && room.source.host) parts.push(room.source.host);
    return parts.join('  ·  ');
  }

  // ---------------------------------------------------------------- interativos
  function addRoomInteractables(room, d, tcx, tcz, cabX, f) {
    const info = () => {
      const dd = data.get(room.id);
      if (!dd) return 'carregando…';
      const n = dd.top?.dirs_total ?? 0;
      const names = (dd.top?.dirs || []).slice(0, 4).join(', ');
      return `${n ? `${names}${n > 4 ? '…' : ''} · ` : ''}${n} ${n === 1 ? 'pasta' : 'pastas'} · ${dd.summary?.files ?? '?'}${dd.summary?.capped ? '+' : ''} arquivos no projeto`;
    };
    interacts.push(api.addInteractable({
      pos: { x: cabX - 0.75, z: f.z }, radius: 1.35, owner: 'salas', priority: 0,
      label: () => `Arquivo de aço — ${room.name}`, info, actionLabel: 'abrir arquivos',
      onInteract: () => openFiles(room, ''),
    }));
    interacts.push(api.addInteractable({
      pos: { x: tcx, z: tcz }, radius: 2.3, owner: 'salas', priority: -0.2,
      label: () => `Mesa de reunião — ${room.name}`,
      info: () => { const n = data.get(room.id)?.top?.files_total ?? 0; return n ? `${n} ${n === 1 ? 'papel solto' : 'papéis soltos'} (arquivos na raiz)` : 'mesa arrumada: nenhum arquivo solto'; },
      actionLabel: 'ver papéis', onInteract: () => openFiles(room, ''),
      actions: [{ key: 'KeyF', label: 'resumo do projeto', onInteract: () => openSummary(room) }],
    }));
    const wb = room.zones.board;
    const mid = wb[1] && wb[2] ? { x: (wb[1].x + wb[2].x) / 2, z: (wb[1].z + wb[2].z) / 2 } : room.center;
    interacts.push(api.addInteractable({
      pos: mid, radius: 1.6, owner: 'salas', priority: -0.1,
      label: () => `Quadro branco — ${room.name}`, info: () => signSub(room, data.get(room.id)) || 'projeto',
      actionLabel: 'resumo do projeto', onInteract: () => openSummary(room),
    }));
    interacts.push(api.addInteractable({
      pos: room.door.outside, radius: 1.1, owner: 'salas', priority: -0.5,
      label: () => room.name, info: () => signSub(room, data.get(room.id)) || 'sala de reunião',
      actionLabel: 'ver arquivos', onInteract: () => openFiles(room, ''),
      actions: [{ key: 'KeyF', label: 'resumo', onInteract: () => openSummary(room) }],
    }));
    void d;
  }

  function addNewSlotInteractables(ns) {
    const label = () => {
      const r = running();
      if (r.length) return `Em obras: ${r.map(c => `${c.display} (${c.pct}%)`).join(' · ')}`;
      const f = failed();
      if (f.length) return `Obra embargada: ${f[0].display}`;
      return 'Sala disponível';
    };
    const info = () => {
      const r = running();
      if (r.length) return `${r[0].phase}${r[0].detail ? ` · ${r[0].detail.n}/${r[0].detail.total}` : ''}${r[0].detail?.speed ? ` · ${r[0].detail.speed}` : ''}`;
      const f = failed();
      if (f.length) return f[0].error || 'o clone falhou';
      return 'crie um projeto do zero ou clone um repositório git';
    };
    const main = () => {
      const r = running(), f = failed();
      if (r.length) openClonePanel(r[0].id);
      else if (f.length) openClonePanel(f[0].id);
      else openNewRoom();
    };
    const busy = () => running().length || failed().length;
    const acts = [{ key: 'KeyC', label: () => (busy() ? 'criar outra sala' : 'clonar do git'), onInteract: () => openNewRoom(busy() ? 'zero' : 'clone') }];
    const actionLabel = () => (running().length ? 'ver a obra' : failed().length ? 'ver o erro' : 'criar sala');
    for (const [pos, radius] of [[ns.door.outside, 1.7], [ns.center, 2.6]]) {
      interacts.push(api.addInteractable({ pos, radius, owner: 'salas', priority: 0, label, info, actionLabel, onInteract: main, actions: acts }));
    }
  }

  let hinted = false;
  function hintNewSlot() {
    if (hinted || running().length) return;
    hinted = true;
    api.toast('🏢 <b>Sala disponível</b> — aperte <kbd>E</kbd> para criar um projeto (ou <kbd>N</kbd> de qualquer lugar).', 3800);
  }

  // ================================================================ OBRAS (vaga nova durante o clone)
  let worker = null, obraLabel = null, obraBoard = null, obraCanvas = null, obraTex = null;
  function rebuildConstruction() {
    // limpa
    for (const o of [...constructionG.children]) { o.removeFromParent(); disposeObj(o); }
    worker = null; obraLabel = null; obraBoard = null;
    obraMarker?.(); obraMarker = null;
    const ns = api.office.newSlot;
    const r = running(), f = failed();
    buildSlotSign();
    if (!ns || (!r.length && !f.length)) { rebuildAllBoxesIfNeeded(); return; }
    rebuildAllBoxesIfNeeded();
    const d = ns.door, S = d.side === 'S', out = S ? 1 : -1;
    const c = ns.center;
    const embargo = !r.length;
    // fita zebrada na porta (duas faixas) — em obra embargada, em X
    const tapeGeo = [];
    const tapeZ = d.z + out * 0.28;
    const addTape = (y, rz) => {
      const g = new THREE.BoxGeometry(2.3, 0.08, 0.01);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 6);
      g.rotateZ(rz); g.translate(d.x, y, tapeZ); tapeGeo.push(g);
    };
    if (embargo) { addTape(1.05, 0.42); addTape(1.05, -0.42); } else { addTape(0.95, 0.03); addTape(1.25, -0.04); }
    const tape = new THREE.Mesh(mergeGeometries(tapeGeo, false), tapeMat); tapeGeo.forEach(g => g.dispose());
    constructionG.add(tape);
    // postes da fita
    const parts = [];
    for (const sx of [-1.15, 1.15]) parts.push(colorBox(0.07, 1.35, 0.07, '#e0e0e0', d.x + sx, 0.675, tapeZ), colorBox(0.3, 0.05, 0.3, '#333', d.x + sx, 0.025, tapeZ));
    // cones (fora e dentro)
    const coneSpots = [[d.x - 1.6, tapeZ + out * 0.35], [d.x + 1.55, tapeZ + out * 0.5], [c.x - 1.8, c.z + out * 0.9], [c.x + 0.4, c.z + out * 1.4]];
    for (const [x, z] of coneSpots) parts.push(coneGeo(x, z));
    if (!embargo) {
      // andaime encostado na parede do fundo
      const fz = S ? ns.interior.z0 + 0.55 : ns.interior.z1 - 0.55;
      const ax = c.x - 1.4;
      for (const dx of [0, 1.6]) for (const dz of [-0.35, 0.35]) parts.push(colorBox(0.05, 2.4, 0.05, '#c7a23a', ax + dx, 1.2, fz + dz));
      for (const y of [0.9, 1.8]) {
        parts.push(colorBox(1.7, 0.05, 0.75, '#9b7443', ax + 0.8, y, fz));                              // tábua
        parts.push(colorBox(1.65, 0.04, 0.04, '#c7a23a', ax + 0.8, y + 0.45, fz + 0.35));                // guarda-corpo
      }
      parts.push(colorBox(1.6, 0.04, 0.04, '#c7a23a', ax + 0.8, 0.4, fz - 0.35), colorBox(0.04, 0.04, 0.7, '#c7a23a', ax, 0.45, fz));
      // balde e saco de cimento
      parts.push(colorBox(0.28, 0.3, 0.28, '#6a7075', c.x + 1.6, 0.15, c.z), colorBox(0.5, 0.18, 0.35, '#c9c1a8', c.x + 1.3, 0.09, c.z + 0.6));
      // operário (com braço do martelo animado)
      worker = makeWorker();
      worker.group.position.set(ax + 0.8, 0, fz + (S ? 1.0 : -1.0));
      worker.group.rotation.y = S ? Math.PI : 0;
      constructionG.add(worker.group);
    }
    // cavalete com a placa de progresso
    const bx = d.x + (d.x > c.x ? -1.9 : 1.9), bz = d.z + out * 1.1;
    parts.push(colorBox(0.05, 1.05, 0.05, '#6b4a2f', bx - 0.42, 0.52, bz + out * 0.12), colorBox(0.05, 1.05, 0.05, '#6b4a2f', bx + 0.42, 0.52, bz + out * 0.12));
    const misc = new THREE.Mesh(mergeGeometries(parts, false), vcMat); parts.forEach(g => g.dispose());
    constructionG.add(misc);
    if (!obraCanvas) { obraCanvas = document.createElement('canvas'); obraCanvas.width = 256; obraCanvas.height = 192; obraTex = canvasTex(obraCanvas); }
    obraBoard = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.71), new THREE.MeshLambertMaterial({ map: obraTex, side: THREE.DoubleSide }));
    obraBoard.material.userData.keepMap = true;
    obraBoard.position.set(bx, 0.72, bz); obraBoard.rotation.set(-0.12 * out, S ? 0 : Math.PI, 0);
    constructionG.add(obraBoard);
    // rótulo flutuante sobre a porta
    obraLabel = api.makeLabel('…', { size: 0.3, bg: embargo ? '#fbe3df' : '#ffe9a8', border: embargo ? '#b03a2e' : '#1f2a36', maxWidth: 560 });
    obraLabel.position.set(d.x, 2.78, d.z + out * 0.3);
    constructionG.add(obraLabel);
    obraMarker = api.addMinimapMarker({ pos: { x: c.x, z: c.z }, color: embargo ? '#b03a2e' : '#e87b2c', size: 4, shape: 'square' });
    updateConstructionTexts();
  }
  let lastBoxesRunning = null;
  function rebuildAllBoxesIfNeeded() {
    const now = running().length > 0;
    if (lastBoxesRunning !== null && lastBoxesRunning !== now) rebuildAll();
    lastBoxesRunning = now;
  }

  function updateConstructionTexts() {
    const r = running(), f = failed();
    if (obraLabel) {
      let txt, sub;
      if (r.length) {
        const c = r[0];
        txt = `🚧 EM CONSTRUÇÃO: ${c.display} — ${c.pct}%`;
        sub = `${c.phase}${c.detail ? ` · ${c.detail.n}/${c.detail.total}` : ''}${c.detail?.speed ? ` · ${c.detail.speed}` : ''}${r.length > 1 ? ` · +${r.length - 1} obra` : ''}`;
      } else if (f.length) {
        txt = `⛔ OBRA EMBARGADA: ${f[0].display}`;
        sub = (f[0].error || 'o clone falhou').slice(0, 78);
      }
      if (txt) api.setLabel(obraLabel, txt, { sub });
    }
    if (obraCanvas) drawObraBoard(obraCanvas, r[0] || f[0] || null, !r.length);
    if (obraTex) obraTex.needsUpdate = true;
    buildSlotSign(true);
  }

  function animateConstruction(dt, t) {
    if (worker) {
      const px = api.player.x - worker.group.position.x, pz = api.player.z - worker.group.position.z;
      if (px * px + pz * pz < 900) {
        worker.arm.rotation.x = -1.2 + Math.abs(Math.sin(t * 5.5)) * 1.3;
        worker.group.position.y = Math.abs(Math.sin(t * 5.5)) * 0.01;
      }
    }
    if (obraLabel) obraLabel.position.y = 2.78 + Math.sin(t * 2) * 0.03;
  }

  // placa da vaga (sobre a porta) + adesivo: "SALA DISPONÍVEL" ou "EM OBRAS"
  function buildSlotSign(textOnly = false) {
    const ns = api.office.newSlot;
    const r = running(), f = failed();
    const x = slotCanvas.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, 512, 128);
    if (r.length) drawSign(x, 'EM OBRAS', `${r[0].display} · ${r[0].pct}%`, '#e87b2c', '#2a2a2a', '#ffd23f');
    else if (f.length) drawSign(x, 'OBRA EMBARGADA', f[0].display, '#b03a2e', '#3a1f1f', '#ffb3a8');
    else drawSign(x, '+ SALA DISPONÍVEL', 'aperte E para criar um projeto', '#d9a441', '#1f3a5f', '#ffd98a');
    slotTex.needsUpdate = true;
    if (textOnly && slotMesh) return;
    if (slotMesh) { slotMesh.removeFromParent(); slotMesh.geometry.dispose(); slotMesh = null; }
    if (!ns) return;
    const d = ns.door, S = d.side === 'S', out = S ? 1 : -1;
    const q = [quad(1.68, 0.42, [0, 0, 1, 1], d.x, 2.41, d.z + out * 0.095, S ? 0 : Math.PI),
      quad(1.68, 0.42, [0, 0, 1, 1], d.x, 2.41, d.z - out * 0.095, S ? Math.PI : 0)];
    slotMesh = new THREE.Mesh(mergeGeometries(q, false), slotMat);
    q.forEach(g => g.dispose());
    slotMesh.name = 'vaga:placa'; slotMesh.matrixAutoUpdate = false;
    root.add(slotMesh);
  }

  function renderHud() {
    const r = running(), f = failed();
    if (!r.length && !f.length) { if (hudEl) hudEl.innerHTML = ''; return; }
    if (!hudEl) {
      hudEl = api.hudSlot('salas-obras', { wide: true, order: 5 });
      hudEl.addEventListener('click', () => { const c = running()[0] || failed()[0]; if (c) openClonePanel(c.id); });
    }
    hudEl.innerHTML = `<div class="sl-hud card">${r.map(c => `<div class="sl-hud-row"><b>🚧 ${esc(c.display)}</b><span>${c.pct}%</span></div>
      <div class="sl-bar"><i style="width:${c.pct}%"></i></div>`).join('')}${f.map(c => `<div class="sl-hud-row err"><b>⛔ ${esc(c.display)}</b><span>erro</span></div>`).join('')}</div>`;
  }

  // ================================================================ INAUGURAÇÃO
  function tryInaugurate() {
    for (const id of [...pendingInaug]) {
      const room = api.roomById(id);
      if (!room) continue;
      pendingInaug.delete(id);
      inaugurate(room);
    }
  }

  function inaugurate(room) {
    const d = room.door, S = d.side === 'S', out = S ? 1 : -1;
    const g = new THREE.Group(); g.name = 'inauguracao';
    api.addToScene(g);
    // fita vermelha com laço, que é "cortada" e cai para os lados
    const ribbonMat = new THREE.MeshLambertMaterial({ color: '#c0262d', side: THREE.DoubleSide });
    const halves = [-1, 1].map(sgn => {
      const geo = new THREE.PlaneGeometry(1.1, 0.1); geo.translate(sgn * 0.55, 0, 0);
      const m = new THREE.Mesh(geo, ribbonMat);
      m.position.set(d.x, 1.2, d.z + out * 0.2);      // pivô no centro da porta: cada metade cai para o seu lado
      g.add(m);
      return { m, sgn };
    });
    const bow = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), ribbonMat);
    bow.position.set(d.x, 1.2, d.z + out * 0.22); bow.scale.set(1.6, 1, 0.4);
    g.add(bow);
    // confete: InstancedMesh de quadradinhos coloridos
    const N = api.quality.tier === 'baixa' ? 90 : 170;
    const conf = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.06, 0.04), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), N);
    const cols = ['#e63946', '#f1c40f', '#2a9d8f', '#3a78c2', '#e87b2c', '#9b59b6', '#ffffff'];
    const P = [];
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      P.push({ x: d.x + (Math.random() - 0.5) * 0.6, y: 2.3 + Math.random() * 0.3, z: d.z + out * (0.4 + Math.random() * 0.4),
        vx: (Math.random() - 0.5) * 3.2, vy: 1.5 + Math.random() * 2.5, vz: out * (0.4 + Math.random() * 2.2), r: Math.random() * 6, vr: (Math.random() - 0.5) * 14 });
      conf.setColorAt(i, col.set(cols[i % cols.length]));
    }
    conf.frustumCulled = false;
    g.add(conf);
    const M = new THREE.Matrix4(), E = new THREE.Euler(), Qt = new THREE.Quaternion(), V = new THREE.Vector3(), Sc = new THREE.Vector3(1, 1, 1);
    anims.add({
      t: 0, dur: 5,
      step(dt, t) {
        // fita: parada 0,5 s, depois corta e cai girando
        for (const h of halves) {
          if (t > 0.5) { const k = Math.min(1, (t - 0.5) / 0.8); h.m.rotation.z = -h.sgn * k * 1.35; h.m.position.y = 1.2 - k * 0.25; }
        }
        if (t > 0.5) { bow.position.y = Math.max(0.05, 1.2 - (t - 0.5) ** 2 * 5); bow.rotation.y += dt * 4; }
        for (let i = 0; i < N; i++) {
          const p = P[i];
          if (t < 0.45) { M.makeScale(0, 0, 0); conf.setMatrixAt(i, M); continue; }
          p.vy -= 4.2 * dt; p.vx *= 0.985; p.vz *= 0.985;
          if (p.y > 0.02) { p.x += p.vx * dt; p.y = Math.max(0.02, p.y + p.vy * dt); p.z += p.vz * dt; p.r += p.vr * dt; }
          E.set(p.r, p.r * 0.7, 0);
          conf.setMatrixAt(i, M.compose(V.set(p.x, p.y, p.z), Qt.setFromEuler(E), Sc));
        }
        conf.instanceMatrix.needsUpdate = true;
      },
      done() { g.removeFromParent(); conf.dispose(); api.disposeTree(g, { materials: true }); },
    });
    api.toast(`🎉 Inauguração da sala <b>${esc(room.name)}</b>! Corte a fita e bom trabalho.`, 4200);
    const dx = api.player.x - d.x, dz = api.player.z - d.z;
    if (dx * dx + dz * dz < 200) api.player.emote('cheer', 2.2);
    fetchOverview(room.id, true).catch(() => {});
  }

  // ================================================================ NOVA SALA (assistente)
  function openNewRoom(tab = 'zero') {
    if (!api.office.id) return;
    const r = running();
    const h = api.openPanel({
      title: '🏗️ Nova sala de reunião (projeto)',
      meta: `Cada sala é uma pasta dentro de ${api.office.path || api.office.name}. Renomear/apagar sala não é feito por aqui (de propósito).`,
      width: 'min(640px, calc(100vw - 32px))', className: 'sl-panel',
      html: `<div class="sl-new">
        <div class="sl-tabs" role="tablist">
          <button type="button" data-tab="zero">📁 Do zero</button>
          <button type="button" data-tab="clone">⬇️ Clonar do git</button>
        </div>
        <form class="sl-form" data-form="zero" autocomplete="off">
          <label>Nome do projeto <input name="name" maxlength="80" placeholder="Ex.: Site da Filial de Scranton" required></label>
          <label>Descrição <small>(vai para o README.md)</small><textarea name="description" rows="3" maxlength="4000" placeholder="Para que serve este projeto?"></textarea></label>
          <label class="sl-check"><input type="checkbox" name="git_init" checked> iniciar um repositório git (branch <code>main</code>, sem commit)</label>
          <div class="sl-err" data-err></div>
          <div class="sl-actions"><button type="submit" class="sl-primary">Inaugurar sala</button></div>
        </form>
        <form class="sl-form" data-form="clone" autocomplete="off" hidden>
          <label>URL do repositório <input name="url" maxlength="500" placeholder="https://github.com/org/repo.git  ou  git@github.com:org/repo.git" required spellcheck="false"></label>
          <div class="sl-hint" data-urlhint>Aceita <code>https://</code>, <code>ssh://</code> e <code>git@host:org/repo</code>. Repositório privado: use a URL ssh (com a sua chave) — o servidor nunca pede senha.</div>
          <label>Nome da sala <small>(opcional)</small><input name="name" maxlength="80" placeholder="nome do repositório"></label>
          <div class="sl-hint">🔒 Nada do repositório é executado pelo servidor: sem hooks, sem submódulos, sem configs do repo.</div>
          ${r.length >= (api.office.info?.limits?.clone_max || 2) ? '<div class="sl-err">Já há obras demais em andamento — espere uma terminar.</div>' : ''}
          <div class="sl-err" data-err></div>
          <div class="sl-actions"><button type="submit" class="sl-primary">Começar a obra</button></div>
        </form>
      </div>`,
    });
    const body = h.body, sig = { signal: h.signal };
    const setTab = t => {
      body.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      body.querySelectorAll('[data-form]').forEach(f => { f.hidden = f.dataset.form !== t; });
      setTimeout(() => body.querySelector(`[data-form="${t}"] input`)?.focus(), 30);
    };
    body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab), sig));
    setTab(tab);
    // do zero
    const fz = body.querySelector('[data-form="zero"]');
    fz.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = fz.querySelector('button[type=submit]'), err = fz.querySelector('[data-err]');
      const name = fz.elements.namedItem('name').value.trim();
      if (!name) { err.textContent = 'Dê um nome ao projeto.'; return; }
      btn.disabled = true; err.textContent = '';
      try {
        const j = await api.request('/api/rooms', {}, 'POST', { office: api.office.id, name, description: fz.description.value, git_init: fz.git_init.checked });
        h.close();
        pendingInaug.add(j.room.id);
        if (j.git_ok === false) api.toast('⚠️ Sala criada, mas o <code>git init</code> falhou.', 4000);
        await api.refreshLayout();
        tryInaugurate();
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    }, sig);
    // clonar
    const fc = body.querySelector('[data-form="clone"]');
    const hint = fc.querySelector('[data-urlhint]');
    const urlIn = fc.elements.namedItem('url');
    const hintDefault = hint.innerHTML;
    urlIn.addEventListener('input', () => {
      const v = checkUrl(urlIn.value);
      fc.elements.namedItem('name').placeholder = v.name || 'nome do repositório';
      hint.classList.toggle('bad', !!(urlIn.value.trim() && v.error));
      hint.innerHTML = urlIn.value.trim() && v.error ? esc(v.error) : hintDefault;
    }, sig);
    fc.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = fc.querySelector('button[type=submit]'), err = fc.querySelector('[data-err]');
      const v = checkUrl(urlIn.value);
      if (v.error) { err.textContent = v.error; return; }
      btn.disabled = true; err.textContent = '';
      try {
        const c = await api.request('/api/rooms/clone', {}, 'POST', { office: api.office.id, url: urlIn.value.trim(), name: fc.elements.namedItem('name').value.trim() || undefined });
        myClones.add(c.id);
        cloneStatus.set(c.id, c.status);
        clones = [...clones.filter(x => x.id !== c.id), c];
        rebuildConstruction(); renderHud();
        openClonePanel(c.id);
        api.toast(`🚧 Obra iniciada: <b>${esc(c.display)}</b>`, 2500);
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    }, sig);
  }

  // validação no front (espelho da do servidor; o servidor decide)
  function checkUrl(raw) {
    const url = String(raw || '').trim();
    if (!url) return { error: 'Cole a URL do repositório.' };
    if (/\s/.test(url)) return { error: 'A URL não pode ter espaços.' };
    if (url.startsWith('-')) return { error: "A URL não pode começar com '-'." };
    if (/^[a-z][a-z0-9+.-]*::/i.test(url)) return { error: "Transporte 'x::' não é permitido." };
    if (/^http:\/\//i.test(url)) return { error: 'http:// sem criptografia não é aceito — use https://' };
    if (/^(file:|\/|~|\.\/|git:\/\/)/i.test(url)) return { error: 'Só https://, ssh:// ou git@host:org/repo.' };
    const m = url.match(/^https:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/) || url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
      || url.match(/^[\w.-]+@([^/:]+):((?!\/).+)$/);
    if (!m) return { error: 'Use https://…, ssh://… ou git@host:org/repo.git' };
    const host = m[1];
    if (!host.includes('.') || /^(localhost|127\.|10\.|192\.168\.|0\.)/i.test(host)) return { error: 'Host local ou de rede interna não é permitido.' };
    if (m[2].split('/').includes('..')) return { error: "Caminho com '..' não é permitido." };
    const name = m[2].replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');
    return { name };
  }

  // ---------------------------------------------------------------- painel de progresso do clone
  function openClonePanel(id) {
    const h = api.openPanel({ title: '🚧 Obra', width: 'min(620px, calc(100vw - 32px))', className: 'sl-panel', html: '<div class="sl-clone"></div>',
      onClose: () => { if (clonePanel?.h === h) clonePanel = null; } });
    clonePanel = { h, id };
    renderClonePanel();
  }
  function renderClonePanel() {
    const { h, id } = clonePanel;
    const c = clones.find(x => x.id === id);
    const box = h.body.querySelector('.sl-clone');
    if (!box) return;
    if (!c) { box.innerHTML = '<div class="info">Essa obra já saiu da lista.</div>'; return; }
    const st = { running: '🚧 em andamento', done: '🎉 inaugurada', error: '⛔ embargada', cancelled: '✋ cancelada' }[c.status] || c.status;
    h.update({ title: `🚧 Obra: ${c.display}`, meta: `${st} · ${c.url}` });
    const det = c.detail ? `${c.detail.n.toLocaleString('pt-BR')} / ${c.detail.total.toLocaleString('pt-BR')} objetos${c.detail.recv ? ` · ${c.detail.recv}` : ''}${c.detail.speed ? ` · ${c.detail.speed}` : ''}` : '';
    box.innerHTML = `<div class="sl-pad">
      <div class="sl-clone-head"><b>${esc(c.display)}</b><span>pasta: <code>${esc(c.room)}</code></span></div>
      <div class="sl-bar big ${c.status}"><i style="width:${c.status === 'done' ? 100 : c.pct}%"></i><span>${c.status === 'done' ? 100 : c.pct}%</span></div>
      <div class="sl-phase">${esc(c.status === 'running' ? c.phase : st)}${det ? ` · ${esc(det)}` : ''}</div>
      ${c.error && c.status !== 'cancelled' ? `<div class="sl-err big">${esc(c.error)}</div>` : ''}
      ${c.log?.length ? `<pre class="sl-log">${esc(c.log.join('\n'))}</pre>` : ''}
      <div class="sl-actions">
        ${c.status === 'running' ? '<button type="button" data-act="cancel" class="sl-danger">Cancelar obra</button>' : ''}
        ${c.status === 'error' ? '<button type="button" data-act="dismiss">Dispensar aviso</button><button type="button" data-act="retry" class="sl-primary">Tentar de novo</button>' : ''}
        ${c.status === 'done' ? '<button type="button" data-act="go" class="sl-primary">Ir até a sala</button>' : ''}
      </div></div>`;
    box.querySelector('[data-act="cancel"]')?.addEventListener('click', async ev => {
      if (!confirm(`Cancelar a obra de “${c.display}”? O que já foi baixado é descartado.`)) return;
      ev.target.disabled = true;
      try { await api.request(`/api/rooms/clones/${encodeURIComponent(c.id)}/cancel`, {}, 'POST', { office: api.office.id }); } catch (e) { api.toast(`❌ ${esc(e.message)}`); }
      fetchClones();
    }, { signal: h.signal });
    box.querySelector('[data-act="dismiss"]')?.addEventListener('click', () => { dismissed.add(c.id); h.close(); rebuildConstruction(); renderHud(); }, { signal: h.signal });
    box.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      dismissed.add(c.id); rebuildConstruction(); renderHud();
      openNewRoom('clone');
      const f = document.querySelector('.sl-form[data-form="clone"]');
      if (f) { f.elements.namedItem('url').value = c.url; f.elements.namedItem('name').value = c.display; f.elements.namedItem('url').dispatchEvent(new Event('input')); }
    }, { signal: h.signal });
    box.querySelector('[data-act="go"]')?.addEventListener('click', () => {
      const room = api.roomById(c.room);
      if (room) { api.player.teleport(room.door.outside.x, room.door.outside.z, room.door.yaw); h.close(); }
    }, { signal: h.signal });
  }

  // ================================================================ RESUMO DO PROJETO (quadro branco)
  async function openSummary(room) {
    const h = api.openPanel({ title: `📋 ${room.name}`, meta: room.path, width: 'min(860px, calc(100vw - 32px))', className: 'sl-panel',
      html: '<div class="info">Lendo o projeto…</div>', actions: [{ label: '🗄️ Arquivos', primary: true, onClick: () => openFiles(room, '') }] });
    try {
      await fetchOverview(room.id, true);
      const d = data.get(room.id) || {};
      const s = d.summary || {}, g = d.git || {}, top = d.top || {};
      const total = (s.top_ext || []).reduce((a, [, n]) => a + n, 0) || 1;
      const readme = (top.files || []).find(n => /^readme(\.md|\.markdown|\.txt)?$/i.test(n));
      let readmeHtml = '<div class="sl-muted">Sem README na raiz.</div>';
      if (readme) {
        try {
          const f = await api.request(`/api/rooms/${encodeURIComponent(room.id)}/file`, { office: api.office.id, path: readme }, 'GET', undefined, { signal: h.signal });
          if (f.kind === 'text') readmeHtml = /\.(md|markdown)$/i.test(readme) ? `<div class="md">${api.markdown(f.content.slice(0, 60000))}</div>` : `<pre>${esc(f.content.slice(0, 20000))}</pre>`;
        } catch { /* sem README legível */ }
      }
      const gitHtml = !g.repo ? '<p>Sem repositório git.</p>'
        : g.suspicious ? `<p class="sl-warn">⚠️ ${esc(g.error || 'config suspeita')} — o servidor não roda git nesta sala.</p><p>branch: <b>${esc(g.branch || '?')}</b></p>`
          : `<p>branch <b>${esc(g.branch || '?')}</b>${g.head ? ` · HEAD <code>${esc(g.head)}</code>` : ' · sem commits'}</p>
             <p>${g.dirty || 0} alterado(s) · ${g.untracked || 0} novo(s)${g.ahead != null ? ` · ↑${g.ahead} ↓${g.behind}` : ''}</p>
             ${g.error ? `<p class="sl-warn">${esc(g.error)}</p>` : ''}`;
      const src = room.source?.kind === 'clone' ? `clonado de <code>${esc(room.source.url || room.source.host || '')}</code>` : room.source?.kind === 'zero' ? 'criado do zero no escritório' : 'pasta criada por fora do escritório';
      h.update({ html: `<div class="sl-sum">
        <div class="sl-sum-cards">
          <div class="sl-card"><h4>Projeto</h4><p><b>${(s.files ?? 0).toLocaleString('pt-BR')}${s.capped ? '+' : ''}</b> arquivos · <b>${(s.dirs ?? 0).toLocaleString('pt-BR')}</b> pastas</p><p>${src}</p></div>
          <div class="sl-card"><h4>Git</h4>${gitHtml}</div>
          <div class="sl-card"><h4>Extensões</h4>${(s.top_ext || []).slice(0, 6).map(([e, n]) => `<div class="sl-ext"><i style="background:${extColor(e)}"></i><span>${esc(e)}</span><b style="width:${Math.max(4, n / total * 100)}%;background:${extColor(e)}"></b><small>${n}</small></div>`).join('') || '<p class="sl-muted">vazio</p>'}</div>
        </div>
        <h4 class="sl-readme-h">${readme ? esc(readme) : 'README'}</h4>${readmeHtml}</div>` });
    } catch (e) { h.update({ html: `<div class="info">❌ ${esc(e.message)}</div>` }); }
  }

  // ================================================================ NAVEGADOR DE ARQUIVOS (somente leitura)
  function openFiles(room, rel = '') {
    const h = api.openPanel({
      title: `🗄️ Arquivo — ${room.name}`, meta: signSub(room, data.get(room.id)) || room.path,
      width: 'min(1120px, calc(100vw - 32px))', className: 'sl-panel sl-files',
      html: `<div class="sl-fb"><aside class="sl-tree" data-tree></aside><section class="sl-view"><div class="sl-vbar" data-vbar></div><div class="sl-vbody" data-vbody></div></section></div>`,
      actions: [
        { label: '👁 ignoradas', title: 'Mostrar node_modules, dist, build… (a .git nunca aparece)', onClick: () => { fb.all = !fb.all; fb.dirs.clear(); fbLoad('').then(() => fbOpen(fb.cur, false)); } },
        { label: '⟳', title: 'Atualizar', onClick: () => fbRefresh() },
      ],
      onClose: () => { if (fb?.h === h) { fbRevoke(); fb = null; } },
    });
    fb = { room, h, all: false, dirs: new Map(), open: new Set(['']), cur: { rel: '', type: 'dir' }, hist: [], blob: null, file: null, mdSrc: false };
    const body = h.body;
    body.addEventListener('click', ev => {
      const el = ev.target.closest('[data-go],[data-toggle],[data-back],[data-more],[data-copy],[data-mdsrc]');
      if (!el || !body.contains(el)) return;
      if (el.dataset.toggle !== undefined) { fbToggle(el.dataset.toggle); return; }
      if (el.dataset.back !== undefined) { const prev = fb.hist.pop(); if (prev) fbOpen(prev, false); return; }
      if (el.dataset.more !== undefined) { fbMore(el.dataset.more); return; }
      if (el.dataset.copy !== undefined) { navigator.clipboard?.writeText(el.dataset.copy).then(() => api.toast('📋 Caminho copiado.', 1200), () => {}); return; }
      if (el.dataset.mdsrc !== undefined) { fb.mdSrc = !fb.mdSrc; fbRenderFile(); return; }
      fbOpen({ rel: el.dataset.go, type: el.dataset.type || 'dir' });
    }, { signal: h.signal });
    body.addEventListener('keydown', ev => {
      if (ev.key === 'Backspace' && !api.isTyping()) { ev.preventDefault(); const prev = fb.hist.pop(); if (prev) fbOpen(prev, false); }
    }, { signal: h.signal });
    fbLoad('').then(() => {
      if (rel) { for (const part of ancestors(rel)) fb.open.add(part); }
      return Promise.all([...fb.open].map(r => (fb.dirs.has(r) ? null : fbLoad(r).catch(() => null))));
    }).then(() => fbOpen({ rel, type: 'dir' }, false)).catch(e => { body.querySelector('[data-vbody]').innerHTML = `<div class="info">❌ ${esc(e.message)}</div>`; });
  }

  const ancestors = rel => { const out = []; const parts = rel.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/')); return out; };
  const joinRel = (a, b) => (a ? `${a}/${b}` : b);

  async function fbLoad(rel, offset = 0) {
    const room = fb.room;
    const j = await api.request(`/api/rooms/${encodeURIComponent(room.id)}/files`, { office: api.office.id, path: rel, offset, limit: 300, all: fb.all ? 1 : 0 }, 'GET', undefined, { signal: fb.h.signal });
    if (!fb || fb.room !== room) return null;
    if (offset && fb.dirs.has(rel)) { const d = fb.dirs.get(rel); d.entries.push(...j.entries); d.truncated = j.truncated; d.total = j.total; }
    else fb.dirs.set(rel, j);
    fbRenderTree();
    return j;
  }
  async function fbMore(rel) { const d = fb.dirs.get(rel); if (d) { await fbLoad(rel, d.entries.length); if (fb.cur.rel === rel && fb.cur.type === 'dir') fbRenderDir(); } }
  async function fbToggle(rel) {
    if (fb.open.has(rel) && rel !== '') { fb.open.delete(rel); fbRenderTree(); return; }
    fb.open.add(rel);
    if (!fb.dirs.has(rel)) { try { await fbLoad(rel); } catch (e) { api.toast(`❌ ${esc(e.message)}`); fb.open.delete(rel); } }
    fbRenderTree();
  }

  function fbRenderTree() {
    if (!fb?.h.isOpen()) return;
    const el = fb.h.body.querySelector('[data-tree]');
    const scroll = el.scrollTop;
    const rows = [];
    const walk = (rel, depth) => {
      const d = fb.dirs.get(rel);
      if (!d) { rows.push(`<div class="sl-row muted" style="--d:${depth}">…</div>`); return; }
      for (const e of d.entries) {
        const r = joinRel(rel, e.name);
        const pad = `style="--d:${depth}"`;
        const isDir = e.type === 'dir' || (e.type === 'link' && e.link_inside && e.link_dir);
        const sel = fb.cur.rel === r ? ' sel' : '';
        if (isDir) {
          const open = fb.open.has(r);
          rows.push(`<div class="sl-row dir${sel}" ${pad}><span class="sl-caret" data-toggle="${esc(r)}">${open ? '▾' : '▸'}</span><span class="sl-name" data-go="${esc(r)}" data-type="dir" title="${esc(r)}">📁 ${esc(e.name)}${e.type === 'link' ? ' ↪' : ''}</span></div>`);
          if (open) walk(r, depth + 1);
        } else if (e.type === 'link' && !e.link_inside) {
          rows.push(`<div class="sl-row muted" ${pad} title="atalho para fora da sala — bloqueado"><span class="sl-caret"></span>⛔ ${esc(e.name)}</div>`);
        } else {
          rows.push(`<div class="sl-row file${sel}" ${pad}><span class="sl-caret"></span><span class="sl-name" data-go="${esc(r)}" data-type="file" title="${esc(r)}">${fileIcon(e.name)} ${esc(e.name)}</span></div>`);
        }
      }
      if (d.truncated) rows.push(`<div class="sl-row" style="--d:${depth}"><span class="sl-caret"></span><button type="button" class="sl-link" data-more="${esc(rel)}">+ ${d.total - d.entries.length} itens…</button></div>`);
      if (d.ignored?.length && !fb.all && depth === 0) rows.push(`<div class="sl-row muted" style="--d:0" title="Use o botão 'ignoradas' para ver (a .git nunca aparece)"><span class="sl-caret"></span>🙈 ${esc(d.ignored.join(', '))}</div>`);
    };
    const rootSel = fb.cur.rel === '' ? ' sel' : '';
    rows.push(`<div class="sl-row dir${rootSel}" style="--d:0"><span class="sl-caret">▾</span><span class="sl-name" data-go="" data-type="dir">🏢 ${esc(fb.room.name)}</span></div>`);
    walk('', 1);
    el.innerHTML = rows.join('');
    el.scrollTop = scroll;
  }

  function fbRevoke() { if (fb?.blob) { URL.revokeObjectURL(fb.blob); fb.blob = null; } }

  async function fbOpen(target, push = true) {
    if (!fb) return;
    if (push && (fb.cur.rel !== target.rel || fb.cur.type !== target.type)) { fb.hist.push(fb.cur); if (fb.hist.length > 60) fb.hist.shift(); }
    fb.cur = target;
    fbRevoke();
    fb.file = null; fb.mdSrc = false;
    fbRenderBar();
    if (target.type === 'dir') {
      for (const a of ancestors(target.rel)) fb.open.add(a);
      if (!fb.dirs.has(target.rel)) { try { await fbLoad(target.rel); } catch (e) { fbBody(`<div class="info">❌ ${esc(e.message)}</div>`); return; } }
      fbRenderTree(); fbRenderDir();
    } else {
      fbRenderTree();
      fbBody('<div class="info">Abrindo a gaveta…</div>');
      try {
        const f = await api.request(`/api/rooms/${encodeURIComponent(fb.room.id)}/file`, { office: api.office.id, path: target.rel }, 'GET', undefined, { signal: fb.h.signal });
        if (!fb || fb.cur !== target) return;
        fb.file = f;
        if (f.kind === 'image') fb.blob = await api.blobUrl(`/api/rooms/${encodeURIComponent(fb.room.id)}/raw`, { office: api.office.id, path: target.rel });
        if (!fb || fb.cur !== target) { if (fb?.blob) fbRevoke(); return; }
        fbRenderFile();
      } catch (e) { if (e.name !== 'AbortError') fbBody(`<div class="info">❌ ${esc(e.message)}</div>`); }
    }
  }

  function fbBody(html) { if (fb?.h.isOpen()) fb.h.body.querySelector('[data-vbody]').innerHTML = html; }
  function fbRenderBar() {
    if (!fb?.h.isOpen()) return;
    const parts = fb.cur.rel.split('/').filter(Boolean);
    const crumbs = [`<button type="button" class="sl-link" data-go="" data-type="dir">${esc(fb.room.name)}</button>`];
    parts.forEach((p, i) => {
      const r = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      crumbs.push(last && fb.cur.type === 'file' ? `<b>${esc(p)}</b>` : `<button type="button" class="sl-link" data-go="${esc(r)}" data-type="dir">${esc(p)}</button>`);
    });
    fb.h.body.querySelector('[data-vbar]').innerHTML = `<button type="button" data-back ${fb.hist.length ? '' : 'disabled'} title="Voltar (Backspace)">← Voltar</button>
      <div class="sl-crumbs">${crumbs.join('<span>/</span>')}</div>
      ${fb.cur.rel ? `<button type="button" data-copy="${esc(fb.cur.rel)}" title="Copiar caminho relativo">📋</button>` : ''}`;
  }
  function fbRenderDir() {
    const d = fb.dirs.get(fb.cur.rel);
    if (!d) return;
    if (!d.entries.length) { fbBody(`<div class="info">Gaveta vazia.${d.ignored?.length ? ` <br><small>(ignoradas: ${esc(d.ignored.join(', '))})</small>` : ''}</div>`); return; }
    const rows = d.entries.map(e => {
      const r = joinRel(fb.cur.rel, e.name);
      const isDir = e.type === 'dir' || (e.type === 'link' && e.link_inside && e.link_dir);
      if (e.type === 'link' && !e.link_inside) return `<tr class="muted"><td>⛔ ${esc(e.name)}</td><td colspan="2">atalho para fora da sala</td></tr>`;
      return `<tr data-go="${esc(r)}" data-type="${isDir ? 'dir' : 'file'}"><td>${isDir ? '📁' : fileIcon(e.name)} ${esc(e.name)}</td><td>${isDir ? '' : util.fmtSize(e.size)}</td><td>${e.mtime ? esc(util.fmtAgo(e.mtime)) : ''}</td></tr>`;
    }).join('');
    fbBody(`<table class="sl-table"><thead><tr><th>Nome</th><th>Tamanho</th><th>Modificado</th></tr></thead><tbody>${rows}</tbody></table>
      ${d.truncated ? `<div class="sl-pad"><button type="button" data-more="${esc(fb.cur.rel)}">Carregar mais (${d.total - d.entries.length})</button></div>` : ''}`);
  }
  function fbRenderFile() {
    const f = fb?.file;
    if (!f) return;
    const head = `<div class="sl-fhead"><span>${esc(f.rel)}</span><span>${util.fmtSize(f.size)} · ${esc(util.fmtAgo(f.mtime))}</span>${f.truncated ? '<span class="sl-badge">mostrando os primeiros 200 KB</span>' : ''}</div>`;
    if (f.kind === 'image') { fbBody(`${head}<div class="sl-img"><img alt="${esc(f.rel)}" src="${esc(fb.blob || '')}"></div>`); return; }
    if (f.kind === 'binary') { fbBody(`${head}<div class="info">📦 Arquivo binário (${util.fmtSize(f.size)}) — não dá para ler aqui.</div>`); return; }
    const ext = (f.rel.match(/\.([^./]+)$/)?.[1] || '').toLowerCase();
    const isMd = ext === 'md' || ext === 'markdown';
    const tools = isMd ? `<button type="button" data-mdsrc>${fb.mdSrc ? '👁 renderizado' : '✎ ver fonte'}</button>` : '';
    if (isMd && !fb.mdSrc) { fbBody(`${head.replace('</div>', `${tools}</div>`)}<div class="md">${api.markdown(f.content)}</div>`); return; }
    fbBody(`${head.replace('</div>', `${tools}</div>`)}${codeHtml(f.content, ext, f.rel)}`);
  }

  async function fbRefresh() {
    if (!fb?.h.isOpen()) return;
    const openDirs = [...fb.open].filter(r => fb.dirs.has(r));
    fb.dirs.clear();
    for (const r of openDirs) { try { await fbLoad(r); } catch { fb.open.delete(r); } }
    if (!fb) return;
    if (fb.cur.type === 'dir') fbRenderDir();
    else if (fb.file) {
      try {
        const f = await api.request(`/api/rooms/${encodeURIComponent(fb.room.id)}/file`, { office: api.office.id, path: fb.cur.rel }, 'GET', undefined, { signal: fb.h.signal });
        if (fb && f.mtime !== fb.file.mtime && f.kind === 'text') { fb.file = f; fbRenderFile(); api.toast('📝 O arquivo mudou no disco — recarregado.', 1800); }
      } catch (e) { if (e.status === 404) fbBody('<div class="info">Esse arquivo sumiu do disco.</div>'); }
    }
  }

  // ================================================================ desenho em canvas
  function drawSign(x, title, sub, accent = '#d9a441', bg = '#1f3a5f', subColor = '#f0d9a0') {
    x.save();
    x.fillStyle = bg; roundRect(x, 2, 2, 508, 124, 12); x.fill();
    x.strokeStyle = accent; x.lineWidth = 5; roundRect(x, 9, 9, 494, 110, 8); x.stroke();
    x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(14, 14, 484, 40);
    for (const [sx, sy] of [[22, 22], [490, 22], [22, 106], [490, 106]]) { x.fillStyle = '#c9ccd0'; x.beginPath(); x.arc(sx, sy, 4, 0, 7); x.fill(); }
    x.fillStyle = '#f7f1e3'; x.textAlign = 'center'; x.textBaseline = 'middle';
    fitText(x, title, 256, sub ? 52 : 64, 440, 46, '700', '"Trebuchet MS", "Segoe UI", sans-serif');
    if (sub) { x.fillStyle = subColor; fitText(x, sub, 256, 94, 450, 24, '600', '"Trebuchet MS", "Segoe UI", sans-serif'); }
    x.restore();
  }

  function drawBoard(x, room, d) {
    const y0 = 128, W = 512, H = 216;
    x.save();
    x.beginPath(); x.rect(0, y0, W, H); x.clip();
    x.fillStyle = '#f7f9f8'; x.fillRect(0, y0, W, H);
    const rnd = util.rng(`quadro:${room.id}`);
    // manchas de apagador
    for (let i = 0; i < 6; i++) { x.fillStyle = `rgba(150,160,170,${0.05 + rnd() * 0.06})`; x.beginPath(); x.ellipse(rnd() * W, y0 + rnd() * H, 30 + rnd() * 60, 10 + rnd() * 20, rnd(), 0, 7); x.fill(); }
    const marker = '"Comic Sans MS", "Segoe Print", "Chalkboard SE", cursive';
    x.textBaseline = 'alphabetic'; x.textAlign = 'left';
    x.fillStyle = '#1f4fa8';
    x.save(); x.translate(18, y0 + 40); x.rotate(-0.02);
    fitText(x, room.name, 0, 0, 330, 34, '700', marker, 'left');
    x.strokeStyle = '#1f4fa8'; x.lineWidth = 3; x.beginPath(); x.moveTo(0, 8); for (let i = 0; i <= 10; i++) x.lineTo(i * 30, 8 + Math.sin(i * 1.7) * 2); x.stroke();
    x.restore();
    const s = d?.summary;
    // gráfico de barras das extensões
    const tops = (s?.top_ext || []).slice(0, 5);
    const max = Math.max(1, ...tops.map(t => t[1]));
    x.font = `600 17px ${marker}`;
    tops.forEach(([e, n], i) => {
      const yy = y0 + 70 + i * 27;
      x.fillStyle = '#333'; x.fillText(e.slice(0, 8), 18, yy + 14);
      x.fillStyle = extColor(e);
      const w = 8 + (n / max) * 140;
      x.fillRect(92, yy + 1, w, 16);
      x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1.5; x.strokeRect(92, yy + 1, w, 16);
      x.fillStyle = '#333'; x.fillText(String(n), 98 + w, yy + 14);
    });
    if (!tops.length) { x.fillStyle = '#888'; x.fillText(d ? '(sala vazia)' : '…', 18, y0 + 90); }
    // coluna direita: números + lista de tarefas cômica + rabisco
    x.fillStyle = '#b03a2e';
    if (s) fitText(x, `${s.files}${s.capped ? '+' : ''} arquivos · ${s.dirs} pastas`, 300, y0 + 80, 200, 20, '700', marker, 'left');
    const todos = ['revisar PR', 'mais café', 'reunião 15h', 'deploy sexta?', 'NÃO APAGAR', 'falar c/ RH', 'testes!!', 'backup', 'ideias ☆'];
    x.fillStyle = '#2d6a3e'; x.font = `600 17px ${marker}`;
    for (let i = 0; i < 3; i++) {
      const t = todos[Math.floor(rnd() * todos.length)];
      const yy = y0 + 110 + i * 24;
      x.strokeStyle = '#2d6a3e'; x.lineWidth = 2; x.strokeRect(302, yy - 13, 13, 13);
      if (rnd() > 0.5) { x.beginPath(); x.moveTo(303, yy - 7); x.lineTo(308, yy - 1); x.lineTo(318, yy - 16); x.stroke(); }
      x.fillText(t, 322, yy);
    }
    // carinha
    x.strokeStyle = '#1f2a36'; x.lineWidth = 2.5;
    const fx = 470, fy = y0 + 180;
    x.beginPath(); x.arc(fx, fy, 18, 0, 7); x.stroke();
    x.beginPath(); x.arc(fx - 6, fy - 5, 2, 0, 7); x.arc(fx + 6, fy - 5, 2, 0, 7); x.fill();
    x.beginPath(); x.arc(fx, fy + 2, 9, 0.2, Math.PI - 0.2); x.stroke();
    x.restore();
  }

  function drawTV(x, g) {
    const X = 0, Y = 344, W = 256, H = 144;
    x.save();
    x.beginPath(); x.rect(X, Y, W, H); x.clip();
    if (!g?.repo) {
      const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      cols.forEach((c, i) => { x.fillStyle = c; x.fillRect(X + i * W / 7, Y, W / 7 + 1, H * 0.7); });
      x.fillStyle = '#111'; x.fillRect(X, Y + H * 0.7, W, H * 0.3);
      x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '700 20px "Trebuchet MS", sans-serif'; x.fillText('SEM SINAL', X + W / 2, Y + H * 0.35);
      x.font = '600 15px "Trebuchet MS", sans-serif'; x.fillText(g ? 'sem repositório git' : '…', X + W / 2, Y + H * 0.85);
    } else if (g.suspicious) {
      x.fillStyle = '#5a1515'; x.fillRect(X, Y, W, H);
      x.fillStyle = '#ffd6cf'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '700 22px "Trebuchet MS", sans-serif'; x.fillText('⚠ GIT DESLIGADO', X + W / 2, Y + 50);
      x.font = '500 14px "Trebuchet MS", sans-serif'; x.fillText('.git/config suspeito', X + W / 2, Y + 82);
      x.fillText(`branch: ${String(g.branch || '?').slice(0, 22)}`, X + W / 2, Y + 106);
    } else {
      const grd = x.createLinearGradient(X, Y, X, Y + H); grd.addColorStop(0, '#12263f'); grd.addColorStop(1, '#0a1524');
      x.fillStyle = grd; x.fillRect(X, Y, W, H);
      x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      x.fillStyle = '#7fb3e6'; x.font = '700 13px "Trebuchet MS", sans-serif'; x.fillText('GIT · STATUS', X + 12, Y + 20);
      x.fillStyle = '#ffffff'; fitText(x, `⎇ ${g.branch || '?'}`, X + 12, Y + 50, 232, 24, '700', '"Trebuchet MS", sans-serif', 'left');
      x.font = '500 14px ui-monospace, Consolas, monospace'; x.fillStyle = '#cfe3f7';
      x.fillText(g.head ? `HEAD ${g.head}` : 'sem commits ainda', X + 12, Y + 74);
      const dirty = g.dirty || 0, un = g.untracked || 0;
      x.fillStyle = dirty ? '#ffcf5a' : '#8fe3a0'; x.fillText(`✎ ${dirty} alterado${dirty === 1 ? '' : 's'}`, X + 12, Y + 98);
      x.fillStyle = un ? '#ffcf5a' : '#8fe3a0'; x.fillText(`+ ${un} novo${un === 1 ? '' : 's'}`, X + 132, Y + 98);
      x.fillStyle = '#cfe3f7'; x.fillText(g.ahead != null ? `↑${g.ahead} ↓${g.behind}` : 'sem upstream', X + 12, Y + 122);
      if (g.error) { x.fillStyle = '#ff9a8a'; x.fillText('erro', X + 200, Y + 122); }
    }
    // reflexo
    x.fillStyle = 'rgba(255,255,255,.06)'; x.beginPath(); x.moveTo(X, Y); x.lineTo(X + W * 0.55, Y); x.lineTo(X + W * 0.25, Y + H); x.lineTo(X, Y + H); x.fill();
    x.restore();
  }

  function drawLabels(x, top) {
    const names = top ? [...top.dirs] : [];
    const total = top?.dirs_total ?? 0;
    const cap = Math.max(1, Math.min(4, Math.ceil(total / 4))) * 4;
    if (total > cap) { names.length = cap - 1; names.push(`+${total - cap + 1} pastas`); }
    for (let i = 0; i < 16; i++) {
      const px = 256 + (i % 2) * 128, py = 344 + Math.floor(i / 2) * 21;
      x.fillStyle = '#f3ecd3'; x.fillRect(px + 1, py + 1, 126, 19);
      x.strokeStyle = '#8a7f63'; x.lineWidth = 1; x.strokeRect(px + 1.5, py + 1.5, 125, 18);
      const t = names[i] ?? (i === 0 && top && !total ? '(vazio)' : '');
      if (t) { x.fillStyle = '#1f2a36'; x.textAlign = 'center'; x.textBaseline = 'middle'; fitText(x, t, px + 64, py + 11.5, 120, 17, '700', '"Trebuchet MS", "Arial Narrow", sans-serif'); }
    }
  }

  function drawObraBoard(cv, c, embargo) {
    const x = cv.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = embargo ? '#f3d2cc' : '#ffd23f'; x.fillRect(0, 0, 256, 192);
    // listras de advertência
    x.save(); x.beginPath(); x.rect(0, 0, 256, 26); x.rect(0, 166, 256, 26); x.clip();
    x.fillStyle = '#1b1b1b'; for (let i = -10; i < 20; i++) { x.beginPath(); x.moveTo(i * 26, 0); x.lineTo(i * 26 + 13, 0); x.lineTo(i * 26 - 13, 192); x.lineTo(i * 26 - 26, 192); x.fill(); }
    x.restore();
    x.fillStyle = '#1b1b1b'; x.textAlign = 'center'; x.textBaseline = 'middle';
    fitText(x, embargo ? 'EMBARGADA' : 'EM OBRAS', 128, 48, 230, 30, '800', '"Trebuchet MS", sans-serif');
    if (!c) return;
    fitText(x, c.display, 128, 80, 230, 18, '700', '"Trebuchet MS", sans-serif');
    if (!embargo) {
      x.fillStyle = '#fff'; x.fillRect(20, 100, 216, 26); x.strokeStyle = '#1b1b1b'; x.lineWidth = 3; x.strokeRect(20, 100, 216, 26);
      x.fillStyle = '#2d8a4e'; x.fillRect(22, 102, 212 * (c.pct / 100), 22);
      x.fillStyle = '#1b1b1b'; x.font = '800 18px "Trebuchet MS", sans-serif'; x.fillText(`${c.pct}%`, 128, 114);
      fitText(x, c.phase, 128, 146, 230, 15, '600', '"Trebuchet MS", sans-serif');
    } else fitText(x, (c.error || '').slice(0, 60), 128, 120, 236, 13, '600', '"Trebuchet MS", sans-serif');
  }

  function makeWorker() {
    const parts = [
      colorBox(0.36, 0.5, 0.22, '#f28c28', 0, 1.15, 0),            // colete laranja
      colorBox(0.37, 0.05, 0.23, '#e8e8e8', 0, 1.2, 0),            // faixa refletiva
      colorBox(0.14, 0.62, 0.14, '#2f4a7a', -0.09, 0.62, 0), colorBox(0.14, 0.62, 0.14, '#2f4a7a', 0.09, 0.62, 0),   // calça jeans
      colorBox(0.16, 0.1, 0.24, '#5a3a22', -0.09, 0.05, 0.03), colorBox(0.16, 0.1, 0.24, '#5a3a22', 0.09, 0.05, 0.03), // botas
      colorBox(0.26, 0.28, 0.26, '#d9a77f', 0, 1.56, 0),           // cabeça
      colorBox(0.03, 0.03, 0.01, '#1b1b1b', -0.06, 1.58, 0.13), colorBox(0.03, 0.03, 0.01, '#1b1b1b', 0.06, 1.58, 0.13),
      colorBox(0.12, 0.03, 0.01, '#6b3b2a', 0, 1.5, 0.13),         // bigode
      colorBox(0.09, 0.45, 0.09, '#f28c28', -0.24, 1.18, 0),       // braço esquerdo
    ];
    const hat = new THREE.SphereGeometry(0.17, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); hat.scale(1, 0.8, 1.05); hat.translate(0, 1.69, 0); addColor(hat, '#ffd23f');
    const brim = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 10); brim.translate(0, 1.69, 0.02); addColor(brim, '#ffd23f');
    parts.push(hat, brim);
    const g = new THREE.Group(); g.name = 'operario';
    const body = new THREE.Mesh(mergeGeometries(parts, false), vcMat);
    parts.forEach(p => p.dispose());
    g.add(body);
    const armParts = [colorBox(0.09, 0.45, 0.09, '#f28c28', 0, -0.2, 0), colorBox(0.03, 0.3, 0.03, '#7a5230', 0, -0.42, 0.12), colorBox(0.12, 0.06, 0.05, '#555', 0, -0.42, 0.27)];
    const arm = new THREE.Mesh(mergeGeometries(armParts, false), vcMat); armParts.forEach(p => p.dispose());
    arm.position.set(0.24, 1.38, 0);
    g.add(arm);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.34, 12), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.2, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01; g.add(blob);
    return { group: g, arm };
  }

  function disposeObj(o) {
    o.traverse(n => {
      if (n.isSprite) { api.disposeLabel(n); return; }
      if (n.geometry && !n.geometry.userData?.shared) n.geometry.dispose();
      if (n.material && !n.material.userData?.shared) { if (!n.material.userData?.keepMap) n.material.map?.dispose(); n.material.dispose(); }
      if (n.isInstancedMesh) n.dispose();
    });
  }

  // ================================================================ geometrias compartilhadas (vertex colors)
  function buildGeometries() {
    const merged = parts => { const g = mergeGeometries(parts, false); parts.forEach(p => p.dispose()); g.userData.shared = true; return g; };
    // mesa de reunião 4×2 (origem no chão, centro)
    const table = merged([
      colorBox(3.92, 0.05, 1.9, '#6e4b2e', 0, 0.735, 0), colorBox(3.96, 0.03, 1.94, '#4d3321', 0, 0.705, 0),
      colorBox(0.55, 0.67, 0.95, '#43464c', -1.2, 0.355, 0), colorBox(0.55, 0.67, 0.95, '#43464c', 1.2, 0.355, 0),
      colorBox(0.75, 0.03, 1.25, '#2f3136', -1.2, 0.015, 0), colorBox(0.75, 0.03, 1.25, '#2f3136', 1.2, 0.015, 0),
      colorBox(0.34, 0.006, 0.12, '#222428', 0, 0.763, 0),
    ]);
    // cadeira de escritório (frente +Z; encosto em −Z)
    const star = new THREE.CylinderGeometry(0.3, 0.3, 0.035, 5); star.translate(0, 0.07, 0); addColor(star, '#1d1f23');
    const stem = new THREE.CylinderGeometry(0.03, 0.03, 0.36, 4, 1, true); stem.translate(0, 0.27, 0); addColor(stem, '#9aa0a6');
    const chair = merged([   // ~76 triângulos: assento, encosto, 2 braços, coluna, base estrela
      star, stem, colorBox(0.48, 0.08, 0.46, '#2b2f36', 0, 0.47, 0.01), colorBox(0.46, 0.56, 0.07, '#2b2f36', 0, 0.8, -0.23),
      colorBox(0.05, 0.2, 0.28, '#1d1f23', -0.27, 0.6, -0.01), colorBox(0.05, 0.2, 0.28, '#1d1f23', 0.27, 0.6, -0.01),
    ]);
    // quadro branco 2,5 m (local x −0,7) + TV (local x +1,35), origem na face da parede, frente +Z
    const board = merged([
      colorBox(2.5, 1.1, 0.015, '#eef1f1', -0.7, 1.45, 0.009),
      colorBox(2.56, 0.04, 0.035, '#b9bdc2', -0.7, 2.02, 0.018), colorBox(2.56, 0.04, 0.035, '#b9bdc2', -0.7, 0.88, 0.018),
      colorBox(0.04, 1.18, 0.035, '#b9bdc2', -1.97, 1.45, 0.018), colorBox(0.04, 1.18, 0.035, '#b9bdc2', 0.57, 1.45, 0.018),
      colorBox(1.1, 0.025, 0.08, '#b9bdc2', -0.7, 0.87, 0.05),
      colorBox(0.12, 0.02, 0.02, '#c0262d', -0.95, 0.893, 0.05), colorBox(0.12, 0.02, 0.02, '#1f4fa8', -0.78, 0.893, 0.05),
      colorBox(0.12, 0.02, 0.02, '#222', -0.6, 0.893, 0.05), colorBox(0.14, 0.05, 0.04, '#3a78c2', -0.35, 0.905, 0.05),
      colorBox(1.05, 0.62, 0.05, '#15171a', 1.35, 1.55, 0.03), colorBox(0.2, 0.2, 0.03, '#2a2d31', 1.35, 1.55, 0.005),
      colorBox(0.12, 0.02, 0.01, '#3a3d42', 1.35, 1.255, 0.056),
    ]);
    // aparador (credenza) com planta e caneca — frente +Z
    const pot = new THREE.CylinderGeometry(0.11, 0.08, 0.2, 7); pot.translate(0.55, 0.85, 0); addColor(pot, '#b5653a');
    const leaves = new THREE.SphereGeometry(0.22, 6, 4); leaves.scale(1, 1.3, 1); leaves.translate(0.55, 1.12, 0); addColor(leaves, '#4f8a4a');
    const mug = new THREE.CylinderGeometry(0.04, 0.04, 0.1, 6); mug.translate(-0.62, 0.8, 0.05); addColor(mug, '#f4f1ea');
    const credenza = merged([
      colorBox(1.6, 0.7, 0.42, '#8a6a48', 0, 0.36, 0), colorBox(1.64, 0.035, 0.46, '#6e4b2e', 0, 0.73, 0),
      colorBox(0.01, 0.6, 0.005, '#5a4230', 0, 0.36, 0.212), colorBox(0.03, 0.1, 0.02, '#c9ccd0', -0.06, 0.45, 0.22), colorBox(0.03, 0.1, 0.02, '#c9ccd0', 0.06, 0.45, 0.22),
      colorBox(1.5, 0.02, 0.36, '#3a2a1c', 0, 0.01, 0), pot, leaves, mug,
    ]);
    // arquivo de aço 4 gavetas (frente +Z)
    const cab = [colorBox(0.5, 1.32, 0.62, '#9ea4a3', 0, 0.66, 0)];
    for (let i = 0; i < 4; i++) {
      const y = 0.18 + i * 0.31;
      cab.push(colorBox(0.45, 0.29, 0.02, '#b3b8b6', 0, y, 0.315), colorBox(0.17, 0.025, 0.035, '#5f6467', 0, y - 0.04, 0.335), colorBox(0.3, 0.064, 0.006, '#7d8285', 0, y + 0.09, 0.327));
    }
    const cabinet = merged(cab);
    // pilha de papel (altura 1 → escala Y) com pasta manila embaixo
    const paper = merged([colorBox(0.3, 0.92, 0.22, '#f6f3ea', 0, 0.54, 0), colorBox(0.33, 0.08, 0.25, '#d8b56a', 0, 0.04, 0)]);
    // caixa de pastas suspensas (arame) + pasta (branca → instanceColor)
    const crate = merged([colorBox(0.3, 0.015, 0.3, '#3d4046', 0, 0.008, 0), colorBox(0.3, 0.14, 0.012, '#3d4046', 0, 0.07, 0.15),
      colorBox(0.3, 0.14, 0.012, '#3d4046', 0, 0.07, -0.15), colorBox(0.012, 0.14, 0.3, '#3d4046', 0.15, 0.07, 0), colorBox(0.012, 0.14, 0.3, '#3d4046', -0.15, 0.07, 0)]);
    const folder = merged([colorBox(0.016, 0.2, 0.27, '#ffffff', 0, 0.1, 0), colorBox(0.016, 0.04, 0.07, '#ffffff', 0, 0.22, 0.07)]);
    // telefone de conferência (o triângulo clássico)
    const tri = new THREE.CylinderGeometry(0.15, 0.17, 0.035, 3); tri.translate(0, 0.018, 0); addColor(tri, '#2d2f33');
    const phone = merged([tri, colorBox(0.07, 0.008, 0.05, '#8fb3a0', 0, 0.04, 0.02)]);
    // tapete (branco → instanceColor = cor da sala)
    const rug = new THREE.PlaneGeometry(5.3, 3.3); rug.rotateX(-Math.PI / 2); addColor(rug, '#ffffff'); rug.userData.shared = true;
    // caixa de mudança
    const box = merged([colorBox(0.52, 0.4, 0.4, '#b88a55', 0, 0.2, 0), colorBox(0.53, 0.012, 0.08, '#d9c79b', 0, 0.401, 0)]);
    // cone de obra (origem no chão)
    return { table, chair, board, credenza, cabinet, paper, crate, folder, phone, rug, box };
  }

  function coneGeo(x, z) {
    const base = colorBox(0.36, 0.03, 0.36, '#e8641e', x, 0.015, z);
    const body = new THREE.ConeGeometry(0.14, 0.5, 8); body.translate(x, 0.28, z); addColor(body, '#f07a26');
    const band = new THREE.CylinderGeometry(0.085, 0.1, 0.08, 8); band.translate(x, 0.3, z); addColor(band, '#f4f4f4');
    const g = mergeGeometries([base, body, band], false);
    base.dispose(); body.dispose(); band.dispose();
    return g;
  }
}

// ==================================================================== utilidades puras (fora do install)
class Pool {
  // InstancedMesh persistente que cresce sob demanda: begin() → add(matriz, cor?) → end()
  constructor(geo, mat, name, colored = false) { this.geo = geo; this.mat = mat; this.name = name; this.colored = colored; this.mesh = null; this.cap = 0; this.items = []; this.parent = null; }
  begin() { this.items.length = 0; }
  add(m, color) { this.items.push([m.clone(), color ? color.clone() : null]); }
  end() {
    const n = this.items.length;
    if (!this.mesh || n > this.cap) {
      if (this.mesh) { this.mesh.removeFromParent(); this.mesh.dispose(); }
      this.cap = Math.max(8, Math.ceil(n * 1.5));
      this.mesh = new THREE.InstancedMesh(this.geo, this.mat, this.cap);
      this.mesh.name = `salas:${this.name}`;
      this.parent.add(this.mesh);
    }
    const white = new THREE.Color('#ffffff');
    this.items.forEach(([m, c], i) => { this.mesh.setMatrixAt(i, m); if (this.colored) this.mesh.setColorAt(i, c || white); });
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.boundingSphere = null;      // recalcula (frustum culling por instâncias)
    if (n) this.mesh.computeBoundingSphere();
  }
}

const _c = new THREE.Color();
function addColor(geo, color) {
  _c.set(color);
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = _c.r; a[i * 3 + 1] = _c.g; a[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}
function colorBox(w, h, d, color, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return addColor(g, color);
}

// quad com UV num retângulo do atlas 512×512 (px) — frente +Z girada por yaw
function R(px, py, pw, ph, S = 512) { return [px / S, 1 - (py + ph) / S, (px + pw) / S, 1 - py / S]; }
function quad(w, h, [u0, v0, u1, v1], x, y, z, yaw) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

function canvasTex(canvas, mip = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  if (!mip) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  t.userData.shared = true;
  return t;
}

function roundRect(x, X, Y, W, H, r) {
  x.beginPath(); x.moveTo(X + r, Y); x.lineTo(X + W - r, Y); x.quadraticCurveTo(X + W, Y, X + W, Y + r); x.lineTo(X + W, Y + H - r);
  x.quadraticCurveTo(X + W, Y + H, X + W - r, Y + H); x.lineTo(X + r, Y + H); x.quadraticCurveTo(X, Y + H, X, Y + H - r); x.lineTo(X, Y + r);
  x.quadraticCurveTo(X, Y, X + r, Y); x.closePath();
}
function fitText(x, text, cx, cy, maxW, size, weight, family, align = 'center') {
  let s = size;
  const t = String(text ?? '');
  do { x.font = `${weight} ${s}px ${family}`; if (x.measureText(t).width <= maxW) break; s -= 2; } while (s > 9);
  let out = t;
  if (x.measureText(out).width > maxW) { while (out.length > 1 && x.measureText(`${out}…`).width > maxW) out = out.slice(0, -1); out += '…'; }
  x.textAlign = align;
  x.fillText(out, cx, cy);
}

function makeRugTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 80;
  const x = c.getContext('2d');
  x.fillStyle = '#d9d9d9'; x.fillRect(0, 0, 128, 80);
  x.strokeStyle = '#f2f2f2'; x.lineWidth = 3; x.strokeRect(6, 6, 116, 68);
  x.strokeStyle = '#bdbdbd'; x.lineWidth = 2; x.strokeRect(11, 11, 106, 58);
  for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; x.fillRect(Math.random() * 128, Math.random() * 80, 1, 1); }
  const t = canvasTex(c, true); return t;
}
function makeBlindTexture() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 32;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 16, 32);
  x.fillStyle = '#e9e3d3'; x.fillRect(0, 0, 16, 21);
  x.fillStyle = '#cfc8b6'; x.fillRect(0, 18, 16, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter; t.userData.shared = true;
  return t;
}
function makeTapeTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#ffd23f'; x.fillRect(0, 0, 64, 16);
  x.fillStyle = '#1b1b1b';
  for (let i = -1; i < 5; i++) { x.beginPath(); x.moveTo(i * 16, 16); x.lineTo(i * 16 + 8, 16); x.lineTo(i * 16 + 16, 0); x.lineTo(i * 16 + 8, 0); x.fill(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.userData.shared = true;
  return t;
}

// ---------------------------------------------------------------- extensões: cor e ícone
const EXT_COLORS = { '.js': '#e8c547', '.mjs': '#e8c547', '.cjs': '#e8c547', '.jsx': '#61b3d6', '.ts': '#3a78c2', '.tsx': '#3a78c2',
  '.py': '#3b6fa8', '.md': '#7d8fa3', '.json': '#a07d4f', '.html': '#e2663a', '.htm': '#e2663a', '.css': '#6a4fb3', '.scss': '#c6538c',
  '.go': '#4fb8d8', '.rs': '#b7572e', '.java': '#c0392b', '.kt': '#8e5bd8', '.c': '#5c6bc0', '.h': '#7986cb', '.cpp': '#3f51b5',
  '.cs': '#5b3f9e', '.php': '#7a86b8', '.rb': '#b0302a', '.sh': '#5a9e4a', '.yml': '#b04f8f', '.yaml': '#b04f8f', '.toml': '#9c6b3f',
  '.vue': '#41b883', '.svelte': '#ff3e00', '.dart': '#2fb5d0', '.swift': '#f05138', '.sql': '#d08c30', '.txt': '#9aa3ab',
  '.png': '#4caf93', '.jpg': '#4caf93', '.svg': '#f2a33a', '.lock': '#8d8d8d', '(sem)': '#b0a58f', '.p': '#2e7d6e', '.w': '#2e7d6e', '.i': '#2e7d6e' };
const PALETTE = ['#c2553a', '#3a8fc2', '#6aa84f', '#b58b2a', '#8e63b5', '#2aa198', '#c2417a', '#7a8b99'];
function extColor(ext) {
  if (EXT_COLORS[ext]) return EXT_COLORS[ext];
  let h = 0; for (const ch of String(ext)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function fileIcon(name) {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(n)) return '🖼';
  if (/\.(md|markdown|txt|rst)$/.test(n) || n.startsWith('readme')) return '📝';
  if (/\.(zip|gz|tgz|rar|7z|tar|jar)$/.test(n)) return '📦';
  if (/\.(json|ya?ml|toml|ini|env|conf|cfg|lock)$/.test(n)) return '⚙';
  if (/\.(pdf|docx?|xlsx?|pptx?)$/.test(n)) return '📑';
  return '📄';
}

// ---------------------------------------------------------------- realce simples (escapa CADA pedaço)
const KW = new Set(('const let var function return if else for while do switch case break continue new class extends import from export default ' +
  'async await try catch finally throw typeof instanceof in of this super null undefined true false def lambda pass yield with as elif not and or is ' +
  'None True False self package func type struct interface go defer chan map range fn pub use mod impl trait match enum static void int float double ' +
  'char bool boolean string public private protected final abstract echo fi then esac done local select where insert update delete create table ' +
  'define procedure end find each first last no-lock assign display run input output').split(' '));
const HASH_LANG = new Set(['py', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'rb', 'pl', 'r', 'conf', 'ini', 'cfg', 'env', 'dockerfile', 'makefile', 'mk', 'gitignore', 'properties']);
const XML_LANG = new Set(['html', 'htm', 'xml', 'vue', 'svg', 'svelte', 'xhtml']);
function codeHtml(src, ext, rel) {
  const base = rel.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') ext = base;
  const lines = src.split('\n');
  const gutter = lines.map((_, i) => i + 1).join('\n');
  const body = src.length > 150000 ? escHtml(src) : highlight(src, ext);
  return `<div class="sl-code"><pre class="sl-gut" aria-hidden="true">${gutter}</pre><pre class="sl-src"><code>${body}</code></pre></div>`;
}
function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function highlight(src, ext) {
  let re;
  if (XML_LANG.has(ext)) re = /(<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(<\/?[A-Za-z][\w:.-]*|\/?>)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$-]*)/g;
  else if (HASH_LANG.has(ext)) re = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[\w.]+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  else if (ext === 'sql') re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|(@\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g;
  else if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === '') re = /(^#{1,6} [^\n]*)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\b\d+(?:\.\d+)?\b)|(\bhttps?:\/\/\S+)/gm;
  else re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(@[\w.]+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m, guard = 0;
  while ((m = re.exec(src)) && guard++ < 400000) {
    if (m.index === re.lastIndex) { re.lastIndex++; continue; }
    out += escHtml(src.slice(last, m.index));
    const t = escHtml(m[0]);
    if (m[1]) out += `<span class="c">${t}</span>`;
    else if (m[2]) out += `<span class="s">${t}</span>`;
    else if (m[3]) out += `<span class="t">${t}</span>`;
    else if (m[4]) out += `<span class="n">${t}</span>`;
    else if (m[5]) out += KW.has(m[5]) || KW.has(m[5].toLowerCase()) && ext === 'sql' ? `<span class="k">${t}</span>` : t;
    else out += t;
    last = re.lastIndex;
  }
  return out + escHtml(src.slice(last));
}

// ---------------------------------------------------------------- CSS (prefixo sl-)
function injectCss() {
  if (document.getElementById('sl-css')) return;
  const s = document.createElement('style');
  s.id = 'sl-css';
  s.textContent = `
  .sl-panel .sl-pad { padding: 14px 16px; }
  .sl-new { padding: 12px 16px 16px; }
  .sl-tabs { display: flex; gap: 6px; margin-bottom: 12px; border-bottom: 2px solid var(--line); }
  .sl-tabs button { border: 0 !important; background: transparent !important; padding: 8px 14px !important; border-radius: 6px 6px 0 0 !important; color: var(--muted) !important; font-weight: 700; }
  .sl-tabs button.on { background: var(--navy) !important; color: #fff !important; }
  .sl-form label { display: block; font-weight: 700; margin: 10px 0 4px; color: var(--navy); }
  .sl-form label small { font-weight: 400; color: var(--muted); }
  .sl-form input:not([type=checkbox]), .sl-form textarea { display: block; width: 100%; margin-top: 4px; font-weight: 400; }
  .sl-form .sl-check { font-weight: 400; color: var(--ink); display: flex; gap: 8px; align-items: center; }
  .sl-hint { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
  .sl-hint.bad { color: var(--danger); font-weight: 700; }
  .sl-err { color: var(--danger); min-height: 1.2em; margin-top: 8px; font-size: 13px; }
  .sl-err.big { background: #fbe3df; border: 1px solid #e7a39b; padding: 8px 10px; border-radius: 6px; font-size: 14px; }
  .sl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  #pn-body .sl-primary { background: var(--navy); color: #fff; border-color: var(--navy); font-weight: 700; padding: 7px 16px; }
  #pn-body .sl-primary:hover { background: var(--navy-2); }
  #pn-body .sl-danger { color: var(--danger); border-color: #e7a39b; }
  .sl-bar { position: relative; height: 8px; background: #e2dccb; border-radius: 4px; overflow: hidden; }
  .sl-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: repeating-linear-gradient(45deg, #e8a33a 0 10px, #f2c05a 10px 20px); transition: width .4s; }
  .sl-bar.big { height: 26px; border: 2px solid var(--ink); border-radius: 4px; margin: 12px 0 6px; }
  .sl-bar.big span { position: absolute; inset: 0; display: grid; place-items: center; font-weight: 800; }
  .sl-bar.done i { background: #3e7d4f; } .sl-bar.error i { background: #b03a2e; } .sl-bar.cancelled i { background: #9aa3ab; }
  .sl-clone-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 16px; }
  .sl-clone-head span { color: var(--muted); font-size: 13px; }
  .sl-phase { color: var(--muted); }
  .sl-log { background: #22303f; color: #cfe3f7; border-radius: 6px; margin-top: 10px !important; max-height: 150px; overflow: auto; font-size: 11.5px !important; }
  .sl-hud { padding: 6px 10px; min-width: 200px; cursor: pointer; font-size: 12.5px; }
  .sl-hud-row { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
  .sl-hud-row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
  .sl-hud-row.err { color: var(--danger); }
  .sl-files #pn-body { overflow: hidden; }
  .sl-fb { display: grid; grid-template-columns: minmax(200px, 300px) 1fr; height: 100%; min-height: 0; }
  .sl-tree { overflow: auto; border-right: 1px solid var(--line); background: #f6f1e4; padding: 6px 0; font-size: 13px; }
  .sl-row { display: flex; align-items: center; gap: 2px; padding: 1px 8px 1px calc(8px + var(--d) * 14px); white-space: nowrap; }
  .sl-row.sel { background: #e7dcc0; }
  .sl-row.muted { color: #9a9280; font-size: 12px; }
  .sl-row .sl-name { cursor: pointer; overflow: hidden; text-overflow: ellipsis; flex: 1; padding: 2px 3px; border-radius: 3px; }
  .sl-row .sl-name:hover { background: #ece3cb; }
  .sl-caret { width: 14px; flex: none; cursor: pointer; color: var(--muted); text-align: center; }
  .sl-view { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .sl-vbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--paper-2); }
  .sl-crumbs { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .sl-crumbs span { color: var(--muted); margin: 0 3px; }
  #pn-body .sl-link { border: 0; background: none; padding: 0; color: var(--navy-2); cursor: pointer; text-decoration: underline; font: inherit; }
  .sl-vbody { flex: 1; overflow: auto; min-height: 0; }
  .sl-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .sl-table th { text-align: left; position: sticky; top: 0; background: var(--paper); border-bottom: 1px solid var(--line); padding: 6px 10px; color: var(--muted); font-weight: 600; }
  .sl-table td { padding: 4px 10px; border-bottom: 1px solid rgba(31,58,95,.07); }
  .sl-table tr[data-go] { cursor: pointer; } .sl-table tr[data-go]:hover { background: #f1e9d4; }
  .sl-table tr.muted { color: #9a9280; }
  .sl-table td:nth-child(2), .sl-table td:nth-child(3) { color: var(--muted); white-space: nowrap; width: 1%; }
  .sl-fhead { display: flex; gap: 12px; align-items: center; padding: 6px 12px; font-size: 12.5px; color: var(--muted); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .sl-fhead span:first-child { font-weight: 700; color: var(--ink); }
  .sl-badge { background: #fff4b8; border: 1px solid #e0c96a; border-radius: 3px; padding: 0 6px; color: var(--ink); }
  .sl-code { display: flex; font: 12.5px/1.5 ui-monospace, Consolas, monospace; background: #fdfcf8; min-width: max-content; }
  #pn-body .sl-code pre { margin: 0; padding: 10px 12px; white-space: pre; word-break: normal; font: inherit; }
  #pn-body .sl-gut { color: #b4ab96; text-align: right; user-select: none; border-right: 1px solid #ece4d0; background: #f7f2e6; padding-right: 8px !important; }
  .sl-src .c { color: #8a8f7a; font-style: italic; } .sl-src .s { color: #9a4f1c; } .sl-src .k { color: #1f4fa8; font-weight: 700; }
  .sl-src .n { color: #2d7d4f; } .sl-src .t { color: #8e3b8a; }
  .sl-img { padding: 16px; text-align: center; background: repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 20px 20px; }
  .sl-img img { max-width: 100%; max-height: 62vh; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
  .sl-sum { padding: 14px 16px; }
  .sl-sum-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .sl-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .sl-card h4, .sl-readme-h { margin: 0 0 6px; color: var(--navy); }
  .sl-readme-h { margin-top: 16px; border-bottom: 2px solid var(--line); padding-bottom: 4px; }
  .sl-card p { margin: 4px 0; }
  .sl-card code { word-break: break-all; }
  .sl-ext { display: grid; grid-template-columns: 12px 64px 1fr 40px; gap: 6px; align-items: center; font-size: 12.5px; margin: 3px 0; }
  .sl-ext i { width: 12px; height: 12px; border-radius: 3px; } .sl-ext b { height: 10px; border-radius: 3px; display: block; } .sl-ext small { color: var(--muted); text-align: right; }
  .sl-muted { color: var(--muted); } .sl-warn { color: var(--danger); }
  @media (max-width: 700px) { .sl-fb { grid-template-columns: 1fr; grid-template-rows: 38% 62%; } .sl-tree { border-right: 0; border-bottom: 1px solid var(--line); } }
  `;
  document.head.append(s);
}
