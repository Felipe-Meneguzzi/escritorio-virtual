// ============================================================ Escritório — boot: núcleo → features → escritório → laço
import { canvas, renderer, scene, camera, frameStats } from './core/scene.js';
import * as Q from './core/quality.js';
import { $, esc, toast, safeCall } from './core/util.js';
import { on, emit } from './core/events.js';
import { initInput, bindActions } from './core/input.js';
import { initPanel, openPanel, closePanel, isPanelOpen } from './core/panel.js';
import { initHud, setCompany, setWhere, toggleHelp, togglePerf, renderPerf } from './core/hud.js';
import { updateInteract, contextKey, interactableCount, addInteractable } from './core/interact.js';
import { setMinimapLayout, drawMinimap, bigMapHtml, mountBigMap } from './core/minimap.js';
import { chooseOffice, hideWelcome, rememberOffice, setHashOffice } from './core/welcome.js';
import { player, teleport, emote, updatePlayer, updateCamera, unstick } from './core/player.js';
import { colliderCount } from './core/collision.js';
import { createApi, liveCharacters } from './core/api.js';
import { office, loadOffice, checkRooms, getRoomAt, getAreaAt, getNav } from './office/office.js';

// ordem de instalação: personagens primeiro (registra a fábrica de bonecos antes de alguém criar um)
export const FEATURES = ['personagens', 'ambiente', 'salas', 'quadro', 'funcionarios'];
const AREA_NAME = { recepcao: 'Recepção', area: 'Área comum', corredor: 'Corredor', nova: 'Sala disponível' };

let api = null;
let currentRoomId;          // undefined = ainda não calculado; null = fora de sala
const featureStatus = {};

function where() {
  const r = getRoomAt(player.x, player.z);
  if (r && !r.isNew) return `Sala: ${r.name}`;
  return AREA_NAME[getAreaAt(player.x, player.z)] || '';
}

function openMap() {
  if (isPanelOpen() && $('#panel').classList.contains('map')) return closePanel();
  if (!office.layout) return;
  const h = openPanel({ title: `🗺️ Planta — ${office.name}`, meta: 'Clique numa sala (ou no mapa) para ir até lá.', className: 'map',
    width: 'min(900px, calc(100vw - 32px))', html: bigMapHtml(office.layout, office.rooms) });
  mountBigMap(h.body, office.layout, office.rooms, player, go => {
    let dest = null;
    if (go.room) { const r = office.rooms.find(x => x.id === go.room); if (r) dest = { ...r.door.outside, yaw: r.door.yaw }; }
    else if (go.place === 'spawn') dest = office.zones.spawn;
    else if (go.place === 'quadro') { const q = office.zones.quadro[1]; dest = { x: q.x - 1.2, z: q.z, yaw: q.yaw }; }
    else if (go.place === 'copa') { const c = office.zones.copa[1]; dest = { x: c.x + 1, z: c.z, yaw: c.yaw }; }
    else if (go.place === 'new' && office.newSlot) dest = { ...office.newSlot.door.outside, yaw: office.newSlot.door.yaw };
    else if (go.point) { const p = getNav()?.nearestFree(go.point.x, go.point.z); if (p) dest = { ...p, yaw: player.yaw }; }
    if (!dest) return;
    teleport(dest.x, dest.z, dest.yaw);
    closePanel();
    toast('🚶 Chegou.', 1200);
  }, h.signal);
}

async function switchOffice() {
  const id = await chooseOffice({ forceSelector: true });
  if (id && id !== office.id) { setHashOffice(id); location.reload(); } else hideWelcome();
}

function onLayoutChanged(ev) {
  setMinimapLayout(office.layout, office.rooms);
  // porta de entrada: trocar de escritório (interativo do núcleo; some e volta a cada rebuild)
  const e = office.zones.entrance;
  addInteractable({ pos: { x: e.x, z: e.z + 0.4 }, radius: 1.4, layout: true, owner: 'núcleo', priority: -1,
    label: 'Porta de entrada', info: office.name, actionLabel: 'trocar de escritório', onInteract: switchOffice });
  if (ev.initial) return;
  const r = currentRoomId ? office.rooms.find(x => x.id === currentRoomId) : null;
  if (currentRoomId && ev.removed.includes(currentRoomId)) {
    const p = getNav()?.nearestFree(player.x, player.z);
    if (p) teleport(p.x, p.z);
  } else if (r && ev.moved.includes(r.id)) {
    teleport(r.door.inside.x, r.door.inside.z, r.door.yaw);
  }
  unstick((x, z) => getNav()?.nearestFree(x, z));
  if (ev.reflow) toast('🏗️ O escritório foi ampliado!', 3500);
  currentRoomId = undefined;
}

async function installFeatures() {
  const mods = await Promise.allSettled(FEATURES.map(n => import(`./features/${n}.js`)));
  mods.forEach((m, i) => {
    const n = FEATURES[i];
    if (m.status !== 'fulfilled') { featureStatus[n] = 'erro ao carregar'; console.error(`[escritório] feature ${n} não carregou:`, m.reason); return; }
    if (typeof m.value.install !== 'function') { featureStatus[n] = 'sem install()'; return; }
    try { m.value.install(api); featureStatus[n] = 'ok'; } catch (err) { featureStatus[n] = 'erro no install'; console.error(`[escritório] install de ${n} falhou:`, err); }
  });
}

async function openOffice(id) {
  const ev = await loadOffice(id, { initial: true });
  hideWelcome();
  rememberOffice(id); setHashOffice(id);
  document.title = `${office.name} — Escritório`;
  if (!player.char) {
    player.char = api.createCharacter({ skin: 'player', seed: 'jogador', manual: true });
    scene.add(player.char.group);
  }
  const s = office.zones.spawn;
  teleport(s.x, s.z, s.yaw);
  setCompany(office.name, 'Recepção');
  currentRoomId = undefined;
  emit('layoutChanged', ev);
  emit('officeReady', office);
  api.watch(`esc:rooms:${id}`, () => { checkRooms().catch(err => console.warn('[escritório] salas:', err.message)); });
}

// ---------------- laço
let last = performance.now(), mmT = 0, perfT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.max(0, (now - last) / 1000); last = now;
  const dt = Math.min(realDt, 0.05);
  player.blocked = isPanelOpen() || !$('#welcome').hidden;
  if (office.layout) {
    updatePlayer(dt);
    const camDist = updateCamera(dt);
    safeCall('jogador.update', () => player.char?.update(dt, camDist));
    const cx = camera.position.x, cz = camera.position.z;
    for (const c of liveCharacters()) {
      const g = c.group.position;
      safeCall('personagem.update', () => c.update(dt, Math.hypot(g.x - cx, g.z - cz)));
    }
    // sala atual
    const r = getRoomAt(player.x, player.z);
    const rid = r ? (r.isNew ? '+nova' : r.id) : null;
    if (rid !== currentRoomId) {
      const prev = currentRoomId;
      currentRoomId = rid;
      if (prev !== undefined && prev) emit('leaveRoom', prev === '+nova' ? office.newSlot : office.rooms.find(x => x.id === prev) || { id: prev });
      if (r) emit('enterRoom', r);
      setWhere(where());
    }
    updateInteract(player.x, player.z, dt, player.blocked);
    emit('update', dt, now / 1000);
    if ((mmT -= realDt) <= 0) { mmT = 0.1; drawMinimap(player); if (!r) setWhere(where()); }
  }
  const nr = Q.adapt(realDt);
  if (nr) renderer.setPixelRatio(nr);
  renderer.render(scene, camera);
  if ((perfT -= realDt) <= 0) {
    perfT = 0.5;
    const s = frameStats();
    renderPerf({ ...s, fps: Q.currentFps(), ratio: Q.currentRatio(), tier: Q.tierName, colliders: colliderCount(), interactables: interactableCount(), characters: liveCharacters().size });
  }
}

async function boot() {
  initInput(canvas);
  initPanel();
  initHud();
  api = createApi();
  on('layoutChanged', onLayoutChanged);
  bindActions({
    contextKey: code => (player.blocked ? false : contextKey(code)),
    escape: () => { if (isPanelOpen()) closePanel(); else emit('escape'); },
    map: openMap,
    help: toggleHelp,
    perf: togglePerf,
    wave: () => { if (!player.blocked) emote('wave', 1.8); },
    quality: () => { const m = Q.cycleMode(); toast(`🎛️ Qualidade: <b>${esc(m)}</b> — recarregue a página (F5) para aplicar`, 3200); },
  });
  $('#co-card').addEventListener('click', switchOffice);
  // depuração e testes automatizados (puppeteer): window.__esc
  window.__esc = { get api() { return api; }, player, office, features: featureStatus, teleport };
  await installFeatures();
  requestAnimationFrame(frame);
  $('#loading').hidden = true;
  let id;
  try { id = await chooseOffice(); } catch (err) {
    $('#loading').hidden = false;
    $('#loading').textContent = `Não consegui falar com o servidor: ${err.message}`;
    return;
  }
  try { await openOffice(id); } catch (err) {
    console.error(err);
    toast(`❌ ${esc(err.message)}`, 6000);
  }
}

boot();
