// HUD icons, drawn once from the game's own models by a throwaway renderer: every gun as a side-on
// silhouette (a CSS mask, so the hotbar can paint it in its rarity colour) and every item and perk
// as a small coloured picture. They land as CSS classes: .ico-gun-<id>, .ico-axe, .ico-item-<what>.
import * as THREE from 'three';
import { PERKS, WEAPON_IDS, type PerkId } from '../../shared/src/constants.ts';
import type { InkRenderer } from './ink.ts';
import { buildGun, buildItem, buildPickaxe } from './models.ts';

const COLORS = [0x3b6fd6, 0xd32336, 0x3a3f4b, 0xf08c00, 0x2f9e44, 0xe64980, 0x8b5a2b, 0xf6f2e4, 0x2fd4f0, 0x7b3fb0]; // INK_IDS order
let done = false;

// side-on and flat: an orthographic camera fitted to the model's bounds
function silhouette(r: THREE.WebGLRenderer, obj: THREE.Object3D, w: number, h: number): string {
  const scene = new THREE.Scene();
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = white; });
  scene.add(obj);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  // the gun points down -z: look at it from +x, so the barrel points right
  const halfW = Math.max(size.z / 2, (size.y / 2) * (w / h)) * 1.06, halfH = halfW * (h / w);
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 50);
  cam.position.set(c.x + 10, c.y, c.z); cam.lookAt(c);
  r.setSize(w, h, false); r.clear(); r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
}

function picture(r: THREE.WebGLRenderer, obj: THREE.Object3D, s: number): string {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); scene.add(sun);
  obj.rotation.y = 0.6;
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: 0x1f2a5c }))); } });
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const rad = Math.max(size.x, size.y, size.z) * 0.62 + 0.01;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  cam.position.set(c.x + Math.sin(0.7) * rad * 3.2, c.y + Math.sin(0.5) * rad * 3.2, c.z + Math.cos(0.7) * rad * 3.2);
  cam.lookAt(c);
  r.setSize(s, s, false); r.clear(); r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
}

// draw them all (once, when the page is idle) and publish the classes
export function renderIcons() {
  if (done) return;
  done = true;
  const canvas = document.createElement('canvas');
  let r: THREE.WebGLRenderer;
  try { r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }); } catch { return; } // no WebGL: the hotbar falls back to names
  r.setClearColor(0x000000, 0);
  const mats = COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const fakeInk = { material: (id: number) => mats[id] } as unknown as InkRenderer;
  const gm = { body: mats[0], dark: mats[2], accent: mats[3], gem: mats[8], wood: mats[6] };
  const css: string[] = [];
  const mask = (cls: string, url: string) => css.push(`.${cls}{-webkit-mask-image:url(${url});mask-image:url(${url})}`);
  for (const id of WEAPON_IDS) mask(`ico-gun-${id}`, silhouette(r, buildGun(id, gm), 160, 64));
  mask('ico-axe', silhouette(r, buildPickaxe(mats[6], mats[8]).rotateX(Math.PI / 2), 160, 64));
  for (const what of ['mini', 'big', 'med', ...Object.keys(PERKS) as PerkId[]]) css.push(`.ico-item-${what}{background-image:url(${picture(r, buildItem(what, fakeInk), 96)})}`);
  const style = document.createElement('style');
  style.id = 'hud-icons';
  style.textContent = css.join('\n');
  document.head.appendChild(style);
  document.documentElement.classList.add('has-icons'); // until now the silhouettes would be plain blocks: kept hidden
  r.dispose(); r.forceContextLoss();
}
