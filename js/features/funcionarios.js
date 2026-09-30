// ============================================================ PACOTE funcionarios — RH: funcionários Claude viram NPCs
// Cada funcionário é um `claude -p` trabalhando na pasta da sala (backend: features/rh.py, rotas /api/rh/*). Ele é
// sempre multiagente: cada subagente que ele lança vira outro bonequinho que entra pela porta, trabalha e sai.
//   - contratar: quadro branco da sala (C) ou lista do RH (L) → modal com nome, tarefa, modelo, aviso + confirmação
//   - NPC: anda até a sala, senta e digita quando roda ferramenta, vai ao gaveteiro quando lê, ao quadro branco quando
//     fala/planeja ou espera a equipe, circula quando pensa, comemora ao terminar, fica sentado quando parado
//   - perto de um NPC: balão com a atividade (ícone + alvo) e teclas E feed · R mensagem · F resultado · X dispensar
//   - HUD: lista compacta (quem, onde, status) com "ir até"; minimapa com um ponto por NPC
// CONTRATO: ARCH.md §Funcionários (FUNC, SUB, EVT) e §Personagens. Só usa `api` (+ three).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const P = 'fn';                       // prefixo das classes CSS deste pacote
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode']);
const ICON = { Read: '📄', Edit: '✏️', MultiEdit: '✏️', Write: '📝', NotebookEdit: '📓', Bash: '💻', Grep: '🔎', Glob: '🗂️',
  LS: '🗂️', Agent: '🤖', Task: '🤖', TodoWrite: '📋', WebFetch: '🌐', WebSearch: '🌐', Skill: '🎓', ToolSearch: '🧰' };
const STATUS = {
  contratando: { t: 'chegando', c: '#8fa6b8', i: '🚶' },
  trabalhando: { t: 'trabalhando', c: '#3e7d4f', i: '⚙️' },
  esperando_equipe: { t: 'esperando a equipe', c: '#d9a441', i: '⏳' },
  ocioso: { t: 'pronto', c: '#2b4c77', i: '✓' },
  bloqueado: { t: 'bloqueado', c: '#b86b1f', i: '⛔' },
  erro: { t: 'com problema', c: '#b03a2e', i: '⚠️' },
  dispensado: { t: 'dispensado', c: '#7a8591', i: '👋' },
  concluido: { t: 'concluiu', c: '#2b4c77', i: '✓' },
  falhou: { t: 'falhou', c: '#b03a2e', i: '⚠️' },
  interrompido: { t: 'interrompido', c: '#7a8591', i: '✋' },
};
const MODEL_HINT = { haiku: 'rápido e baratinho', sonnet: 'equilibrado (recomendado)', opus: 'caprichado e caro' };
const FIRST = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Igor', 'Júlia', 'Lucas', 'Marina',
  'Nicolas', 'Olívia', 'Paulo', 'Renata', 'Sérgio', 'Tatiana', 'Vítor', 'Yara', 'Caio', 'Débora', 'Lívia', 'Márcio',
  'Priscila', 'Rafael', 'Sílvia', 'Tiago', 'Vanessa', 'Wagner', 'Beatriz', 'Otávio', 'Luana', 'Rodrigo', 'Célia'];
const LAST = ['Almeida', 'Barbosa', 'Cardoso', 'Duarte', 'Esteves', 'Figueiredo', 'Gouveia', 'Holanda', 'Lacerda', 'Macedo',
  'Nogueira', 'Pacheco', 'Queiroz', 'Rezende', 'Siqueira', 'Tavares', 'Valadares', 'Xavier', 'Moreira', 'Bittencourt'];
// ternos dos funcionários (determinístico pelo id) — formal, mas cada um com a sua cara
const SUITS = [
  { suit: '#2f3a4a', tie: '#8c2f39', shirt: '#f2f0ea', pants: '#262f3b' }, { suit: '#4a4f57', tie: '#2c5d8f', shirt: '#eef2f5', pants: '#3a3e45' },
  { suit: '#3b3226', tie: '#c49a3a', shirt: '#f5efe2', pants: '#2e271e' }, { suit: '#1e2c3f', tie: '#6b8e4e', shirt: '#eaf0f4', pants: '#18232f' },
  { suit: '#5a4a3a', tie: '#324b6b', shirt: '#f4f1ea', pants: '#473a2d' }, { suit: '#30343a', tie: '#a3242a', shirt: '#dfe8ef', pants: '#25282d' },
];

const STYLE = `
.${P}-hud { background: rgba(251,248,241,.95); border: 1px solid rgba(31,58,95,.18); border-radius: 8px; box-shadow: 0 4px 16px rgba(20,30,45,.18); overflow: hidden; font-size: 12.5px; }
.${P}-hud-h { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: #1f3a5f; color: #f7f1e3; font-weight: 700; letter-spacing: .02em; }
.${P}-hud-h span { flex: 1; font-weight: 400; color: #d9a441; font-size: 11.5px; text-align: right; }
.${P}-hud-h button { border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.12); color: #fff; border-radius: 4px; font: 700 11px ui-monospace, Consolas, monospace; padding: 0 5px; cursor: pointer; }
.${P}-hud-empty { padding: 6px 8px; color: #5b6b7a; font-style: italic; }
.${P}-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; border: 0; border-top: 1px solid rgba(31,58,95,.10); background: transparent; text-align: left; cursor: pointer; color: #1f2a36; font: inherit; }
.${P}-row:hover { background: #f3ecdc; }
.${P}-row .${P}-who { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.${P}-row b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #1f3a5f; }
.${P}-row small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #5b6b7a; font-size: 11px; }
.${P}-row .${P}-team { font: 700 10.5px ui-monospace, Consolas, monospace; color: #8a6d1f; background: #f6efdc; border-radius: 8px; padding: 0 5px; }
.${P}-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px rgba(255,255,255,.8); }
.${P}-dot.pulse { animation: ${P}-pulse 1.2s ease-in-out infinite; }
@keyframes ${P}-pulse { 50% { opacity: .35; } }
.${P}-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px; color: #fff; font-size: 12px; font-weight: 700; white-space: nowrap; }
.${P}-form { padding: 14px 18px; display: grid; gap: 12px; }
.${P}-form label.${P}-l { font-weight: 700; color: #1f3a5f; display: block; margin-bottom: 4px; }
.${P}-form .${P}-inline { display: flex; gap: 6px; }
.${P}-form .${P}-inline input { flex: 1; }
.${P}-form textarea { min-height: 120px; font: 13.5px/1.45 inherit; }
.${P}-count { text-align: right; font-size: 11.5px; color: #5b6b7a; }
.${P}-models { display: flex; gap: 8px; flex-wrap: wrap; }
.${P}-models label { flex: 1; min-width: 150px; border: 1px solid #b9c2cc; border-radius: 6px; padding: 7px 10px; cursor: pointer; background: #fff; display: flex; gap: 8px; align-items: flex-start; }
.${P}-models label:has(input:checked) { border-color: #d9a441; box-shadow: 0 0 0 2px rgba(217,164,65,.35); background: #fffaf0; }
.${P}-models b { display: block; color: #1f3a5f; }
.${P}-models small { color: #5b6b7a; }
.${P}-warn { background: #fff4b8; border: 1px solid #e0c96a; border-radius: 3px; padding: 10px 12px; rotate: -.3deg; box-shadow: 0 3px 8px rgba(0,0,0,.08); }
.${P}-warn b { color: #8a4b0f; }
.${P}-alerta { background: #ffe1d6; border-color: #e0906a; rotate: .3deg; }
.${P}-alerta[hidden] { display: none; }
.${P}-warn ul { margin: 6px 0 0; padding-left: 18px; color: #5b4a1f; font-size: 12.5px; }
.${P}-ok { display: flex; gap: 8px; align-items: flex-start; font-weight: 700; color: #1f2a36; cursor: pointer; }
.${P}-ok input { margin-top: 3px; }
.${P}-err { color: #b03a2e; min-height: 1.2em; font-size: 13px; }
.${P}-feed { display: flex; flex-direction: column; height: 100%; }
.${P}-top { padding: 8px 14px; border-bottom: 1px solid rgba(31,58,95,.14); display: flex; flex-direction: column; gap: 6px; background: #fbf8f1; }
.${P}-task { font-size: 13px; color: #1f2a36; max-height: 4.2em; overflow: auto; white-space: pre-wrap; }
.${P}-task::before { content: '📌 '; }
.${P}-teamrow { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.${P}-teamrow[hidden] { display: none; }
.${P}-teamrow button { border: 1px solid rgba(31,58,95,.2); background: #fff; border-radius: 12px; padding: 1px 9px; font-size: 12px; cursor: pointer; color: #1f2a36; }
.${P}-teamrow button.on { background: #1f3a5f; color: #fff; border-color: #1f3a5f; }
.${P}-log { flex: 1; overflow: auto; padding: 8px 14px 12px; background: #f6f2e8; display: flex; flex-direction: column; gap: 5px; }
.${P}-ev { font-size: 13px; line-height: 1.4; }
.${P}-ev .${P}-q { display: inline-block; font-weight: 700; font-size: 11.5px; padding: 0 6px; border-radius: 8px; color: #fff; margin-right: 6px; vertical-align: 1px; }
.${P}-ev.fala { background: #fff; border: 1px solid rgba(31,58,95,.12); border-radius: 8px; padding: 6px 10px; }
.${P}-ev.fala .md { padding: 2px 0 0; }
.${P}-ev.fala .md > :first-child { margin-top: 0; } .${P}-ev.fala .md > :last-child { margin-bottom: 0; }
.${P}-ev.tool { font: 12.5px ui-monospace, Consolas, monospace; color: #2b3a4a; padding-left: 4px; }
.${P}-ev.tool details { display: inline; }
.${P}-ev.tool summary { cursor: pointer; display: inline; list-style: none; }
.${P}-ev.tool summary::-webkit-details-marker { display: none; }
.${P}-ev.tool .${P}-res { margin: 3px 0 2px 22px; padding: 4px 8px; background: #eae4d6; border-radius: 4px; white-space: pre-wrap; word-break: break-word; color: #3d4a57; font-size: 12px; }
.${P}-ev.tool.err .${P}-t { color: #b03a2e; }
.${P}-ev.tool .${P}-okk { color: #3e7d4f; } .${P}-ev.tool .${P}-bad { color: #b03a2e; }
.${P}-ev.sys { color: #5b6b7a; font-size: 12.5px; font-style: italic; }
.${P}-ev.you { align-self: flex-end; max-width: 80%; background: #1f3a5f; color: #fff; border-radius: 10px 10px 2px 10px; padding: 6px 10px; white-space: pre-wrap; }
.${P}-ev.turn { text-align: center; color: #1f3a5f; font-weight: 700; font-size: 12px; margin: 6px 0 2px; border-top: 1px dashed rgba(31,58,95,.3); padding-top: 4px; }
.${P}-ev.turn small { display: block; color: #5b6b7a; font-weight: 400; }
.${P}-ev.end { border-left: 4px solid #3e7d4f; background: #eef5ee; padding: 6px 10px; border-radius: 4px; }
.${P}-ev.end.bad { border-color: #b03a2e; background: #f8ecea; }
.${P}-ev.end button { margin-left: 8px; }
.${P}-send { display: flex; gap: 8px; padding: 8px 14px; border-top: 1px solid rgba(31,58,95,.14); background: #fbf8f1; align-items: flex-end; }
.${P}-send textarea { flex: 1; min-height: 38px; max-height: 140px; }
.${P}-send .${P}-hint { font-size: 11.5px; color: #5b6b7a; }
.${P}-list { width: 100%; border-collapse: collapse; font-size: 13px; }
.${P}-list th { text-align: left; color: #5b6b7a; font-weight: 600; font-size: 12px; padding: 6px 10px; border-bottom: 1px solid rgba(31,58,95,.18); }
.${P}-list td { padding: 7px 10px; border-bottom: 1px solid rgba(31,58,95,.08); vertical-align: middle; }
.${P}-list td.${P}-act { color: #5b6b7a; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-list td.${P}-btns { white-space: nowrap; text-align: right; }
.${P}-list td.${P}-btns button { padding: 2px 8px; margin-left: 4px; }
.${P}-bar { display: flex; gap: 10px; align-items: center; padding: 10px 14px; flex-wrap: wrap; border-bottom: 1px solid rgba(31,58,95,.12); background: #fbf8f1; }
.${P}-bar .${P}-sp { flex: 1; }
.${P}-note { color: #5b6b7a; font-size: 12.5px; }
.${P}-empty { padding: 36px; text-align: center; color: #5b6b7a; }
.${P}-empty b { display: block; font-size: 16px; color: #1f3a5f; margin-bottom: 6px; }
.${P}-stats { display: flex; gap: 14px; flex-wrap: wrap; padding: 8px 18px; background: #f3ecdc; color: #3d4a57; font-size: 12.5px; border-bottom: 1px solid rgba(31,58,95,.12); }
.${P}-confirm { padding: 18px 20px; font-size: 14px; }
`;

export function install(api) {
  const U = api.util;
  const style = document.createElement('style');
  style.dataset.pkg = 'funcionarios';
  style.textContent = STYLE;
  document.head.append(style);

  const S = {
    office: null, cfg: null, funcs: new Map(), npcs: new Map(), res: new Map(), poll: null, firstLoad: true,
    fresh: new Set(), feed: null, near: null, nearT: 0, decideT: 0, visitT: 0, visitors: new Map(), tipShown: false,
    etag: null, rodando: 0, maxFunc: 4, t: 0,
  };
  const officeQ = () => ({ office: S.office });
  const roomOf = id => api.roomById(id);
  const hue = s => U.hashStr(String(s)) % 360;
  const qColor = s => `hsl(${hue(s)}, 42%, 38%)`;
  const st = s => STATUS[s] || { t: s || '?', c: '#7a8591', i: '•' };
  const chip = s => `<span class="${P}-chip" style="background:${st(s).c}">${U.esc(st(s).i)} ${U.esc(st(s).t)}</span>`;
  const running = f => f && ['trabalhando', 'esperando_equipe', 'contratando'].includes(f.status);
  const randomName = () => `${U.pick(FIRST)} ${U.pick(LAST)}`;
  const shortPath = p => { const s = String(p || ''); const parts = s.split('/').filter(Boolean); const t = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : s; return t.length > 38 ? `…${t.slice(-37)}` : t; };
  const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  // ---------------------------------------------------------------- texto da atividade (balão, prompt, HUD)
  function toolText(tool, alvo, texto) {
    const ic = ICON[tool] || '🔧';
    if (tool === 'Agent' || tool === 'Task') return `🤖 delegou: ${clip(alvo || texto || 'um colega', 40)}`;
    if (tool === 'Grep') { const pat = String(alvo || '').split('  em ')[0]; return pat ? `🔎 grep '${clip(pat, 30)}'` : `🔎 ${ptText(texto) || 'procurando'}`; }
    if (tool === 'Glob') return `🗂️ procurando ${clip(alvo || '', 32) || 'arquivos'}`;
    if (tool === 'Bash') return alvo ? `💻 rodando \`${clip(alvo, 34)}\`` : `💻 ${ptText(texto) || 'no terminal'}`;
    if (tool === 'Read') return alvo ? `📄 lendo ${shortPath(alvo)}` : `📄 ${ptText(texto) || 'lendo'}`;
    if (tool === 'Edit' || tool === 'MultiEdit') return alvo ? `✏️ editando ${shortPath(alvo)}` : `✏️ ${ptText(texto) || 'editando'}`;
    if (tool === 'Write') return alvo ? `📝 escrevendo ${shortPath(alvo)}` : `📝 ${ptText(texto) || 'escrevendo'}`;
    if (tool === 'TodoWrite') return '📋 atualizando a lista de tarefas';
    if (tool === 'WebFetch' || tool === 'WebSearch') return `🌐 ${clip(alvo || texto || 'pesquisando', 36)}`;
    if (texto) return `${ic} ${ptText(texto)}`;
    return `${ic} ${tool || 'trabalhando'}${alvo ? ` ${clip(alvo, 30)}` : ''}`;
  }
  // descrições prontas do task_progress vêm em inglês ("Reading README.md") — traduz o começo
  function ptText(t) {
    if (!t) return '';
    const s = String(t);
    const m = [[/^Reading (.+)/, 'lendo $1'], [/^Finding (.+)/, 'procurando $1'], [/^Searching for (.+)/, "buscando '$1'"],
      [/^Running (.+)/, 'rodando $1'], [/^Editing (.+)/, 'editando $1'], [/^Writing (.+)/, 'escrevendo $1'],
      [/^Listing (.+)/, 'listando $1'], [/^Fetching (.+)/, 'buscando $1']];
    for (const [re, rep] of m) if (re.test(s)) return clip(s.replace(re, rep), 44);
    return clip(s, 44);
  }
  function actText(d, isSub) {
    if (!d) return '';
    const a = d.atividade || {};
    if (!isSub) {
      if (d.status === 'ocioso') return d.resultado ? '✓ pronto — R para falar comigo' : '✓ pronto';
      if (d.status === 'bloqueado') return `⛔ ${clip(d.erro || 'precisei de permissão', 60)}`;
      if (d.status === 'erro') return `⚠️ ${clip(d.erro || 'deu problema', 60)}`;
      if (d.status === 'dispensado') return '👋 indo embora';
      if (d.status === 'esperando_equipe') return `⏳ ${a.texto || 'esperando a equipe'}`;
    } else if (d.status !== 'trabalhando') {
      return d.status === 'concluido' ? '✓ terminei!' : `${st(d.status).i} ${st(d.status).t}`;
    }
    if (a.tipo === 'ferramenta') return toolText(a.ferramenta, a.alvo, a.texto);
    if (a.tipo === 'fala') return `💬 ${clip(a.texto, 90)}`;
    if (a.tipo === 'pensando') return '🤔 pensando…';
    if (a.tipo === 'chegando') return isSub ? `🚪 ${clip(d.descricao, 40)}` : '🚶 chegando…';
    if (a.texto) return clip(a.texto, 80);
    return isSub ? `🤖 ${clip(d.descricao, 40)}` : '⚙️ trabalhando';
  }

  // ---------------------------------------------------------------- laptops (InstancedMesh: 2 draw calls no total)
  const LAP_MAX = 40;
  const lapBodyGeo = (() => {
    const base = new THREE.BoxGeometry(0.34, 0.018, 0.24); base.translate(0, 0.009, 0);
    const lid = new THREE.BoxGeometry(0.34, 0.22, 0.012); lid.translate(0, 0.11, 0); lid.rotateX(-0.28); lid.translate(0, 0.018, -0.115);
    return mergeGeometries([base, lid]);
  })();
  const lapScreenGeo = new THREE.PlaneGeometry(0.3, 0.185); lapScreenGeo.translate(0, 0.11, 0.0075); lapScreenGeo.rotateX(-0.28); lapScreenGeo.translate(0, 0.018, -0.115);
  const lapBody = new THREE.InstancedMesh(lapBodyGeo, new THREE.MeshLambertMaterial({ color: '#3a3f46' }), LAP_MAX);
  const lapScreen = new THREE.InstancedMesh(lapScreenGeo, new THREE.MeshBasicMaterial({ color: '#ffffff' }), LAP_MAX);
  for (const m of [lapBody, lapScreen]) { m.count = 0; m.frustumCulled = false; m.name = 'funcionarios:laptops'; }
  lapScreen.setColorAt(0, new THREE.Color('#9fd3ff'));
  api.addToScene(lapBody); api.addToScene(lapScreen);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
  function updateLaptops(t) {
    let n = 0;
    if (api.hasCharacterFactory) { if (lapBody.count) { lapBody.count = 0; lapScreen.count = 0; } return; }
    for (const npc of S.npcs.values()) {
      if (n >= LAP_MAX) break;
      if (!npc.arrived || npc.spotType !== 'seat' || !npc.spot || npc.leaving || npc.pose !== 'type') continue;
      const s = npc.spot, fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
      _p.set(s.x + fx * 0.64, 0.765, s.z + fz * 0.64);
      _q.setFromAxisAngle(_up, s.yaw + Math.PI);
      _m.compose(_p, _q, _s);
      lapBody.setMatrixAt(n, _m); lapScreen.setMatrixAt(n, _m);
      const scr = npc.screen || 'on';
      if (scr === 'bash') _c.set(Math.sin(t * 9 + n) > 0 ? '#7dff9a' : '#16301c');
      else if (scr === 'type') _c.setHSL(0.57, 0.8, 0.72 + Math.sin(t * 5 + n) * 0.06);
      else if (scr === 'dim') _c.set('#4c5f75');
      else _c.set('#9fd3ff');
      lapScreen.setColorAt(n, _c);
      n++;
    }
    lapBody.count = n; lapScreen.count = n;
    if (n) { lapBody.instanceMatrix.needsUpdate = true; lapScreen.instanceMatrix.needsUpdate = true; if (lapScreen.instanceColor) lapScreen.instanceColor.needsUpdate = true; }
  }

  // ---------------------------------------------------------------- vagas da sala (assentos, quadro, gaveteiro, bordas)
  const keyOf = (roomId, p) => `${roomId}|${p.x.toFixed(2)},${p.z.toFixed(2)}`;
  function spotsOf(room, type) {
    const z = room.zones || {};
    if (type === 'seat') return z.seats || [];
    if (type === 'board') return z.board || [];
    if (type === 'work') return (z.work && z.work.length ? z.work : z.pace) || [];
    if (type === 'pace') return z.pace || [];
    if (type === 'files') return (z.files || []).map(f => ({ x: f.x, z: f.z, yaw: f.yaw ?? Math.PI / 2, files: true }));
    return [];
  }
  const FALLBACK = { seat: ['seat', 'work', 'board', 'pace'], files: ['files', 'seat', 'work'], board: ['board', 'work', 'pace', 'seat'],
    work: ['work', 'pace', 'seat'], pace: ['pace', 'work'] };
  function reserve(npc, room, spot, type) {
    release(npc);
    const k = keyOf(room.id, spot);
    S.res.set(k, npc.id);
    npc.spot = spot; npc.spotType = type; npc.spotKey = k;
  }
  function release(npc) {
    if (npc.spotKey && S.res.get(npc.spotKey) === npc.id) S.res.delete(npc.spotKey);
    npc.spot = null; npc.spotType = null; npc.spotKey = null;
  }
  function pickSpot(npc, room, type, { random = false } = {}) {
    for (const ty of FALLBACK[type] || [type]) {
      const list = spotsOf(room, ty);
      if (npc.spotType === ty && npc.spot && S.res.get(npc.spotKey) === npc.id && !random) return { spot: npc.spot, type: ty };
      const px = npc.ch.group.position.x, pz = npc.ch.group.position.z;
      const free = list.filter(p => { const o = S.res.get(keyOf(room.id, p)); return !o || o === npc.id; })
        .filter(p => !(random && npc.spot && p.x === npc.spot.x && p.z === npc.spot.z));
      if (!free.length) continue;
      if (random) return { spot: U.pick(free), type: ty };
      free.sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
      return { spot: free[0], type: ty };
    }
    return null;
  }

  // ---------------------------------------------------------------- NPC
  function createNpc({ id, kind, fid, roomId, name, seed, skin, colors, at, yaw, data }) {
    const ch = api.createCharacter({ skin, seed, name, colors });
    ch.group.position.set(at.x, 0, at.z);
    if (yaw !== undefined) ch.group.rotation.y = yaw;
    const npc = { id, kind, fid, roomId, ch, name, data, leaving: false, spot: null, spotType: null, spotKey: null,
      want: null, pose: null, token: 0, arrived: false, walking: false, holdUntil: 0, paceAt: 0, cheerUntil: 0,
      screen: 'on', badge: null, badgeText: '', inter: null, marker: null, said: '', lastStatus: data?.status, disposed: false };
    npc.marker = api.addMinimapMarker({ pos: () => ({ x: ch.group.position.x, z: ch.group.position.z }),
      color: kind === 'sub' ? '#d9a441' : kind === 'visit' ? '#6fa89a' : '#1f3a5f', size: kind === 'sub' ? 2.4 : 3.4 });
    npc.inter = api.addInteractable({
      owner: 'funcionarios', priority: 2, radius: 1.9,
      pos: () => ({ x: ch.group.position.x, z: ch.group.position.z }),
      enabled: () => !npc.leaving && !npc.disposed,
      label: () => npcLabel(npc),
      info: () => (npc.kind === 'visit' ? 'sessão interativa do Claude aberta nesta sala (só leitura)' : actText(npc.data, npc.kind === 'sub')),
      key: 'KeyE', actionLabel: npc.kind === 'visit' ? 'ver' : 'feed',
      onInteract: () => (npc.kind === 'visit' ? openVisitor(npc) : openFeed(npc.fid, npc.kind === 'sub' ? npc.id : null)),
      actions: kind === 'func' ? [
        { key: 'KeyR', label: 'mensagem', onInteract: () => openFeed(npc.fid, null, { focus: true }) },
        { key: 'KeyF', label: 'resultado', onInteract: () => openResult(npc.fid) },
        { key: 'KeyX', label: () => (running(npc.data) ? 'dispensar' : 'mandar embora'), onInteract: () => confirmDismiss(npc.fid) },
      ] : kind === 'sub' ? [{ key: 'KeyF', label: 'resumo', onInteract: () => openResult(npc.fid, npc.id) }] : [],
    });
    S.npcs.set(id, npc);
    return npc;
  }
  function npcLabel(npc) {
    const d = npc.data || {};
    if (npc.kind === 'visit') return `👀 ${d.nome || 'Visitante'} — ${d.sala_nome || d.sala || ''}`;
    if (npc.kind === 'sub') { const f = S.funcs.get(npc.fid); return `🤖 ${npc.name} · equipe de ${f?.nome?.split(' ')[0] || '?'} — ${clip(d.descricao, 34)}`; }
    return `👔 ${npc.name} — ${st(d.status).t}${d.subagentes?.filter(s => s.status === 'trabalhando').length ? ` · equipe de ${d.subagentes.filter(s => s.status === 'trabalhando').length}` : ''}`;
  }
  function disposeNpc(npc) {
    if (npc.disposed) return;
    npc.disposed = true;
    release(npc);
    npc.inter?.remove(); npc.marker?.();
    if (npc.badge) { api.disposeLabel(npc.badge); npc.badge = null; }
    if (S.near === npc) S.near = null;
    U.safeCall('npc.dispose', () => npc.ch.dispose());
    S.npcs.delete(npc.id);
  }
  function applyPose(npc) {
    const w = npc.want;
    if (!w || npc.disposed) return;
    const o = {};
    if (w.facing) o.facing = w.facing;
    else if (npc.spot && npc.spot.yaw !== undefined) o.yaw = npc.spot.yaw;
    if (w.prop !== undefined) o.prop = w.prop;
    U.safeCall('npc.setState', () => npc.ch.setState(w.state, o));
    npc.pose = w.state;
    npc.screen = w.screen || 'on';
  }
  // anda até o destino (vaga reservada) e aplica a pose ao chegar
  function goTo(npc, room, pick, want, { run = false } = {}) {
    const same = npc.spot && pick.spot === npc.spot && npc.spotType === pick.type;
    npc.want = want;
    if (same && (npc.arrived || npc.walking)) { if (npc.arrived && (npc.pose !== want.state || npc.screen !== (want.screen || 'on'))) applyPose(npc); return; }
    reserve(npc, room, pick.spot, pick.type);
    const tk = ++npc.token;
    npc.arrived = false; npc.walking = true;
    const done = arrived => {
      if (tk !== npc.token || npc.disposed) return;
      npc.walking = false; npc.arrived = true;
      if (!arrived) { const s = npc.spot; if (s) npc.ch.group.position.set(s.x, 0, s.z); }
      npc.holdUntil = S.t + (want.hold ?? 2.2);
      applyPose(npc);
    };
    const ok = U.safeCall('npc.walkTo', () => npc.ch.walkTo(pick.spot.x, pick.spot.z, done, { run }));
    if (!ok && tk === npc.token && npc.walking) { npc.ch.group.position.set(pick.spot.x, 0, pick.spot.z); done(true); }
  }
  function leave(npc, to, { cheer = false } = {}) {
    if (npc.leaving || npc.disposed) return;
    npc.leaving = true;
    release(npc);
    npc.ch.say(null);
    if (npc.badge) npc.badge.visible = false;
    const go = () => {
      if (npc.disposed) return;
      const tk = ++npc.token;
      npc.walking = true; npc.arrived = false;
      const ok = U.safeCall('npc.walkTo', () => npc.ch.walkTo(to.x, to.z, () => { if (tk === npc.token) disposeNpc(npc); }, { run: npc.kind !== 'func' }));
      if (!ok) disposeNpc(npc);
    };
    npc.token++; U.safeCall('npc.stop', () => npc.ch.stop?.());
    if (cheer) { U.safeCall('npc.cheer', () => npc.ch.setState('cheer')); setTimeout(go, 1300); } else go();
  }

  // o que o NPC QUER fazer agora (lugar + pose), a partir do FUNC/SUB
  function wantOf(npc, room) {
    const d = npc.data || {};
    const a = d.atividade || {};
    const door = room.door;
    if (npc.kind === 'visit') return { type: 'seat', state: 'type', screen: 'type', prop: 'laptop' };
    if (npc.kind === 'func') {
      if (d.status === 'ocioso') return { type: 'seat', state: 'sit', screen: 'dim', prop: 'mug' };          // cafezinho merecido
      if (d.status === 'bloqueado' || d.status === 'erro') return { type: 'seat', state: 'sit', screen: 'dim', prop: null };
      if (d.status === 'esperando_equipe') return { type: 'board', state: 'idle', hold: 4 };
    }
    if (a.tipo === 'ferramenta') {
      const t = a.ferramenta;
      if (t === 'Agent' || t === 'Task') return { type: 'board', state: 'point', facing: door.inside, hold: 2.5 };
      if (READ_TOOLS.has(t)) return npc.kind === 'sub' && U.hashStr(npc.id) % 2 ? { type: 'seat', state: 'sit', screen: 'on', prop: 'papers' } : { type: 'files', state: 'idle', prop: 'papers', hold: 2.5 };
      if (EDIT_TOOLS.has(t)) return { type: 'seat', state: 'type', screen: 'type', prop: 'laptop' };
      if (t === 'Bash') return { type: 'seat', state: 'type', screen: 'bash', prop: 'terminal' };
      if (PLAN_TOOLS.has(t)) return { type: 'board', state: 'point', hold: 3 };
      return { type: 'seat', state: 'type', screen: 'type' };
    }
    if (a.tipo === 'fala') return npc.kind === 'func' ? { type: 'board', state: 'talk', hold: 3.5 } : { type: 'work', state: 'talk', hold: 3 };
    if (a.tipo === 'pensando') return { type: 'pace', state: 'idle', pace: true, hold: 1.5 };
    if (a.tipo === 'chegando') return npc.kind === 'sub' ? { type: 'work', state: 'idle', hold: 1.5 } : { type: 'pace', state: 'idle', pace: true };
    return { type: npc.kind === 'sub' ? 'work' : 'seat', state: npc.kind === 'sub' ? 'idle' : 'type', screen: 'on' };
  }

  function decide(npc, force = false) {
    if (npc.leaving || npc.disposed || npc.kind === 'visit' && npc.arrived) return;
    const room = roomOf(npc.roomId);
    if (!room) return;
    if (S.t < npc.cheerUntil) return;
    const d = npc.data || {};
    // transições: terminou o trabalho → comemora; subagente terminou → comemora e sai pela porta
    if (npc.kind === 'func' && npc.lastStatus !== d.status) {
      const was = npc.lastStatus; npc.lastStatus = d.status;
      if (running({ status: was }) && d.status === 'ocioso') {
        npc.token++; U.safeCall('npc.stop', () => npc.ch.stop?.());
        U.safeCall('npc.cheer', () => npc.ch.setState('cheer'));
        npc.cheerUntil = S.t + 2.6; npc.holdUntil = 0; npc.arrived = true; npc.walking = false; npc.token++;
        return;
      }
    }
    const w = wantOf(npc, room);
    if (!force && npc.walking && npc.want && npc.want.type === w.type) { npc.want = { ...npc.want, ...w }; return; }
    if (!force && S.t < npc.holdUntil && npc.spotType && w.type !== npc.spotType && !['seat'].includes(w.type)) {
      if (npc.arrived && w.state !== npc.pose && npc.spotType === 'seat') { npc.want = w; applyPose(npc); }
      return;
    }
    if (w.pace) {
      if (npc.spotType === 'pace' && (npc.walking || S.t < npc.paceAt)) return;
      const pick = pickSpot(npc, room, 'pace', { random: true });
      if (pick) { npc.paceAt = S.t + 2.2 + Math.random() * 2.5; goTo(npc, room, pick, w); }
      return;
    }
    const pick = pickSpot(npc, room, w.type);
    if (pick) goTo(npc, room, pick, w);
  }

  function updateBadge(npc) {
    if (npc.kind !== 'func' || npc.leaving) return;
    const d = npc.data || {};
    const txt = d.status === 'ocioso' ? (d.resultado ? '✓' : '') : d.status === 'bloqueado' ? '⛔' : d.status === 'erro' ? '⚠️'
      : d.status === 'esperando_equipe' ? '⏳' : '';
    if (txt === npc.badgeText) return;
    npc.badgeText = txt;
    if (!txt) { if (npc.badge) npc.badge.visible = false; return; }
    const bg = d.status === 'ocioso' ? '#3e7d4f' : d.status === 'esperando_equipe' ? '#d9a441' : '#b03a2e';
    if (!npc.badge) {
      npc.badge = api.makeLabel(txt, { size: 0.34, bg, fg: '#fff', border: '#ffffff', padding: 8, radius: 16 });
      npc.badge.position.y = (npc.ch.height ?? 1.9) + 0.5;   // acima do crachá de nome da fábrica
      npc.ch.group.add(npc.badge);
    } else api.setLabel(npc.badge, txt, { bg });
    npc.badge.visible = S.near !== npc;
  }

  // ---------------------------------------------------------------- reconcílio (a lista do servidor é a verdade)
  function spawnAt(room, where) {
    if (where === 'entrance') { const e = api.office.zones.entrance; return { ...(e.outside || e), yaw: e.yaw }; }
    if (where === 'door') return { ...room.door.outside, yaw: room.door.yaw };
    const p = spotsOf(room, 'work')[0] || room.door.inside;
    return { x: p.x, z: p.z };
  }
  function reconcile(list) {
    const seen = new Set();
    for (const f of list) {
      S.funcs.set(f.id, f);
      seen.add(f.id);
      const room = roomOf(f.sala);
      let npc = S.npcs.get(f.id);
      if (!room) { if (npc && !npc.leaving) leave(npc, api.office.zones.entrance.outside || api.office.zones.entrance); continue; }
      if (f.status === 'dispensado') {
        if (npc && !npc.leaving) { npc.data = f; leave(npc, api.office.zones.entrance.outside || api.office.zones.entrance); }
      } else {
        if (!npc) {
          // "chega da recepção" só para quem acabou de ser contratado; um NPC recriado no meio de um turno seguinte
          // (reforma, lista que oscilou) reaparece dentro da sala em vez de atravessar o escritório de novo
          const recem = running(f) && (f.turnos || 1) <= 1 && Date.now() / 1000 - (f.inicio || 0) < 45;
          const fresh = S.fresh.has(f.id) || (!S.firstLoad && recem);
          const at = fresh ? spawnAt(room, 'entrance') : spawnAt(room, 'inside');
          const sd = SUITS[U.hashStr(f.id) % SUITS.length];
          npc = createNpc({ id: f.id, kind: 'func', fid: f.id, roomId: f.sala, name: f.nome, seed: f.id, skin: 'employee', colors: sd, at, yaw: at.yaw, data: f });
          npc.lastStatus = f.status;
          if (fresh) {                                   // chega correndo da recepção até a sala
            const w = wantOf(npc, room);
            const pick = pickSpot(npc, room, w.pace ? 'pace' : w.type);
            if (pick) goTo(npc, room, pick, { ...w, hold: 1 }, { run: true });
            S.fresh.delete(f.id);
          } else decide(npc, true);
        } else {
          const changed = npc.data?.atividade?.ts !== f.atividade?.ts || npc.data?.status !== f.status;
          npc.data = f;
          if (npc.roomId !== f.sala) { npc.roomId = f.sala; release(npc); }
          if (changed) decide(npc);
        }
        updateBadge(npc);
      }
      // subagentes
      const subIds = new Set();
      for (const s of f.subagentes || []) {
        subIds.add(s.id);
        let sn = S.npcs.get(s.id);
        if (!sn) {
          if (s.status !== 'trabalhando' || f.status === 'dispensado') continue;
          const at = S.firstLoad ? spawnAt(room, 'inside') : spawnAt(room, 'door');
          sn = createNpc({ id: s.id, kind: 'sub', fid: f.id, roomId: f.sala, name: s.nome, seed: s.id, skin: 'subagent', at, yaw: at.yaw, data: s });
          decide(sn, true);
          continue;
        }
        const changed = sn.data?.atividade?.ts !== s.atividade?.ts || sn.data?.status !== s.status;
        sn.data = s;
        if (s.status !== 'trabalhando') leave(sn, room.door.outside, { cheer: s.status === 'concluido' });
        else if (changed) decide(sn);
      }
      for (const n of [...S.npcs.values()]) if (n.kind === 'sub' && n.fid === f.id && !subIds.has(n.id) && !n.leaving) leave(n, room.door.outside);
    }
    for (const n of [...S.npcs.values()]) {
      if (n.kind === 'visit' || seen.has(n.fid) || n.leaving) continue;
      const room = roomOf(n.roomId);
      leave(n, room ? room.door.outside : (api.office.zones.entrance.outside || api.office.zones.entrance));
      S.funcs.delete(n.fid);
    }
    for (const id of [...S.funcs.keys()]) if (!seen.has(id)) S.funcs.delete(id);
    S.firstLoad = false;
    renderHud();
    refreshOpenPanel();
  }

  // ---------------------------------------------------------------- HUD
  const hud = api.hudSlot('funcionarios', { wide: true, order: 2 });
  hud.addEventListener('click', ev => {
    const b = ev.target.closest('[data-go],[data-act]');
    if (!b) return;
    if (b.dataset.act === 'list') openList();
    else if (b.dataset.go) goToFunc(b.dataset.go);
  });
  let hudHtml = '';
  function renderHud() {
    if (!S.office) return;
    const fs = [...S.funcs.values()].filter(f => f.status !== 'dispensado');
    const rows = fs.slice(-6).map(f => {
      const team = (f.subagentes || []).filter(s => s.status === 'trabalhando').length;
      return `<button type="button" class="${P}-row" data-go="${U.esc(f.id)}" title="Ir até ${U.esc(f.nome)}">
        <i class="${P}-dot${running(f) ? ' pulse' : ''}" style="background:${st(f.status).c}"></i>
        <span class="${P}-who"><b>${U.esc(f.nome)}</b><small>${U.esc(clip(f.sala_nome || f.sala, 18))} · ${U.esc(st(f.status).t)}</small></span>
        ${team ? `<span class="${P}-team" title="subagentes trabalhando">+${team}</span>` : ''}</button>`;
    }).join('');
    const html = `<div class="${P}-hud"><div class="${P}-hud-h">👔 RH<span>${S.rodando}/${S.maxFunc} trabalhando</span><button type="button" data-act="list" title="Lista do RH (L)">L</button></div>
      ${rows || `<div class="${P}-hud-empty">Ninguém contratado. No quadro branco de uma sala: <b>C</b>.</div>`}
      ${fs.length > 6 ? `<div class="${P}-hud-empty">+${fs.length - 6} na lista (L)</div>` : ''}</div>`;
    if (html !== hudHtml) { hud.innerHTML = html; hudHtml = html; }
  }
  function goToFunc(fid) {
    const f = S.funcs.get(fid);
    const room = f && roomOf(f.sala);
    if (!room) return;
    const npc = S.npcs.get(fid);
    const d = room.door.inside;
    api.player.teleport(d.x, d.z, npc ? Math.atan2(npc.ch.group.position.x - d.x, npc.ch.group.position.z - d.z) : room.door.yaw);
    api.closePanel();
  }

  // ---------------------------------------------------------------- contratar
  async function loadCfg() {
    try { S.cfg = await api.request('/api/rh/config', officeQ()); } catch (err) { console.warn('[funcionarios] config:', err.message); }
    return S.cfg;
  }
  async function openHire(roomId) {
    const cfg = S.cfg || await loadCfg() || {};
    const rooms = api.office.rooms;
    if (!rooms.length) { api.toast('🏗️ Ainda não há salas. Crie uma sala (projeto) antes de contratar.', 3200); return; }
    const cur = roomId || api.currentRoom?.id || rooms[0].id;
    const modelos = cfg.modelos || ['haiku', 'sonnet', 'opus'];
    const def = cfg.modelo_padrao || 'sonnet';
    const bypass = (cfg.modo || 'bypassPermissions') === 'bypassPermissions';
    const html = `<form class="${P}-form" autocomplete="off">
      <div><label class="${P}-l">Sala (projeto)</label><select name="sala">${rooms.map(r => `<option value="${U.esc(r.id)}"${r.id === cur ? ' selected' : ''}>${U.esc(r.name)}</option>`).join('')}</select></div>
      <div><label class="${P}-l">Nome do funcionário</label><div class="${P}-inline"><input name="nome" maxlength="40" value="${U.esc(cfg.sugestao_nome || randomName())}"><button type="button" data-dice title="Sortear outro nome">🎲</button></div></div>
      <div><label class="${P}-l">Tarefa</label><textarea name="tarefa" maxlength="8000" placeholder="Ex.: Revise o README, ache os TODOs do código e proponha um plano de testes."></textarea><div class="${P}-count"><span data-count>0</span>/8000 · Ctrl+Enter contrata</div></div>
      <div><label class="${P}-l">Modelo</label><div class="${P}-models">${modelos.map(m => `<label><input type="radio" name="modelo" value="${U.esc(m)}"${m === def ? ' checked' : ''}><span><b>${U.esc(m)}</b><small>${U.esc(MODEL_HINT[m] || '')}</small></span></label>`).join('')}</div></div>
      <div class="${P}-warn"><b>${bypass ? '⚠️ Trabalha sem pedir permissão' : `ℹ️ Modo: ${U.esc(cfg.modo_texto || cfg.modo || '')}`}</b><div>${U.esc(cfg.aviso || '')}</div>
        <ul><li>Sempre em equipe: pode chamar até ${U.esc(cfg.subs_par ?? 3)} colegas (subagentes) ao mesmo tempo.</li>
        <li>Teto de gasto por turno: US$ ${U.esc(cfg.budget || '1.00')} · no máximo ${Math.round((cfg.wall_s || 1800) / 60)} min por turno.</li>
        <li>Até ${U.esc(cfg.max_func ?? 4)} funcionários trabalhando ao mesmo tempo no escritório (agora: ${U.esc(cfg.rodando ?? S.rodando)}).</li>
        ${cfg.web ? '' : '<li>Sem acesso à internet (WebFetch/WebSearch desligados).</li>'}${cfg.dry_run ? '<li><b>Modo de teste (ESC_DRY_RUN):</b> nada roda de verdade.</li>' : ''}</ul></div>
      <div class="${P}-warn ${P}-alerta" data-alerta hidden></div>
      <label class="${P}-ok"><input type="checkbox" name="confirmo"> Entendi: ${bypass ? 'ele executa comandos e mexe em arquivos por conta própria' : 'ele trabalha sozinho na pasta da sala'}.</label>
      <div class="${P}-err" data-err></div></form>`;
    const h = api.openPanel({ title: '👔 Contratar funcionário', meta: 'Cada funcionário é uma instância do Claude Code trabalhando na pasta da sala.', html,
      width: 'min(640px, calc(100vw - 32px))', actions: [{ label: 'Contratar', primary: true, onClick: () => submit() }] });
    const form = h.body.querySelector('form');
    const btn = h.buttons[0];
    const upd = () => {
      const n = form.tarefa.value.length;
      form.querySelector('[data-count]').textContent = n;
      btn.disabled = !form.confirmo.checked || !form.tarefa.value.trim();
    };
    upd();
    form.addEventListener('input', upd, { signal: h.signal });
    form.addEventListener('change', upd, { signal: h.signal });
    form.addEventListener('submit', ev => { ev.preventDefault(); submit(); }, { signal: h.signal });
    form.querySelector('[data-dice]').addEventListener('click', () => { form.nome.value = randomName(); }, { signal: h.signal });
    // sala clonada/de fora com CLAUDE.md/AGENTS.md/.claude: alerta extra (o texto do repo vira instrução do funcionário)
    const alertaBox = form.querySelector('[data-alerta]');
    let alertaSeq = 0;
    async function checaSala() {
      const my = ++alertaSeq;
      alertaBox.hidden = true;
      try {
        const r = await api.request('/api/rh/sala_alerta', { ...officeQ(), sala: form.sala.value });
        if (my !== alertaSeq || !r?.alertas?.length) return;
        alertaBox.innerHTML = `<b>⚠️ Repositório de terceiros</b>${r.alertas.map(a => `<div>${U.esc(a)}</div>`).join('')}`;
        alertaBox.hidden = false;
      } catch (err) { console.warn('[funcionarios] sala_alerta:', err.message); }
    }
    form.sala.addEventListener('change', checaSala, { signal: h.signal });
    checaSala();
    form.tarefa.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); } }, { signal: h.signal });
    setTimeout(() => form.tarefa.focus(), 60);
    let busy = false;
    async function submit() {
      if (busy || btn.disabled) return;
      busy = true; btn.disabled = true; btn.textContent = 'Contratando…';
      const err = form.querySelector('[data-err]');
      err.textContent = '';
      try {
        const f = await api.request('/api/rh/contratar', {}, 'POST', { office: S.office, sala: form.sala.value, tarefa: form.tarefa.value,
          modelo: form.modelo.value, nome: form.nome.value.trim() || undefined, confirmo: true });
        S.fresh.add(f.id);
        h.close();
        const room = roomOf(f.sala);
        api.toast(`✅ <b>${U.esc(f.nome)}</b> foi contratado(a)! Está indo para a sala <b>${U.esc(room?.name || f.sala)}</b>.`, 3800);
        S.poll?.kick();
      } catch (e) {
        err.textContent = e.message || 'não deu certo';
        btn.textContent = 'Contratar'; busy = false; upd();
      }
    }
  }

  // ---------------------------------------------------------------- dispensar
  function confirmDismiss(fid) {
    const f = S.funcs.get(fid);
    if (!f) return;
    const run = running(f);
    const h = api.openPanel({ title: run ? `Dispensar ${f.nome}?` : `Mandar ${f.nome} embora?`, width: 'min(460px, calc(100vw - 32px))',
      html: `<div class="${P}-confirm">${run ? `O trabalho em andamento é <b>interrompido agora</b> (e a equipe de ${U.esc(String((f.subagentes || []).filter(s => s.status === 'trabalhando').length))} colega(s) vai junto). O que já foi feito na pasta fica.` : 'Ele sai do escritório. O histórico continua na lista do RH até você arquivar.'}</div>`,
      actions: [{ label: 'Cancelar', onClick: () => h.close() }, { label: run ? 'Dispensar' : 'Mandar embora', danger: true, onClick: async () => {
        try { await api.request(`/api/rh/funcionarios/${encodeURIComponent(fid)}/dispensar`, {}, 'POST', { office: S.office }); api.toast(`👋 ${U.esc(f.nome)} foi dispensado(a).`, 2600); S.poll?.kick(); }
        catch (e) { api.toast(`❌ ${U.esc(e.message)}`, 3500); }
        h.close();
      } }] });
  }
  async function archive(fid) {
    try { await api.request(`/api/rh/funcionarios/${encodeURIComponent(fid)}/arquivar`, {}, 'POST', { office: S.office }); api.toast('🗄️ Arquivado.', 1800); S.poll?.kick(); }
    catch (e) { api.toast(`❌ ${U.esc(e.message)}`, 3500); }
  }

  // ---------------------------------------------------------------- feed (transcript legível e SEGURO)
  function whoName(f, quem) {
    if (quem === 'voce') return 'Você';
    if (!f || quem === f.id) return f?.nome?.split(' ')[0] || 'Funcionário';
    const s = (f.equipe || f.subagentes || []).find(x => x.id === quem);
    return s?.nome || 'colega';
  }
  function evHtml(e, f) {
    const q = e.quem;
    const tag = q === 'voce' ? '' : `<span class="${P}-q" style="background:${qColor(q)}">${U.esc(whoName(f, q))}</span>`;
    switch (e.tipo) {
      case 'contratado': return `<div class="${P}-ev sys">👔 Contratado(a) para a sala <b>${U.esc(e.sala || '')}</b> · modelo ${U.esc(e.modelo || '')} · modo ${U.esc(e.modo || '')}</div>`;
      case 'turno_inicio': return `<div class="${P}-ev turn">Turno ${U.esc(String(e.turno || ''))}<small>${U.esc(clip(e.prompt, 160))}</small></div>`;
      case 'mensagem': return `<div class="${P}-ev you">${U.esc(e.texto)}${e.fila ? ' <small>(na fila)</small>' : ''}</div>`;
      case 'fala': return `<div class="${P}-ev fala">${tag}<div class="md">${api.markdown(e.texto || '')}</div></div>`;
      case 'ferramenta': return `<div class="${P}-ev tool" data-tid="${U.esc(e.id || '')}">${tag}<details><summary><span class="${P}-t">${U.esc(ICON[e.ferramenta] || '🔧')} ${U.esc(e.ferramenta)}</span> ${U.esc(clip(e.alvo || '', 110))} <span class="${P}-st"></span></summary><div class="${P}-res" hidden></div></details></div>`;
      case 'sub_entrou': return `<div class="${P}-ev sys">🚪 ${tag}entrou na sala: <b>${U.esc(e.sub?.descricao || '')}</b></div>`;
      case 'sub_recusado': return `<div class="${P}-ev sys">🙅 ${tag}tentou chamar mais um colega (“${U.esc(e.descricao || '')}”), mas bateu no ${U.esc(e.motivo || 'limite')}.</div>`;
      case 'sub_saiu': return `<div class="${P}-ev sys">👋 ${tag}saiu (${U.esc(st(e.status).t)})${e.resumo ? `: ${U.esc(clip(e.resumo, 240))}` : ''}</div>`;
      case 'turno_fim': {
        const bad = ['erro', 'bloqueado', 'dispensado'].includes(e.status);
        return `<div class="${P}-ev end${bad ? ' bad' : ''}">${U.esc(st(e.status).i)} <b>Turno encerrado — ${U.esc(st(e.status).t)}</b> · ${U.esc(U.fmtUsd(e.custo_turno))} (total ${U.esc(U.fmtUsd(e.custo_total))})${!bad && e.texto ? `<button type="button" data-result>Ver resultado</button>` : ''}${bad && e.texto ? `<div>${U.esc(clip(e.texto, 300))}</div>` : ''}</div>`;
      }
      case 'dispensado': return `<div class="${P}-ev sys">🚪 Dispensado: ${U.esc(e.motivo || '')}</div>`;
      case 'erro': return `<div class="${P}-ev sys" style="color:#b03a2e">⚠️ ${U.esc(e.texto || '')}</div>`;
      default: return '';   // sub_progresso e resultado_parcial não poluem o feed
    }
  }
  function feedMeta(f, sub) {
    if (!f) return '';
    if (sub) return `🤖 ${sub.nome} · ${st(sub.status).t} · ${sub.tipo || 'general-purpose'}${sub.uso?.tokens ? ` · ${sub.uso.tokens} tokens` : ''}${sub.uso?.ferramentas ? ` · ${sub.uso.ferramentas} ferramenta(s)` : ''}`;
    const dur = ((f.fim || Date.now() / 1000) - (f.inicio || Date.now() / 1000)) / 60;
    return `${st(f.status).t} · ${f.modelo}${f.modelos_reais?.length ? ` (${f.modelos_reais.join(', ')})` : ''} · ${U.fmtUsd(f.custo_total)} no total · ${f.turnos} turno(s) · ${dur < 1 ? '<1' : Math.round(dur)} min · modo ${f.modo}`;
  }
  // linha "Equipe:" do feed — refeita quando entra colega novo ou muda o status de alguém (turnos seguintes trazem outros)
  function teamRowHtml(team, quem) {
    return `<small>Equipe:</small><button type="button" data-quem=""${!quem ? ' class="on"' : ''}>todos</button>${team.map(s => `<button type="button" data-quem="${U.esc(s.id)}"${quem === s.id ? ' class="on"' : ''} title="${U.esc(s.descricao)}">${U.esc(st(s.status).i)} ${U.esc(s.nome)}</button>`).join('')}`;
  }
  function renderTeamRow(ctx) {
    const row = ctx.h.body.querySelector('[data-team]');
    if (!row) return;
    const live = new Map(((S.funcs.get(ctx.fid) || {}).subagentes || []).map(s => [s.id, s]));
    const team = (ctx.f.equipe || []).map(s => ({ ...s, ...(live.get(s.id) || {}) })).slice(-12);
    const html = teamRowHtml(team, ctx.quem);
    if (row.dataset.html === html) return;
    row.dataset.html = html; row.innerHTML = html; row.hidden = !team.length;
  }
  async function openFeed(fid, quem = null, { focus = false } = {}) {
    let f = S.funcs.get(fid);
    if (!f) return;
    try { f = { ...f, ...(await api.request(`/api/rh/funcionarios/${encodeURIComponent(fid)}`, officeQ())) }; } catch { /* usa o da lista */ }
    const sub = quem ? (f.equipe || f.subagentes || []).find(s => s.id === quem) : null;
    const team = (f.equipe || []).slice(-12);
    const html = `<div class="${P}-feed">
      <div class="${P}-top"><div><span data-chip>${chip(sub ? sub.status : f.status)}</span> ${sub ? `<b>${U.esc(sub.descricao)}</b>` : ''}</div>
        <div class="${P}-task">${U.esc(sub ? (sub.resumo || 'trabalhando…') : f.tarefa)}</div>
        <div class="${P}-teamrow" data-team${team.length ? '' : ' hidden'}>${teamRowHtml(team, quem)}</div></div>
      <div class="${P}-log" data-log><div class="${P}-ev sys">carregando…</div></div>
      ${quem ? '' : `<div class="${P}-send"><textarea data-msg maxlength="8000" placeholder="Mande uma mensagem para ${U.esc(f.nome.split(' ')[0])} (continua a mesma conversa)…"></textarea><div><button type="button" data-send>Enviar</button><div class="${P}-hint" data-hint></div></div></div>`}</div>`;
    const actions = [{ label: '📋 Resultado', onClick: () => openResult(fid, quem) }];
    if (!quem) actions.push({ label: running(f) ? 'Dispensar' : 'Mandar embora', danger: true, disabled: f.status === 'dispensado', onClick: () => confirmDismiss(fid) });
    if (!quem) actions.push({ label: 'Arquivar', disabled: running(f), title: 'só dá para arquivar quem não está trabalhando', onClick: () => { if (!running(S.funcs.get(fid) || f)) { archive(fid); h.close(); } } });
    const h = api.openPanel({ title: sub ? `🤖 ${sub.nome} — equipe de ${f.nome}` : `🗂️ ${f.nome} — sala ${f.sala_nome || f.sala}`, meta: feedMeta(f, sub), html,
      width: 'min(820px, calc(100vw - 32px))', actions, className: `${P}-panel` });
    const log = h.body.querySelector('[data-log]');
    const ctx = { fid, quem, h, log, f, sub, first: true, count: 0, poll: null, cursor: -1 };
    S.feed = ctx;
    h.body.querySelector('[data-team]')?.addEventListener('click', ev => { const b = ev.target.closest('[data-quem]'); if (b) openFeed(fid, b.dataset.quem || null); }, { signal: h.signal });
    log.addEventListener('click', ev => { if (ev.target.closest('[data-result]')) openResult(fid); }, { signal: h.signal });
    const ta = h.body.querySelector('[data-msg]');
    if (ta) {
      const sendBtn = h.body.querySelector('[data-send]');
      const send = async () => {
        const txt = ta.value.trim();
        if (!txt || sendBtn.disabled) return;
        sendBtn.disabled = true;
        try {
          const r = await api.request(`/api/rh/funcionarios/${encodeURIComponent(fid)}/mensagem`, {}, 'POST', { office: S.office, texto: txt });
          ta.value = '';
          api.toast(r.enfileirado ? '📨 Mensagem na fila: vai quando ele terminar.' : `📨 ${U.esc(f.nome.split(' ')[0])} voltou ao trabalho.`, 2400);
          S.poll?.kick();
          restartFeed(ctx);
        } catch (e) { api.toast(`❌ ${U.esc(e.message)}`, 3500); }
        sendBtn.disabled = false;
        syncSend(ctx);
      };
      sendBtn.addEventListener('click', send, { signal: h.signal });
      ta.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } }, { signal: h.signal });
      syncSend(ctx);
      if (focus) setTimeout(() => ta.focus(), 60);
    }
    h.signal.addEventListener('abort', () => { ctx.poll?.stop(); if (S.feed === ctx) S.feed = null; });
    restartFeed(ctx);
  }
  function syncSend(ctx) {
    const b = ctx.h.body.querySelector('[data-send]'), hint = ctx.h.body.querySelector('[data-hint]'), ta = ctx.h.body.querySelector('[data-msg]');
    if (!b) return;
    const f = S.funcs.get(ctx.fid) || ctx.f;
    const run = running(f);
    const gone = f.status === 'dispensado';
    b.disabled = gone || (run && !S.cfg?.fila);
    b.textContent = run && S.cfg?.fila ? 'Enfileirar' : 'Enviar';
    ta.disabled = gone;
    hint.textContent = gone ? 'dispensado' : run ? (S.cfg?.fila ? 'vai quando ele terminar' : 'espere ele terminar o turno') : 'Enter envia · Shift+Enter quebra linha';
  }
  function appendEvents(ctx, evs) {
    const f = S.funcs.get(ctx.fid) ? { ...ctx.f, ...S.funcs.get(ctx.fid), equipe: ctx.f.equipe } : ctx.f;
    if (ctx.first) { ctx.log.innerHTML = ''; ctx.first = false; }
    const stick = ctx.log.scrollHeight - ctx.log.scrollTop - ctx.log.clientHeight < 60;
    let html = '';
    for (const e of evs) {
      if (e.tipo === 'ferramenta_ok') {             // resultado vai dentro da linha da ferramenta
        const row = ctx.log.querySelector(`[data-tid="${CSS.escape(e.id || '')}"]`);
        if (row) {
          row.classList.toggle('err', !!e.erro);
          row.querySelector(`.${P}-st`).innerHTML = e.erro ? `<span class="${P}-bad">✗</span>` : `<span class="${P}-okk">✓</span>`;
          const r = row.querySelector(`.${P}-res`); r.textContent = e.resumo || '(sem saída)'; r.hidden = false;
        }
        continue;
      }
      if (e.tipo === 'sub_entrou' && e.sub && !(ctx.f.equipe || []).some(s => s.id === e.sub.id)) { (ctx.f.equipe ||= []).push(e.sub); ctx.teamDirty = true; }
      html += evHtml(e, f);
      ctx.count++;
    }
    if (html) ctx.log.insertAdjacentHTML('beforeend', html);
    if (ctx.teamDirty) { ctx.teamDirty = false; renderTeamRow(ctx); }
    while (ctx.log.childElementCount > 700) ctx.log.firstElementChild.remove();
    if (!ctx.count && !ctx.log.childElementCount) ctx.log.innerHTML = `<div class="${P}-ev sys">nada por aqui ainda.</div>`;
    if (stick || evs.length > 50) ctx.log.scrollTop = ctx.log.scrollHeight;
  }
  function restartFeed(ctx) {
    ctx.poll?.stop();
    if (!ctx.h.isOpen()) return;
    const path = `/api/rh/funcionarios/${encodeURIComponent(ctx.fid)}/feed`;
    ctx.poll = api.longPoll(path, {
      cursor: ctx.cursor < 0 ? null : ctx.cursor, timeout: 34000, idleGap: 1500, signal: ctx.h.signal,
      params: c => ({ office: S.office, offset: c ?? -1, wait: c == null ? 0 : 22, quem: ctx.quem || undefined }),
      onData: j => {
        appendEvents(ctx, j.eventos || []);
        ctx.cursor = j.offset;
        if (!j.vivo && !(j.eventos || []).length) { ctx.poll?.stop(); ctx.stopped = true; }   // parado: religa quando voltar a trabalhar
        return j.offset;
      },
      onError: err => { if (err.status === 404) appendEvents(ctx, [{ tipo: 'erro', texto: 'funcionário não encontrado (arquivado?)', quem: ctx.fid }]); },
    });
    ctx.stopped = false;
  }
  // chamado a cada lista nova: atualiza o cabeçalho do feed aberto e religa o feed se ele voltou a trabalhar
  function refreshOpenPanel() {
    const ctx = S.feed;
    if (ctx && ctx.h.isOpen()) {
      const f = S.funcs.get(ctx.fid);
      if (f) {
        const sub = ctx.quem ? (f.subagentes || []).find(s => s.id === ctx.quem) || ctx.sub : null;
        ctx.h.update({ meta: feedMeta({ ...f }, sub) });
        if (!ctx.quem && ctx.h.buttons.length >= 3) {       // Dispensar/Mandar embora e Arquivar acompanham o status
          ctx.h.buttons[1].textContent = running(f) ? 'Dispensar' : 'Mandar embora';
          ctx.h.buttons[1].disabled = f.status === 'dispensado';
          ctx.h.buttons[2].disabled = running(f);
        }
        const chipEl = ctx.h.body.querySelector('[data-chip]');
        const ch = chip(sub ? sub.status : f.status);
        if (chipEl && chipEl.innerHTML !== ch) chipEl.innerHTML = ch;
        renderTeamRow(ctx);
        syncSend(ctx);
        if (ctx.stopped && running(f)) restartFeed(ctx);
      }
    }
    if (listCtx && listCtx.h.isOpen()) renderList();
  }

  // ---------------------------------------------------------------- resultado
  async function openResult(fid, quem = null) {
    let f = S.funcs.get(fid);
    if (!f) return;
    try { f = await api.request(`/api/rh/funcionarios/${encodeURIComponent(fid)}`, officeQ()); } catch { /* lista */ }
    if (quem) {
      const s = (f.equipe || f.subagentes || []).find(x => x.id === quem);
      api.openPanel({ title: `🤖 Resumo de ${s?.nome || 'colega'}`, meta: s ? `${st(s.status).t} · ${s.descricao}` : '', width: 'min(720px, calc(100vw - 32px))',
        html: s?.resumo ? `<div class="md">${api.markdown(s.resumo)}</div>` : `<div class="${P}-empty"><b>Ainda sem resumo</b>${s?.status === 'trabalhando' ? 'Ele ainda está trabalhando.' : ''}</div>`,
        actions: [{ label: '🗂️ Feed', onClick: () => openFeed(fid, quem) }] });
      return;
    }
    const r = f.resultado;
    const stats = r?.stats || {};
    api.openPanel({ title: `📋 Resultado — ${f.nome}`, meta: `sala ${f.sala_nome || f.sala} · ${st(f.status).t}${f.erro ? ` · ${f.erro}` : ''}`,
      width: 'min(780px, calc(100vw - 32px))',
      html: r ? `<div class="${P}-stats"><span>💵 turno ${U.esc(U.fmtUsd(f.custo_turno))} · total ${U.esc(U.fmtUsd(f.custo_total))}</span><span>🔁 ${U.esc(String(r.num_turns ?? '?'))} passos</span>
          <span>🤖 ${U.esc(String(stats.spawned ?? 0))} colega(s), ${U.esc(String(stats.completed ?? 0))} concluíram${stats.refused?.concurrency_limit ? `, ${U.esc(String(stats.refused.concurrency_limit))} recusado(s)` : ''}</span>
          <span>${U.esc(r.subtype || '')}</span></div><div class="md">${api.markdown(r.texto || '(sem texto)')}</div>`
        : `<div class="${P}-empty"><b>Ainda sem resultado</b>${running(f) ? `${U.esc(f.nome.split(' ')[0])} está trabalhando nisso.` : U.esc(f.erro || '')}</div>`,
      actions: [{ label: '🗂️ Feed', onClick: () => openFeed(fid) }, { label: '✉️ Mensagem', onClick: () => openFeed(fid, null, { focus: true }) }] });
  }

  // ---------------------------------------------------------------- lista do RH (tecla L)
  let listCtx = null;
  function openList(roomId = null) {
    if (listCtx && listCtx.h.isOpen() && !roomId) { listCtx.h.close(); return; }
    const h = api.openPanel({ title: '👔 RH — funcionários', meta: '', html: `<div data-list></div>`, width: 'min(900px, calc(100vw - 32px))',
      actions: [{ label: '＋ Contratar', primary: true, onClick: () => openHire(roomId || api.currentRoom?.id) }] });
    listCtx = { h, roomId };
    h.body.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-a]');
      if (!b) return;
      const fid = b.dataset.f;
      ({ go: () => goToFunc(fid), feed: () => openFeed(fid), res: () => openResult(fid), arq: () => archive(fid), all: () => { listCtx.roomId = null; renderList(); } })[b.dataset.a]?.();
    }, { signal: h.signal });
    h.signal.addEventListener('abort', () => { if (listCtx?.h === h) listCtx = null; });
    renderList();
    loadCfg().then(() => renderList());
  }
  function renderList() {
    if (!listCtx) return;
    const { h, roomId } = listCtx;
    const cfg = S.cfg || {};
    const fs = [...S.funcs.values()].filter(f => !roomId || f.sala === roomId).reverse();
    const room = roomId ? roomOf(roomId) : null;
    h.update({ meta: `${S.rodando}/${S.maxFunc} trabalhando · modo: ${cfg.modo_texto || cfg.modo || '?'} · teto por turno US$ ${cfg.budget || '?'}${cfg.dry_run ? ' · ESC_DRY_RUN (nada roda de verdade)' : ''}` });
    const vis = [...S.visitors.values()].filter(v => !roomId || v.sala === roomId);
    const rows = fs.map(f => {
      const team = (f.subagentes || []).filter(s => s.status === 'trabalhando').length;
      return `<tr><td><b>${U.esc(f.nome)}</b><br><small>${U.esc(f.modelo)}</small></td><td>${U.esc(f.sala_nome || f.sala)}</td><td>${chip(f.status)}</td>
        <td class="${P}-act" title="${U.esc(actText(f))}">${U.esc(actText(f))}${team ? ` · 🤖×${team}` : ''}</td><td>${U.esc(U.fmtUsd(f.custo_total))}</td>
        <td class="${P}-btns">${f.status !== 'dispensado' ? `<button type="button" data-a="go" data-f="${U.esc(f.id)}">Ir até</button>` : ''}<button type="button" data-a="feed" data-f="${U.esc(f.id)}">Feed</button><button type="button" data-a="res" data-f="${U.esc(f.id)}">Resultado</button>${running(f) ? '' : `<button type="button" data-a="arq" data-f="${U.esc(f.id)}" title="Tirar da lista (vai para .escritorio/rh/.arquivo)">Arquivar</button>`}</td></tr>`;
    }).join('');
    const html = `<div class="${P}-bar">${room ? `<span>Sala <b>${U.esc(room.name)}</b></span><button type="button" data-a="all">ver todas</button>` : '<span>Todas as salas</span>'}<span class="${P}-sp"></span>
        <span class="${P}-note">Contrate no quadro branco de uma sala (<kbd>C</kbd>) ou pelo botão acima.</span></div>
      ${fs.length ? `<table class="${P}-list"><thead><tr><th>Quem</th><th>Sala</th><th>Status</th><th>Fazendo</th><th>Custo</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="${P}-empty"><b>Ninguém por aqui ainda</b>Contrate um funcionário: ele vira um bonequinho engravatado que trabalha na sala (e chama colegas).</div>`}
      ${vis.length ? `<div class="${P}-bar"><span>👀 Visitantes (sessões interativas do Claude abertas nas salas — só leitura)</span></div><table class="${P}-list"><tbody>${vis.map(v => `<tr><td>${U.esc(v.nome || 'Visitante')}</td><td>${U.esc(v.sala_nome || v.sala)}</td><td>${U.esc(v.status || '')}</td><td class="${P}-act">${U.esc(v.subpasta || '')}</td></tr>`).join('')}</tbody></table>` : ''}`;
    const el = h.body.querySelector('[data-list]');
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  // ---------------------------------------------------------------- visitantes (sessões interativas vivas — só leitura)
  async function pollVisitors() {
    if (!S.office) return;
    let vs = [];
    try { vs = (await api.request('/api/rh/visitantes', officeQ())).visitantes || []; } catch { return; }
    const ids = new Set();
    for (const v of vs) {
      ids.add(v.id);
      S.visitors.set(v.id, v);
      if (S.npcs.has(v.id)) { S.npcs.get(v.id).data = v; continue; }
      const room = roomOf(v.sala);
      if (!room) continue;
      const npc = createNpc({ id: v.id, kind: 'visit', fid: null, roomId: v.sala, name: `👀 ${v.nome || 'Visitante'}`, seed: v.id, skin: 'employee',
        colors: { suit: '#6b5d4f', tie: '#d9a441', shirt: '#f6e7c8', pants: '#4b4035' }, at: spawnAt(room, 'inside'), data: v });
      decide(npc, true);
    }
    for (const id of [...S.visitors.keys()]) if (!ids.has(id)) { S.visitors.delete(id); const n = S.npcs.get(id); if (n) { const r = roomOf(n.roomId); leave(n, r ? r.door.outside : n.ch.group.position); } }
  }
  function openVisitor(npc) {
    const v = npc.data || {};
    api.openPanel({ title: `👀 ${v.nome || 'Visitante'}`, width: 'min(520px, calc(100vw - 32px))', meta: `sala ${v.sala_nome || v.sala}`,
      html: `<div class="${P}-confirm">Há uma <b>sessão interativa do Claude Code</b> aberta nesta sala${v.subpasta ? ` (em <code>${U.esc(v.subpasta)}</code>)` : ''}${v.status ? ` — status: ${U.esc(v.status)}` : ''}${v.desde ? `, desde ${U.esc(U.fmtDate(v.desde))}` : ''}.<br><br>O Escritório só mostra: nunca retoma nem mexe nessa conversa. Continue por lá.</div>` });
  }

  // ---------------------------------------------------------------- quadro branco de cada sala: C contratar · E equipe
  api.on('layoutChanged', ev => {
    S.res.clear();
    for (const r of api.office.rooms) {
      const b = r.zones?.board || [];
      if (!b.length) continue;
      const p = b.length >= 3 ? { x: (b[1].x + b[2].x) / 2, z: (b[1].z + b[2].z) / 2 } : b[0];
      api.addInteractable({ owner: 'funcionarios', layout: true, priority: 0, radius: 1.35, pos: p,
        label: `Quadro branco — ${r.name}`,
        info: () => { const n = [...S.funcs.values()].filter(f => f.sala === r.id && f.status !== 'dispensado').length; return n ? `${n} funcionário(s) nesta sala` : 'ninguém trabalhando aqui ainda'; },
        key: 'KeyC', actionLabel: 'contratar funcionário', onInteract: () => openHire(r.id),
        actions: [{ key: 'KeyE', label: 'equipe da sala', onInteract: () => openList(r.id) }] });
    }
    if (ev.initial) return;
    // NPCs: salas que mudaram de lugar (reforma) → teletransporta para a porta nova e replaneja; sala removida → sai
    for (const npc of [...S.npcs.values()]) {
      release(npc);
      const room = roomOf(npc.roomId);
      if (!room) { disposeNpc(npc); continue; }
      if (npc.leaving) { disposeNpc(npc); continue; }
      if (ev.reflow || (ev.moved || []).includes(npc.roomId)) {
        npc.ch.stop?.();
        npc.ch.group.position.set(room.door.inside.x, 0, room.door.inside.z);
      }
      npc.token++; npc.walking = false; npc.arrived = false; npc.holdUntil = 0;
      decide(npc, true);
    }
  });

  api.on('enterRoom', room => {
    if (S.tipShown || !room || room.isNew || !S.office) return;
    if ([...S.funcs.values()].some(f => f.sala === room.id && f.status !== 'dispensado')) return;
    S.tipShown = true;
    api.toast('💡 Vá até o <b>quadro branco</b> da sala e aperte <kbd>C</kbd> para contratar um funcionário (ou <kbd>L</kbd> de qualquer lugar).', 5200);
  });

  api.registerKey('KeyL', { label: 'L', help: 'RH: funcionários / contratar', handler: () => { if (S.office) openList(); } });

  // ---------------------------------------------------------------- laço: decisões, balão do NPC mais perto, laptops
  api.on('update', (dt, t) => {
    S.t += dt;
    if (!S.npcs.size) { if (lapBody.count) { lapBody.count = 0; lapScreen.count = 0; } return; }
    if ((S.decideT -= dt) <= 0) {
      S.decideT = 0.45;
      for (const npc of S.npcs.values()) {
        if (npc.leaving) continue;
        const w = npc.want;
        if (S.t >= npc.cheerUntil && npc.cheerUntil) { npc.cheerUntil = 0; npc.arrived = false; decide(npc, true); continue; }
        if (w?.pace || (npc.arrived && npc.spot && S.res.get(npc.spotKey) !== npc.id) || (!npc.walking && !npc.arrived)) decide(npc, !npc.walking && !npc.arrived);
      }
    }
    if ((S.nearT -= dt) <= 0) {
      S.nearT = 0.25;
      const px = api.player.x, pz = api.player.z;
      const pr = api.currentRoom?.id || null;
      let best = null, bd = 4.6;
      for (const npc of S.npcs.values()) {
        if (npc.leaving || npc.kind === 'visit') continue;
        const g = npc.ch.group.position, d = Math.hypot(g.x - px, g.z - pz);
        const nr = api.getRoomAt(g.x, g.z)?.id || null;
        if (d < bd && (nr === pr || d < 2.2)) { bd = d; best = npc; }
      }
      if (best !== S.near) {
        if (S.near && !S.near.disposed) { S.near.ch.say(null); S.near.said = ''; if (S.near.badge && S.near.badgeText && !S.near.leaving) S.near.badge.visible = true; }
        S.near = best;
      }
      if (best) {
        const txt = actText(best.data, best.kind === 'sub');
        if (txt !== best.said) { best.said = txt; best.ch.say(txt || null); }
        if (best.badge) best.badge.visible = false;
      }
    }
    updateLaptops(t);
  });

  // ---------------------------------------------------------------- início: config + lista ao vivo (long-poll + etag)
  api.on('officeReady', office => {
    S.office = office.id;
    loadCfg();
    renderHud();
    S.poll = api.stream('/api/rh/funcionarios', j => {
      S.rodando = j.rodando ?? 0; S.maxFunc = j.max_func ?? 4;
      reconcile(j.funcionarios || []);
    }, { cursorKey: 'etag', wait: 20, params: officeQ, onError: err => console.warn('[funcionarios] lista:', err.message) });
    pollVisitors();
    setInterval(pollVisitors, 15000);
  });

  // depuração/testes (puppeteer)
  window.__funcionarios = { S, openHire, openFeed, openList, openResult, actText };
}
