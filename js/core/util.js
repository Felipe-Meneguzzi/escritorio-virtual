// ============================================================ utilidades (sem THREE)
export const $ = s => document.querySelector(s);
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));   // suavização independente de FPS
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
// ângulo em (-π, π]
export const wrapAngle = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
// aproxima o ângulo a de b (caminho mais curto), taxa lambda
export const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));

export function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// PRNG determinístico (mulberry32): mesma semente → mesma sequência
export function rng(seed) {
  let a = (typeof seed === 'string' ? hashStr(seed) : seed) || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length) % arr.length];
export function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}
export const fmtDate = s => new Date(s * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
export function fmtAgo(s) {
  const d = Math.max(0, Date.now() / 1000 - s);
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.round(d / 60)} min`;
  if (d < 86400) return `há ${Math.round(d / 3600)} h`;
  return `há ${Math.round(d / 86400)} d`;
}
export const fmtUsd = v => `US$ ${(+v || 0).toFixed(v >= 1 ? 2 : 4)}`;

// fetch do backend: params viram query string; body (opcional) vai como JSON.
// opts: { signal, timeout (ms), headers } — erro HTTP: Error(msg do servidor) com err.status e err.body.
// X-Esc: 1 vai SEMPRE: o servidor exige esse cabeçalho em toda rota /api/ (anti-CSRF).
export async function request(path, params = {}, method = 'GET', body, { signal, timeout, headers } = {}) {
  const u = new URL(path, location.href);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  const opts = { method, headers: { 'X-Esc': '1', ...(headers || {}) } };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let timer = 0;
  if (signal || timeout) {
    const ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
    }
    if (timeout) timer = setTimeout(() => ctrl.abort(new DOMException(`${path}: tempo esgotado (${timeout} ms)`, 'TimeoutError')), timeout);
    opts.signal = ctrl.signal;
  }
  try {
    const r = await fetch(u, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error || r.statusText || `HTTP ${r.status}`);
      err.status = r.status; err.body = j;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// bytes de uma rota (ex.: imagem de /api/rooms/{sala}/raw) → URL blob: para <img src>. <img> não manda o
// cabeçalho X-Esc, por isso imagem do usuário SEMPRE passa por aqui. Lembre de URL.revokeObjectURL(url).
export async function blobUrl(path, params = {}, { signal } = {}) {
  const u = new URL(path, location.href);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'X-Esc': '1' }, signal });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return URL.createObjectURL(await r.blob());
}

let toastTimer;
// toast(msg, ms) — msg é HTML: escape (esc) o que vier do usuário/disco
export function toast(msg, ms = 2800) {
  const t = $('#toast'); if (!t) return;
  t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// chama fn protegida: erro de feature vira console.error, nunca derruba o núcleo
export function safeCall(where, fn, ...args) {
  try { return fn(...args); } catch (err) { console.error(`[escritório] ${where}:`, err); return undefined; }
}

export const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  || !!document.activeElement?.isContentEditable;
