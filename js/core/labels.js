// ============================================================ rótulos em sprite (canvas → textura)
// makeLabel(text, opts) → THREE.Sprite · setLabel(sprite, text, opts?) troca o texto (redesenha a textura)
// opts: { size=0.32 (altura do sprite em m), bg='#fbf8f1', fg='#1f2a36', border='#1f3a5f', sub, subColor, font,
//         maxWidth=520 (px do canvas), padding=14, radius=10, tail=false (rabinho de balão de fala), depthTest=true }
import * as THREE from 'three';

function draw(sprite, text, o) {
  const lines = String(text ?? '').split('\n').slice(0, 6);
  const dpr = 2;
  const font = o.font || '600 26px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
  const subFont = '500 20px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
  const c = sprite.userData.canvas || document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  // quebra de linha simples por largura
  const maxW = o.maxWidth ?? 520;
  const wrapped = [];
  for (const ln of lines) {
    const words = ln.split(/\s+/); let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(t).width > maxW && cur) { wrapped.push(cur); cur = w; } else cur = t;
    }
    wrapped.push(cur);
  }
  const main = wrapped.slice(0, 5);
  ctx.font = subFont;
  const sub = o.sub ? String(o.sub).slice(0, 80) : '';
  let w = 0;
  ctx.font = font; for (const l of main) w = Math.max(w, ctx.measureText(l).width);
  ctx.font = subFont; if (sub) w = Math.max(w, ctx.measureText(sub).width);
  const pad = o.padding ?? 14, lh = 32, slh = 26, tail = o.tail ? 16 : 0;
  const W = Math.ceil(w + pad * 2), H = Math.ceil(main.length * lh + (sub ? slh : 0) + pad * 2 - 6 + tail);
  c.width = W * dpr; c.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = o.radius ?? 10, bh = H - tail;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
  ctx.lineTo(W, bh - r); ctx.quadraticCurveTo(W, bh, W - r, bh);
  if (tail) { ctx.lineTo(W / 2 + 12, bh); ctx.lineTo(W / 2, H - 1); ctx.lineTo(W / 2 - 12, bh); }
  ctx.lineTo(r, bh); ctx.quadraticCurveTo(0, bh, 0, bh - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fillStyle = o.bg ?? '#fbf8f1'; ctx.fill();
  if (o.border !== null) { ctx.lineWidth = 3; ctx.strokeStyle = o.border ?? '#1f3a5f'; ctx.stroke(); }
  ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  ctx.font = font; ctx.fillStyle = o.fg ?? '#1f2a36';
  main.forEach((l, i) => ctx.fillText(l, W / 2, pad - 2 + i * lh));
  if (sub) { ctx.font = subFont; ctx.fillStyle = o.subColor ?? '#5b6b7a'; ctx.fillText(sub, W / 2, pad - 2 + main.length * lh); }
  let tex = sprite.material.map;
  // canvas mudou de tamanho: a textura precisa ser recriada (o WebGL2 aloca o armazenamento uma vez só — reaproveitar
  // dá "GL_INVALID_VALUE: Offset overflows texture dimensions" e o texto novo não aparece)
  const sz = sprite.userData.texSize;
  if (tex && sz && (sz[0] !== c.width || sz[1] !== c.height)) { tex.dispose(); tex = null; }
  sprite.userData.texSize = [c.width, c.height];
  if (!tex || tex.image !== c) {
    tex?.dispose();
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    sprite.material.map = tex; sprite.material.needsUpdate = true;
  }
  tex.needsUpdate = true;
  sprite.userData.canvas = c;
  const hM = (o.size ?? 0.32) * (H / 58);
  sprite.scale.set(hM * W / H, hM, 1);
  sprite.center.set(0.5, 0);   // âncora embaixo no meio (posicione o sprite no topo da cabeça/objeto)
}

export function makeLabel(text, opts = {}) {
  const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: opts.depthTest ?? true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.renderOrder = 10;
  s.userData.labelOpts = opts;
  draw(s, text, opts);
  return s;
}

export function setLabel(sprite, text, opts) {
  if (opts) sprite.userData.labelOpts = { ...sprite.userData.labelOpts, ...opts };
  draw(sprite, text, sprite.userData.labelOpts || {});
}

export function disposeLabel(sprite) {
  sprite.material.map?.dispose();
  sprite.material.dispose();
  sprite.removeFromParent();
}
