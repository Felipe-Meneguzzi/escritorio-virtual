// ============================================================ entrada: teclado (registro sem colisão) e mouse
import { clamp, safeCall, isTyping } from './util.js';
import { emit } from './events.js';

export const keys = new Set();            // KeyboardEvent.code pressionados agora
// teclas do núcleo (ninguém registra por cima)
export const NATIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space', 'Escape', 'KeyM', 'KeyH', 'KeyI', 'F3', 'Tab']);
// teclas CONTEXTUAIS: só valem perto de um interativo (api.addInteractable ... actions[].key); não dá para registrar global
export const CONTEXT_KEYS = new Set(['KeyE', 'KeyR', 'KeyF', 'KeyX', 'KeyC', 'KeyV']);
export const NATIVE_HELP = [
  ['W A S D', 'andar'], ['Shift', 'correr'], ['arrastar', 'girar a câmera'], ['roda', 'aproximar'],
  ['E', 'interagir (perto de algo)'], ['Espaço', 'acenar'], ['M', 'mapa / ir até uma sala'], ['H', 'esconder a ajuda'],
  ['I', 'qualidade gráfica'], ['F3', 'desempenho'], ['Esc', 'fechar'],
];

const registered = new Map();   // code -> { codes, label, help, handler }
let onHelpChange = () => {};
export function setHelpListener(fn) { onHelpChange = fn; }

// api.registerKey(code | [codes], { label?, help, handler(ev) }) → off() | null (tecla ocupada)
export function registerKey(codes, { label, help, handler } = {}) {
  codes = [codes].flat();
  if (typeof handler !== 'function') throw new Error('registerKey precisa de handler');
  for (const c of codes) {
    if (NATIVE_KEYS.has(c)) { console.warn(`[escritório] tecla ${c} é do núcleo — registro ignorado`); return null; }
    if (CONTEXT_KEYS.has(c)) { console.warn(`[escritório] tecla ${c} é contextual (use actions de api.addInteractable) — registro ignorado`); return null; }
    if (registered.has(c)) { console.warn(`[escritório] tecla ${c} já registrada por outra feature — registro ignorado`); return null; }
  }
  const def = { codes, label: label || codes.map(c => c.replace(/^Key|^Digit/, '')).join('/'), help, handler };
  for (const c of codes) registered.set(c, def);
  onHelpChange();
  return () => { for (const c of codes) if (registered.get(c) === def) registered.delete(c); onHelpChange(); };
}
export const isKeyFree = code => !NATIVE_KEYS.has(code) && !CONTEXT_KEYS.has(code) && !registered.has(code);
export function listKeys() {
  const out = [...NATIVE_KEYS].map(code => ({ code, native: true }));
  for (const c of CONTEXT_KEYS) out.push({ code: c, context: true });
  for (const [code, k] of registered) out.push({ code, native: false, label: k.label, help: k.help });
  return out;
}
export const featureKeys = () => [...new Set(registered.values())];

// ações do núcleo, ligadas pelo main.js: { contextKey(code, ev) → bool, escape(), map(), help(), quality(), perf(), wave() }
const actions = {};
export function bindActions(a) { Object.assign(actions, a); }

// câmera: estado lido pelo camera.js
export const cam = { yaw: 0, pitch: 0.24, dist: 4.8, dragging: false };
let drag = null;
let enabled = true;
export function setInputEnabled(v) { enabled = v; if (!v) keys.clear(); }
export const inputEnabled = () => enabled;

export function initInput(canvas) {
  addEventListener('keydown', ev => {
    if (!enabled) return;
    if (isTyping()) {
      if (ev.key === 'Escape') { ev.preventDefault(); document.activeElement.blur(); }
      return;
    }
    keys.add(ev.code);
    if (ev.repeat) { if (ev.code === 'Tab' || ev.code === 'Space') ev.preventDefault(); return; }
    if (CONTEXT_KEYS.has(ev.code)) {
      if (actions.contextKey?.(ev.code, ev)) ev.preventDefault();
      return;
    }
    switch (ev.code) {
      case 'Escape': actions.escape?.(); break;
      case 'KeyM': actions.map?.(); break;
      case 'KeyH': actions.help?.(); break;
      case 'KeyI': actions.quality?.(); break;
      case 'F3': ev.preventDefault(); actions.perf?.(); break;
      case 'Space': ev.preventDefault(); actions.wave?.(); break;
      case 'Tab': ev.preventDefault(); actions.map?.(); break;
      default: {
        const def = registered.get(ev.code);
        if (def) { ev.preventDefault(); safeCall(`tecla ${ev.code}`, def.handler, ev); }
      }
    }
  });
  addEventListener('keyup', ev => keys.delete(ev.code));
  addEventListener('blur', () => keys.clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) keys.clear(); emit('visibility', !document.hidden); });

  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
  canvas.addEventListener('pointerdown', ev => {
    if (!enabled) return;
    drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = ev.clientX; drag.y = ev.clientY;
    if (drag.moved > 3) {
      cam.dragging = true;
      canvas.classList.add('dragging');
      cam.yaw -= dx * 0.0065;
      cam.pitch = clamp(cam.pitch + dy * 0.0045, -0.25, 1.2);
    }
  });
  const end = ev => {
    canvas.classList.remove('dragging');
    if (drag && drag.moved <= 3) emit('click', ev);
    drag = null; cam.dragging = false;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    cam.dist = clamp(cam.dist * (1 + ev.deltaY * 0.0012), 1.4, 9);
  }, { passive: false });
}
