// ============================================================ renderer, cena, câmera, luzes (GPU fraca!)
// Regras de orçamento (ARCH.md §GPU): só MeshLambertMaterial/MeshBasicMaterial, NENHUMA PointLight/SpotLight,
// nenhuma sombra em tempo real (sombra = blob), geometria estática mesclada, InstancedMesh para repetidos.
import * as THREE from 'three';
import * as Q from './quality.js';

export const canvas = document.getElementById('c');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: Q.tier.antialias, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(Q.currentRatio());
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;

export const scene = new THREE.Scene();
export const BG = new THREE.Color('#c9cfd3');
scene.background = BG;
// névoa leve: esconde o fundo de prédios compridos (e poupa a vista)
scene.fog = new THREE.Fog(BG, 38, 95);

export const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.08, 140);
camera.position.set(0, 2, 4);

// luz de escritório: céu quente + chão frio (luz das fluorescentes rebatida) e uma direcional suave sem sombra
export const hemi = new THREE.HemisphereLight('#fffaf0', '#8d94a0', 2.1);
export const sun = new THREE.DirectionalLight('#ffffff', 1.1);
sun.position.set(-6, 14, 8);
scene.add(hemi, sun, sun.target);

// céu (fundo) separado da névoa: api.setSky(cor) muda só o que se vê "lá fora"; a névoa continua na cor BG
const SKY = BG.clone();
export function setSky(color) {
  if (color == null) { scene.background = BG; return; }
  SKY.set(color);
  scene.background = SKY;
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// orçamento medido do último frame
export function frameStats() {
  const r = renderer.info.render;
  return { calls: r.calls, triangles: r.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
}

// descarta geometrias (e opcionalmente materiais/texturas) de uma subárvore
export function disposeTree(obj, { materials = false } = {}) {
  obj.traverse(o => {
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();            // buffers de instância (instanceMatrix/instanceColor) não saem com a geometria
    if (materials && o.material) for (const m of [o.material].flat()) { if (m.userData?.shared) continue; m.map?.dispose(); m.dispose(); }
  });
}
