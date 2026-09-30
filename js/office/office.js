// ============================================================ escritório carregado: layout vivo, rebuild, salas
import * as THREE from 'three';
import { generateLayout, roomAt, areaAt, isWalkable } from './layout.js';
import { makeNav } from './nav.js';
import { buildOffice, MATS } from './build.js';
import * as collision from '../core/collision.js';
import { scene, disposeTree } from '../core/scene.js';
import { emit } from '../core/events.js';
import { request } from '../core/util.js';
import { clearLayoutInteractables } from '../core/interact.js';

// api.office — objeto VIVO (nunca é trocado; os campos são atualizados a cada rebuild)
export const office = {
  id: null, name: '', path: '', created: null,
  rooms: [],          // salas ocupadas, na ordem do office.json (ver ARCH.md §Salas para o formato)
  newSlot: null,      // vaga "Nova sala" (sempre existe)
  storage: [],        // vagas extras da última fileira (depósitos fechados)
  zones: {},          // entrance, spawn, reception, copa, quadro, quadroWall, copier, cubicles, sign, restrooms, wander
  layout: null,       // saída crua do generateLayout (grade, caixas, etc.)
  info: null,         // último GET /api/office/{id} (inclui campos de OFFICE_ENRICHERS: clones, staff…)
  materials: MATS,    // materiais da planta (recolorir à vontade)
};

let built = null, nav = null;
const layoutGroups = new Map();     // dono → THREE.Group (esvaziado a cada rebuild)
const hiddenPh = new Set();         // placeholders escondidos (persistem entre rebuilds)
const roomState = new Map();        // id → objeto state (persiste entre rebuilds)
const newSlotState = {};

export const getNav = () => nav;

export function layoutGroup(owner) {
  let g = layoutGroups.get(owner);
  if (!g) { g = new THREE.Group(); g.name = `layout:${owner}`; layoutGroups.set(owner, g); scene.add(g); }
  return g;
}

export function setPlaceholderVisible(names, visible) {
  for (const n of [names].flat()) {
    if (visible) hiddenPh.delete(n); else hiddenPh.add(n);
    const o = built?.placeholders[n];
    if (o) o.visible = !!visible;
  }
}

function roomObjects(lay, info) {
  const byId = new Map(info.rooms.map(r => [r.id, r]));
  const rooms = lay.rooms.map(r => {
    const i = byId.get(r.id) || {};
    if (!roomState.has(r.id)) roomState.set(r.id, {});
    return {
      ...r, id: r.id, name: i.display || r.id, display: i.display || r.id, path: i.path || '', color: i.color || '#c9b28a',
      source: i.source || { kind: 'externa' }, git: !!i.git, created: i.created || null, isNew: false,
      state: roomState.get(r.id),
    };
  });
  for (const id of [...roomState.keys()]) if (!byId.has(id)) roomState.delete(id);
  const ns = lay.newSlot ? { ...lay.newSlot, id: null, name: 'Sala disponível', display: 'Sala disponível', path: '', color: '#d9a441', isNew: true, state: newSlotState } : null;
  return { rooms, newSlot: ns };
}

function rebuild(info, { initial = false, reason = 'rooms' } = {}) {
  const prev = office.layout;
  const prevRooms = new Map(office.rooms.map(r => [r.id, r]));
  const lay = generateLayout(info.rooms.map(r => r.id));
  if (built) built.dispose();
  for (const g of layoutGroups.values()) { disposeTree(g); g.clear(); }
  clearLayoutInteractables();
  built = buildOffice(lay, { name: info.name, rooms: info.rooms });
  scene.add(built.group);
  for (const n of hiddenPh) if (built.placeholders[n]) built.placeholders[n].visible = false;
  collision.setStatic(built.colliders);
  nav = makeNav(lay);
  const { rooms, newSlot } = roomObjects(lay, info);
  Object.assign(office, {
    id: info.id, name: info.name, path: info.path, created: info.created, info,
    rooms, newSlot, storage: lay.storage, zones: lay.zones, layout: lay,
    walls: built.walls, furniture: built.furniture, bounds: lay.bounds,
  });
  const ids = new Set(rooms.map(r => r.id));
  const added = rooms.filter(r => !prevRooms.has(r.id)).map(r => r.id);
  const removed = [...prevRooms.keys()].filter(id => !ids.has(id));
  const moved = rooms.filter(r => prevRooms.has(r.id) && (prevRooms.get(r.id).rect.x0 !== r.rect.x0 || prevRooms.get(r.id).rect.z0 !== r.rect.z0)).map(r => r.id);
  const reflow = !!prev && prev.cols !== lay.cols;
  return { office, initial, reason, reflow, added, removed, moved };
}

// carrega o escritório do servidor e (re)constrói; devolve o objeto do evento 'layoutChanged' (sem emitir)
export async function loadOffice(id, opts = {}) {
  const info = await request(`/api/office/${encodeURIComponent(id)}`);
  return rebuild(info, opts);
}

let busy = null;
export function refreshLayout(opts = {}) {
  if (!office.id) return Promise.resolve(null);
  if (busy) return busy;   // pedidos em rajada viram um só
  busy = (async () => {
    try {
      const ev = await loadOffice(office.id, { reason: opts.reason || 'refresh' });
      emit('layoutChanged', ev);
      return ev;
    } finally { busy = null; }
  })();
  return busy;
}

// sondagem leve das salas (chamada quando o canal do hub esc:rooms:<id> muda)
export async function checkRooms() {
  if (!office.id) return;
  const { rooms } = await request('/api/rooms', { office: office.id });
  const now = office.info?.rooms || [];
  const same = rooms.length === now.length && rooms.every((r, i) => r.id === now[i].id && r.display === now[i].display
    && r.color === now[i].color && r.git === now[i].git && r.source?.kind === now[i].source?.kind);
  if (!same) await refreshLayout({ reason: rooms.map(r => r.id).join('\n') === now.map(r => r.id).join('\n') ? 'meta' : 'rooms' });
}

// ---------------- consultas
function wrapSlot(s) {
  if (!s) return null;
  if (s.isNew) return office.newSlot;
  return office.rooms.find(r => r.id === s.id) || null;
}
export const getRoomAt = (x, z) => (office.layout ? wrapSlot(roomAt(office.layout, x, z)) : null);
export const getAreaAt = (x, z) => (office.layout ? areaAt(office.layout, x, z) : null);
export const roomById = id => office.rooms.find(r => r.id === id) || null;
export const roomByName = name => {
  const n = String(name || '').toLowerCase();
  return office.rooms.find(r => r.name.toLowerCase() === n) || office.rooms.find(r => r.id.toLowerCase() === n) || null;
};
export const walkable = (x, z) => (office.layout ? isWalkable(office.layout, x, z) : false);
