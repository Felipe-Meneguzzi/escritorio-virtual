// ============================================================ jogador (executivo) + câmera em 3ª pessoa
import * as THREE from 'three';
import { camera } from './scene.js';
import { keys, cam, inputEnabled } from './input.js';
import { resolveCircle, raycast, blockedAt } from './collision.js';
import { damp, dampAngle } from './util.js';
import { CEIL_H } from '../office/layout.js';

export const RADIUS = 0.28;
export const WALK_SPEED = 2.4, RUN_SPEED = 5.2;
export const player = {
  x: 0, z: 0, yaw: Math.PI, vx: 0, vz: 0, speed: 0,
  char: null,                 // personagem (api.createCharacter({skin:'player'}))
  emote: null, emoteT: 0,     // estado temporário (wave, cheer...)
  frozen: false,              // true = ignora WASD (ex.: sentado numa cadeira por uma feature)
  blocked: false,             // núcleo: painel/boas-vindas aberto (WASD não anda)
  hidden: false,              // api.player.setVisible(false): esconde o boneco (cutscene, screenshot)
};

export function teleport(x, z, yaw) {
  player.x = x; player.z = z; player.vx = player.vz = 0;
  if (yaw !== undefined) { player.yaw = yaw; cam.yaw = yaw + Math.PI; }
  syncChar();
}

export function emote(state, secs = 1.6) {
  player.emote = state; player.emoteT = secs;
  player.char?.setState(state);
}

function syncChar() {
  const c = player.char;
  if (!c) return;
  c.group.position.set(player.x, 0, player.z);
  c.group.rotation.y = player.yaw;
}

export function updatePlayer(dt) {
  let f = 0, s = 0;
  if (inputEnabled() && !player.frozen && !player.blocked) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  }
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
  let mx = -sy * f + cy * s, mz = -cy * f - sy * s;
  const ml = Math.hypot(mx, mz);
  const top = run ? RUN_SPEED : WALK_SPEED;
  if (ml > 0) { mx = mx / ml * top; mz = mz / ml * top; }
  player.vx = damp(player.vx, mx, ml > 0 ? 10 : 14, dt);
  player.vz = damp(player.vz, mz, ml > 0 ? 10 : 14, dt);
  let nx = player.x + player.vx * dt, nz = player.z + player.vz * dt;
  const r = resolveCircle(nx, nz, RADIUS);
  const realV = Math.hypot(r.x - player.x, r.z - player.z) / Math.max(dt, 1e-4);
  player.x = r.x; player.z = r.z;
  player.speed = realV;
  if (ml > 0) player.yaw = dampAngle(player.yaw, Math.atan2(mx, mz), 12, dt);
  // estado do boneco
  const c = player.char;
  if (c) {
    if (player.emoteT > 0) {
      player.emoteT -= dt;
      if (ml > 0) player.emoteT = 0;
    }
    let want = player.speed > 3.2 && ml > 0 ? 'run' : ml > 0 && player.speed > 0.15 ? 'walk' : 'idle';
    if (player.emoteT > 0 && want === 'idle') want = player.emote;
    if (!player.frozen && c.state !== want) c.setState(want);
    syncChar();
  }
}

// ---------------- câmera
let curDist = 4.2;
const pivot = new THREE.Vector3();
const HEAD_Y = 1.45;
export const cameraRig = { get yaw() { return cam.yaw; }, get pitch() { return cam.pitch; }, get dist() { return curDist; }, pivotY: HEAD_Y };
export function updateCamera(dt) {
  pivot.set(player.x, HEAD_Y, player.z);
  const cp = Math.cos(cam.pitch);
  let dx = Math.sin(cam.yaw) * cp, dy = Math.sin(cam.pitch), dz = Math.cos(cam.yaw) * cp;
  // posição desejada; o forro limita a altura (a câmera desce em vez de aproximar)
  let px = pivot.x + dx * cam.dist, py = pivot.y + dy * cam.dist, pz = pivot.z + dz * cam.dist;
  py = Math.min(py, CEIL_H - 0.2); py = Math.max(py, 0.35);
  let vx = px - pivot.x, vy = py - pivot.y, vz = pz - pivot.z;
  const len = Math.hypot(vx, vy, vz) || 1;
  vx /= len; vy /= len; vz /= len;
  const hit = raycast(pivot, { x: vx, y: vy, z: vz }, len + 0.25);
  let want = len;
  if (hit < len + 0.25) want = Math.max(0.25, hit - 0.25);
  curDist = want < curDist ? want : damp(curDist, want, 5, dt);
  camera.position.set(pivot.x + vx * curDist, pivot.y + vy * curDist, pivot.z + vz * curDist);
  camera.lookAt(pivot.x, pivot.y + 0.12, pivot.z);
  if (player.char) player.char.group.visible = curDist > 0.65 && !player.hidden;
  return curDist;
}

// o jogador ficou preso (rebuild do layout)? tira para o ponto livre mais perto
export function unstick(nearestFree) {
  if (!blockedAt(player.x, player.z, RADIUS * 0.9)) return false;
  const p = nearestFree(player.x, player.z);
  if (p) teleport(p.x, p.z);
  return true;
}
