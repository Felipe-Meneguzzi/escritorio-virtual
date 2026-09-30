// ============================================================ qualidade gráfica: níveis + resolução dinâmica
// O modo fica em localStorage ('esc.quality'): auto | alta | media | baixa.
// No auto, o nível começa pela GPU detectada e a resolução (pixel ratio) se ajusta sozinha pelo FPS medido.
// Antialias só pode ser escolhido ao criar o renderer: trocar de/para "alta" pede recarregar a página.

const KEY = 'esc.quality';
export const MODES = ['auto', 'alta', 'media', 'baixa'];

// escala máxima e mínima da resolução por nível (multiplica o devicePixelRatio, com teto absoluto)
// detail: 0..1 para as features decidirem quanto enfeite gerar; npcAnimDist: além disso (m) os bonecos podem
// animar com menos capricho (o movimento continua)
export const TIERS = {
  alta:  { label: 'alta',  antialias: true,  maxRatio: 1.5,  minRatio: 0.75, detail: 1.0, npcAnimDist: 40 },
  media: { label: 'média', antialias: false, maxRatio: 1.0,  minRatio: 0.6,  detail: 0.75, npcAnimDist: 28 },
  baixa: { label: 'baixa', antialias: false, maxRatio: 0.75, minRatio: 0.5,  detail: 0.5, npcAnimDist: 18 },
};

function readMode() {
  try { const m = localStorage.getItem(KEY); return MODES.includes(m) ? m : 'auto'; } catch { return 'auto'; }
}
function saveMode(m) { try { localStorage.setItem(KEY, m); } catch { /* sem storage: vale só nesta aba */ } }

// GPU por WebGL sem criar o renderer principal (contexto descartável)
function probeGpu() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { name: 'sem WebGL', software: true };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const software = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|software/i.test(name);
    const weak = /intel|uhd|hd graphics|iris|mali|adreno|powervr|apple gpu|vega \d|radeon\(tm\) graphics/i.test(name);
    return { name, software, weak };
  } catch { return { name: 'desconhecida', software: false, weak: true }; }
}

export const gpu = probeGpu();
export const mode = readMode();
// nível efetivo: fixo quando o usuário escolheu; no auto, pela GPU
export const tierName = mode !== 'auto' ? mode : gpu.software ? 'baixa' : gpu.weak ? 'media' : 'alta';
export const tier = TIERS[tierName];

// ---- resolução dinâmica (só no auto; nos modos fixos usa o teto do nível)
const dpr = Math.max(1, window.devicePixelRatio || 1);
const cap = () => Math.min(dpr, tier.maxRatio);
let ratio = mode === 'auto' ? Math.min(cap(), 1) : cap();
export const currentRatio = () => ratio;

let acc = 0, frames = 0, cool = 3, fps = 60;
export const currentFps = () => fps;
// chamado todo frame com o dt REAL (sem o clamp da física); devolve o novo ratio quando muda
export function adapt(realDt) {
  acc += realDt; frames++;
  if (acc < 1.5) return null;
  fps = frames / acc; acc = 0; frames = 0;
  if (mode !== 'auto' || document.hidden) return null;
  if ((cool -= 1) > 0) return null;           // espera estabilizar depois de cada troca
  let next = ratio;
  if (fps < 40) next = Math.max(tier.minRatio, ratio - (fps < 25 ? 0.15 : 0.08));
  else if (fps > 57) next = Math.min(cap(), ratio + 0.05);
  if (Math.abs(next - ratio) < 0.01) return null;
  ratio = +next.toFixed(3); cool = 2;
  return ratio;
}

// próximo modo do ciclo (tecla I); o novo modo vale depois de recarregar a página (antialias é fixo no renderer)
export function cycleMode() {
  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
  saveMode(next);
  return next;
}
