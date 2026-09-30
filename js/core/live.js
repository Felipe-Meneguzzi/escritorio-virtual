// ============================================================ tempo real no front: long-poll genérico + hub
// Sem SSE: o servidor é HTTP/1.0 e o "ao vivo" é long-poll com cursor (etag/offset/seq/versão).
//   api.longPoll(path, opts)          laço de long-poll com cursor, recuo em erro e parada limpa → { stop, kick }
//   api.stream(path, onEvent, opts)   açúcar do longPoll para rotas que devolvem um cursor no JSON (etag, seq...)
//   api.watch(canal, fn(versão))      UM long-poll por aba (GET /api/hub) para todos os canais: quando a versão
//                                     do canal muda, fn é chamada (e aí a feature busca a SUA rota sem wait)
// Tudo usa setTimeout/fetch (nunca o 'update'): continua andando com a aba escondida. Contrato no ARCH.md §Tempo real.
import { request, safeCall } from './util.js';

// promessa que resolve em ms, ou antes se wake() for chamado
function napper() {
  let timer = 0, res = null;
  return {
    sleep(ms) { return new Promise(r => { res = r; timer = setTimeout(() => { res = null; r(); }, ms); }); },
    wake() { if (res) { clearTimeout(timer); const r = res; res = null; r(); } },
  };
}

// api.longPoll(path, {
//   params(cursor) → {query}   chamado a cada pedido (cursor = último devolvido por onData; null no 1º)
//   onData(json, cursor) → novo cursor (undefined = mantém)   pode ser async
//   onError(err)               opcional (rede, 5xx, 404...)
//   timeout = 25000            ms por pedido (maior que o wait do servidor + folga)
//   idleGap = 3000             pausa quando o servidor responde rápido SEM novidade (ou com waited:false)
//   fastMs = 1000              "rápido" = menos que isso
//   retryMin = 2000, retryMax = 60000   recuo exponencial em erro
//   stopOn404 = true           rota inexistente (feature sem backend): para em vez de insistir
//   signal                     AbortSignal externo: abortar = stop()
// }) → { stop(), kick() (refaz o pedido já, sem esperar), get running(), get cursor() }
export function longPoll(path, opts = {}) {
  const { params = () => ({}), onData = () => undefined, onError = null, timeout = 25000, idleGap = 3000, fastMs = 1000,
    retryMin = 2000, retryMax = 60000, stopOn404 = true, signal = null } = opts;
  let stopped = false, ctrl = null, kicked = false, fails = 0;
  let cursor = opts.cursor ?? null;
  const nap = napper();
  const stop = () => { stopped = true; ctrl?.abort(); nap.wake(); };
  if (signal) { if (signal.aborted) stopped = true; else signal.addEventListener('abort', stop, { once: true }); }

  (async () => {
    while (!stopped) {
      ctrl = new AbortController();
      kicked = false;
      const t0 = performance.now();
      try {
        const q = safeCall(`longPoll ${path} params`, params, cursor) || {};
        const j = await request(path, q, 'GET', undefined, { signal: ctrl.signal, timeout });
        if (stopped) break;
        fails = 0;
        let next;
        try { next = await onData(j, cursor); } catch (err) { console.error(`[escritório] longPoll ${path} onData:`, err); }
        const changed = next !== undefined && next !== cursor;
        if (next !== undefined) cursor = next;
        const idle = j?.waited === false || (!changed && performance.now() - t0 < fastMs);
        if (idle && !kicked && !stopped) await nap.sleep(idleGap);
      } catch (err) {
        if (stopped) break;
        if (kicked && err.name === 'AbortError') continue;   // kick(): refaz já
        if (err.status === 404 && stopOn404) {
          if (onError) safeCall('longPoll onError', onError, err);
          stopped = true;
          break;
        }
        fails++;
        if (onError) safeCall('longPoll onError', onError, err);
        await nap.sleep(Math.min(retryMax, retryMin * 2 ** Math.min(6, fails - 1)));
      }
    }
    ctrl = null;
  })();

  return {
    stop,
    kick() { kicked = true; ctrl?.abort(); nap.wake(); },
    get running() { return !stopped; },
    get cursor() { return cursor; },
  };
}

// api.stream(path, onEvent(json), { cursorKey='etag', paramKey=cursorKey, wait=15, params={}, ...opts do longPoll })
// Cada resposta vai inteira para onEvent; o próximo pedido leva ?<paramKey>=json[cursorKey]&wait=<wait>.
//   api.stream('/api/claude/jobs', j => aplicar(j.jobs))                              // etag
//   api.stream('/api/claude/hook-events', j => ..., { cursorKey: 'seq', paramKey: 'since', wait: 20 })
export function stream(path, onEvent, { cursorKey = 'etag', paramKey = cursorKey, wait = 15, params = {}, ...rest } = {}) {
  return longPoll(path, {
    timeout: (wait + 10) * 1000,
    ...rest,
    params: c => ({ ...(typeof params === 'function' ? params(c) : params), wait, [paramKey]: c ?? undefined }),
    onData: async j => { await onEvent(j); return j?.[cursorKey] ?? undefined; },
  });
}

// ---- hub: um long-poll por aba para todos os canais
const channels = new Map();   // nome -> { v: versão conhecida | undefined, fns: Set }
let hub = null, boot = null, fallbackTimer = 0;
const HUB_WAIT = 20;

function fire(name, ch) {
  for (const fn of [...ch.fns]) safeCall(`watch('${name}')`, fn, ch.v);
}

function startHub() {
  if (hub || !channels.size) return;
  hub = longPoll('/api/hub', {
    timeout: (HUB_WAIT + 10) * 1000,
    idleGap: 3000,
    params: () => {
      const since = {};
      for (const [n, ch] of channels) since[n] = ch.v ?? -1;   // -1: nunca visto → responde na hora
      return { since: JSON.stringify(since), wait: HUB_WAIT };
    },
    onData(j) {
      const vs = j?.versions || {};
      const reboot = boot !== null && j.boot !== boot;   // servidor reiniciou: todo mundo relê
      boot = j.boot ?? boot;
      let changed = false;
      for (const [n, ch] of channels) {
        if (!(n in vs)) continue;
        if (reboot || ch.v !== vs[n]) { ch.v = vs[n]; changed = true; fire(n, ch); }
      }
      return changed ? `${boot}:${Object.entries(vs).join(',')}` : undefined;
    },
    onError(err) {
      if (err.status === 404) {   // servidor antigo sem /api/hub: cai para sondagem a cada 10 s
        console.warn('[escritório] /api/hub indisponível — api.watch cai para sondagem a cada 10 s');
        hub = null;
        clearInterval(fallbackTimer);
        fallbackTimer = setInterval(() => { for (const [n, ch] of channels) fire(n, ch); }, 10000);
      }
    },
  });
}

// api.watch(canal, fn(versão)) → off(). fn roda na 1ª resposta do hub (carga inicial) e a cada mudança.
export function watch(name, fn) {
  if (typeof fn !== 'function') throw new Error('watch precisa de uma função');
  let ch = channels.get(name);
  const isNew = !ch;
  if (!ch) channels.set(name, ch = { v: undefined, fns: new Set() });
  ch.fns.add(fn);
  if (!isNew && ch.v !== undefined) queueMicrotask(() => { if (ch.fns.has(fn)) safeCall(`watch('${name}')`, fn, ch.v); });
  if (fallbackTimer) queueMicrotask(() => safeCall(`watch('${name}')`, fn, ch.v));
  else if (!hub) startHub();
  else if (isNew) hub.kick();   // canal novo: refaz a espera já incluindo ele
  return () => {
    ch.fns.delete(fn);
    if (!ch.fns.size && channels.get(name) === ch) {
      channels.delete(name);
      if (!channels.size) { hub?.stop(); hub = null; clearInterval(fallbackTimer); fallbackTimer = 0; }
      else hub?.kick();
    }
  };
}
