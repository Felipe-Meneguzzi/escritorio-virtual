// ============================================================ createApi() — o objeto entregue às features
// Regra: features usam SÓ `api` (e `import * as THREE from 'three'`). Não importe js/core/* nem js/office/*.
// Faltou algo? Acrescente aqui (e no ARCH.md) em vez de contornar com DOM/monkey-patch.
import * as THREE from 'three';
import { scene, camera, renderer, disposeTree, frameStats, hemi, sun, setSky } from './scene.js';
import * as Q from './quality.js';
import { on, off, once, emit } from './events.js';
import { request, blobUrl, toast, esc, clamp, lerp, damp, dampAngle, hashStr, rng, pick, fmtSize, fmtDate, fmtAgo, fmtUsd, wrapAngle, isTyping, safeCall } from './util.js';
import { registerKey, isKeyFree, listKeys } from './input.js';
import { addInteractable } from './interact.js';
import { openPanel, closePanel, isPanelOpen } from './panel.js';
import { hudSlot } from './hud.js';
import { addMinimapMarker } from './minimap.js';
import { longPoll, stream, watch } from './live.js';
import { renderMarkdown } from './markdown.js';
import { makeLabel, setLabel, disposeLabel } from './labels.js';
import { addCollider, resolveCircle, blockedAt, raycast } from './collision.js';
import { player, teleport, emote, cameraRig } from './player.js';
import { buildCharacter, provideCharacterFactory, hasCustomFactory, STATES } from './characters.js';
import { office, layoutGroup, setPlaceholderVisible, refreshLayout, getRoomAt, getAreaAt, roomById, roomByName, walkable, getNav } from '../office/office.js';
import * as L from '../office/layout.js';

const characters = new Set();   // bonecos gerenciados pelo núcleo (update automático)
export const liveCharacters = () => characters;

export function createApi() {
  const findPath = (from, to) => getNav()?.findPath(from, to) || null;
  const charCtx = { findPath, makeLabel, setLabel, disposeLabel, quality: { tier: Q.tierName, ...Q.tier }, hashStr, rng, THREE, scene, on,
    addToScene: obj => { scene.add(obj); return obj; } };

  const api = {
    version: 1,
    THREE, scene, camera, renderer,
    lights: { hemi, sun },                        // HemisphereLight + DirectionalLight do núcleo (ajuste leve de cor/intensidade)
    setSky,                                       // (cor | null) → fundo "lá fora" sem mexer na névoa; null volta ao padrão
    view: cameraRig,                              // câmera 3ª pessoa (só leitura): yaw, pitch, dist atual, pivotY (altura do pivô)
    // ---- eventos
    on, off, once, emit,
    // ---- escritório / layout
    office,
    get layout() { return office.layout; },
    getRoomAt, getAreaAt, roomById, roomByName,
    get currentRoom() { return getRoomAt(player.x, player.z); },
    refreshLayout,
    layoutGroup,                                  // (dono) → THREE.Group esvaziado (geometrias descartadas) a cada rebuild
    addToScene: obj => { scene.add(obj); return obj; },
    removeFromScene: obj => { obj?.removeFromParent(); },
    disposeTree,
    setPlaceholderVisible,
    officeMaterials: office.materials,
    consts: { WALL_H: L.WALL_H, CEIL_H: L.CEIL_H, WALL_T: L.WALL_T, DOOR_H: L.DOOR_H, PART_H: L.PART_H, RW: L.RW, RD: L.RD },
    layoutLib: { generateLayout: L.generateLayout, wallBoxes: L.wallBoxes, furnitureBoxes: L.furnitureBoxes, roomAt: L.roomAt, faceYaw: L.faceYaw, cellOf: L.cellOf, cellCenter: L.cellCenter },
    // ---- navegação e colisão
    findPath,
    isWalkable: walkable,
    nearestWalkable: (x, z) => getNav()?.nearestFree(x, z) || null,
    lineOfSight: (a, b) => getNav()?.lineOfSight(a, b) ?? false,
    blockNavCell: (x, z) => getNav()?.block(x, z) || (() => {}),   // some no rebuild (nav nova)
    addCollider,                                  // ({x0,x1,z0,z1,y0?,y1?}, {layout}) → remove()
    resolveCircle, blockedAt, raycast,
    // ---- jogador
    player: {
      get x() { return player.x; }, get z() { return player.z; }, get yaw() { return player.yaw; },
      get position() { return { x: player.x, z: player.z }; },
      get character() { return player.char; },
      get speed() { return player.speed; },
      teleport, emote,
      freeze(v = true) { player.frozen = !!v; },
      setVisible(v = true) { player.hidden = !v; },
      get visible() { return !player.hidden; },
      get frozen() { return player.frozen; },
    },
    // ---- personagens
    createCharacter(opts = {}) {
      const c = buildCharacter(opts, charCtx);
      if (!opts.manual) {
        scene.add(c.group);
        characters.add(c);
        const orig = c.dispose.bind(c);
        c.dispose = () => { characters.delete(c); safeCall('personagem.dispose', orig); c.group.removeFromParent(); };
      }
      return c;
    },
    provideCharacterFactory,
    get hasCharacterFactory() { return hasCustomFactory(); },
    characterStates: STATES,
    // ---- interação / UI
    addInteractable,
    registerKey, isKeyFree, listKeys, isTyping,
    openPanel, closePanel, isPanelOpen,
    toast,
    hudSlot,
    addMinimapMarker,
    makeLabel, setLabel, disposeLabel,
    markdown: renderMarkdown,                     // markdown SEGURO → HTML
    // ---- servidor
    request, blobUrl,
    longPoll, stream, watch,
    // ---- utilidades
    util: { esc, clamp, lerp, damp, dampAngle, hashStr, rng, pick, fmtSize, fmtDate, fmtAgo, fmtUsd, wrapAngle, safeCall },
    quality: { get tier() { return Q.tierName; }, get detail() { return Q.tier.detail; }, get npcAnimDist() { return Q.tier.npcAnimDist; }, get gpu() { return Q.gpu.name; } },
    stats: frameStats,
  };
  return api;
}
