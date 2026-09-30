// ============================================================ geometria da planta (piso, paredes, placeholders)
// Tudo estático e MESCLADO: um Mesh por material (poucos draw calls, constante com o nº de salas).
// Os PLACEHOLDERS (móveis em caixa, cadeiras, placa, rótulos das salas, vaga nova) existem para a planta não ficar
// vazia antes dos pacotes "ambiente"/"salas"; cada grupo pode ser escondido com api.setPlaceholderVisible(nome, false).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { wallBoxes, furnitureBoxes, chairCells, roomAt, WALL_H } from './layout.js';
import { makeLabel } from '../core/labels.js';

// materiais da planta: features podem recolorir (api.officeMaterials.wall.color.set('#...'))
export const MATS = {
  floor: new THREE.MeshLambertMaterial({ color: '#7f8b98' }),
  wall: new THREE.MeshLambertMaterial({ color: '#e6ddc8' }),
  post: null, lintel: null,
  partition: new THREE.MeshLambertMaterial({ color: '#cbbd9c' }),
  glass: new THREE.MeshLambertMaterial({ color: '#a9cfc0', transparent: true, opacity: 0.3, depthWrite: false }),
  entrance: new THREE.MeshLambertMaterial({ color: '#8fbfb0', transparent: true, opacity: 0.42, depthWrite: false }),
  outside: new THREE.MeshLambertMaterial({ color: '#9aa29a' }),
};
MATS.post = MATS.wall; MATS.lintel = MATS.wall;
for (const m of Object.values(MATS)) m.userData.shared = true;

// cores dos placeholders por caractere do layout
const PH_COLOR = { R: '#8b6a4a', S: '#6f7f5a', P: '#4f8a4a', K: '#b9a988', C: '#3d3d3d', O: '#bcd8e6', F: '#e8e8e8', X: '#c9c9c0',
  T: '#a8845c', c: '#bfb398', B: '#8fa1b3', h: '#2f3540' };
export const PLACEHOLDER_GROUPS = ['R', 'S', 'P', 'K', 'C', 'O', 'F', 'X', 'T', 'c', 'B', 'chairs', 'roomChairs', 'sign', 'roomLabels', 'newSlot'];

function boxGeo(b) {
  const w = b.x1 - b.x0, h = (b.y1 ?? 1) - (b.y0 ?? 0), d = b.z1 - b.z0;
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate((b.x0 + b.x1) / 2, (b.y0 ?? 0) + h / 2, (b.z0 + b.z1) / 2);
  return g;
}
function mergedMesh(list, material, name) {
  if (!list.length) return null;
  const geos = list.map(boxGeo);
  const g = mergeGeometries(geos, false);
  for (const x of geos) x.dispose();
  const m = new THREE.Mesh(g, material);
  m.name = name; m.matrixAutoUpdate = false; m.updateMatrix();
  return m;
}

function signTexture(name) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 192;
  const x = c.getContext('2d');
  x.fillStyle = '#1f3a5f'; x.fillRect(0, 0, 1024, 192);
  x.strokeStyle = '#d9a441'; x.lineWidth = 8; x.strokeRect(10, 10, 1004, 172);
  x.fillStyle = '#f7f1e3'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let size = 92;
  do { x.font = `700 ${size}px "Trebuchet MS", "Segoe UI", sans-serif`; size -= 4; } while (x.measureText(name).width > 940 && size > 30);
  x.fillText(name, 512, 100);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  return t;
}

// buildOffice(lay, { name, rooms }) → { group, placeholders: {nome: Object3D}, colliders: [caixas], walls, furniture, dispose() }
export function buildOffice(lay, { name = 'Escritório', rooms = [] } = {}) {
  const group = new THREE.Group(); group.name = 'planta';
  const ph = {};
  const addPh = (key, obj) => { if (!obj) return; obj.name = `placeholder:${key}`; ph[key] = obj; group.add(obj); };

  // piso (1 quad) + calçada na frente da entrada
  const floorG = new THREE.PlaneGeometry(lay.W, lay.D); floorG.rotateX(-Math.PI / 2); floorG.translate(lay.W / 2, 0, -lay.D / 2);
  const floor = new THREE.Mesh(floorG, MATS.floor); floor.name = 'piso'; group.add(floor);
  const sideG = new THREE.PlaneGeometry(lay.W + 16, 10); sideG.rotateX(-Math.PI / 2); sideG.translate(lay.W / 2, -0.02, 5);
  const side = new THREE.Mesh(sideG, MATS.outside); side.name = 'calçada'; group.add(side);

  // paredes finas, uma malha por material
  const walls = wallBoxes(lay);
  const byKind = {};
  for (const b of walls) (byKind[b.kind] ||= []).push(b);
  const wallMeshes = {};
  for (const [kind, list] of Object.entries(byKind)) {
    const m = mergedMesh(list, MATS[kind] || MATS.wall, `paredes:${kind}`);
    if (m) { if (kind === 'glass' || kind === 'entrance') m.renderOrder = 2; wallMeshes[kind] = m; group.add(m); }
  }

  // móveis placeholder (colisão sempre; malha escondível)
  const furniture = furnitureBoxes(lay);
  const fByKind = {};
  for (const b of furniture) if (b.kind !== 'k') (fByKind[b.kind] ||= []).push(b);
  for (const [k, list] of Object.entries(fByKind)) {
    addPh(k, mergedMesh(list, new THREE.MeshLambertMaterial({ color: PH_COLOR[k] || '#999' }), k));
  }
  // cadeiras (não colidem)
  // 'chairs' = baias e recepção (pacote ambiente) · 'roomChairs' = mesas das salas (pacote salas)
  const chairMat = new THREE.MeshLambertMaterial({ color: PH_COLOR.h });
  const openCh = [], roomCh = [];
  for (const p of chairCells(lay)) (roomAt(lay, p.x, p.z) ? roomCh : openCh).push({ x0: p.x - 0.22, x1: p.x + 0.22, z0: p.z - 0.22, z1: p.z + 0.22, y0: 0, y1: 0.5 });
  addPh('chairs', mergedMesh(openCh, chairMat, 'cadeiras'));
  addPh('roomChairs', mergedMesh(roomCh, chairMat, 'cadeiras-salas'));

  // placa com o nome do escritório na divisória
  const s = lay.zones.sign;
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.width * 0.1875), new THREE.MeshBasicMaterial({ map: signTexture(name), fog: false }));
  signMesh.position.set(s.x, s.y, s.z + 0.01); signMesh.rotation.y = s.yaw;
  const signGroup = new THREE.Group(); signGroup.add(signMesh);
  // suportes da placa sobre o vão (a divisória é baixa)
  // cabos até o forro (placa pendurada sobre o vão)
  const cableG = new THREE.BoxGeometry(0.02, 0.2, 0.02);
  for (const dx of [-s.width / 2 + 0.3, s.width / 2 - 0.3]) { const p = new THREE.Mesh(cableG, MATS.partition); p.position.set(s.x + dx, 2.65, s.z); signGroup.add(p); }
  addPh('sign', signGroup);

  // rótulos das salas (sobre a porta, lado de fora) e a vaga "Nova sala"
  const labels = new THREE.Group();
  const byId = new Map(rooms.map(r => [r.id, r]));
  for (const r of lay.rooms) {
    const info = byId.get(r.id);
    const spr = makeLabel(info?.display || r.id, { size: 0.3, bg: '#fbf8f1', border: info?.color || '#1f3a5f', sub: info?.source?.kind === 'clone' ? 'git clone' : null });
    const out = r.door.outside;
    spr.position.set(r.door.x, WALL_H - 0.02, r.door.z + (r.door.side === 'S' ? 0.2 : -0.2));
    spr.userData.roomId = r.id;
    labels.add(spr);
    void out;
  }
  addPh('roomLabels', labels);
  if (lay.newSlot) {
    const ng = new THREE.Group();
    const spr = makeLabel('+ SALA DISPONÍVEL', { size: 0.3, bg: '#d9a441', fg: '#1f2a36', border: '#1f2a36' });
    const d = lay.newSlot.door;
    spr.position.set(d.x, WALL_H - 0.02, d.z + (d.side === 'S' ? 0.2 : -0.2));
    ng.add(spr);
    const c = lay.newSlot.center;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 8), new THREE.MeshLambertMaterial({ color: '#e87b2c' }));
    cone.position.set(c.x, 0.25, c.z); ng.add(cone);
    addPh('newSlot', ng);
  }

  // colisão: paredes (vidro e entrada inclusos) + móveis (depósito 'k' também)
  const colliders = [...walls.filter(b => b.kind !== 'lintel'), ...furniture];

  return {
    group, placeholders: ph, colliders, walls, furniture, wallMeshes, floor,
    dispose() {
      group.traverse(o => {
        if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); return; }
        if (o.geometry) o.geometry.dispose();
        if (o.material && !o.material.userData?.shared) { o.material.map?.dispose(); o.material.dispose(); }
      });
      group.removeFromParent();
    },
  };
}
