// ============================================================ barramento de eventos
// Listener que lança exceção é logado; se falhar demais (ex.: todo frame no 'update'), é desligado.
const listeners = new Map();   // evento -> Set(fn)
const failures = new WeakMap(); // fn -> nº de falhas
const MAX_FAILURES = 10;

export function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => off(ev, fn);
}
export function off(ev, fn) { listeners.get(ev)?.delete(fn); }
export function once(ev, fn) {
  const un = on(ev, (...a) => { un(); return fn(...a); });
  return un;
}
// devolve a lista de retornos dos listeners (o núcleo usa p/ 'interact' cancelável)
export function emit(ev, ...args) {
  const set = listeners.get(ev);
  if (!set || !set.size) return [];
  const out = [];
  for (const fn of [...set]) {
    try { out.push(fn(...args)); } catch (err) {
      const n = (failures.get(fn) || 0) + 1;
      failures.set(fn, n);
      console.error(`[escritório] listener de '${ev}' falhou (${n}x):`, err);
      if (n >= MAX_FAILURES) { set.delete(fn); console.warn(`[escritório] listener de '${ev}' desligado após ${n} falhas`); }
    }
  }
  return out;
}
