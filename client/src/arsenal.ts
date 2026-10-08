// The arsenal on the lobby page: every gun, perk and vehicle in the game, drawn once into small
// pictures by a throwaway renderer (flat colours and ink outlines), with what each one does.
import * as THREE from 'three';
import { PERKS, VEHICLES, VEHICLE_KINDS, WEAPONS, WEAPON_IDS, type PerkId } from '../../shared/src/constants.ts';
import type { InkRenderer } from './ink.ts';
import { buildGun, buildItem, buildVehicle, buildAxe, buildFigure } from './models.ts';
import { SKINS } from '../../shared/src/constants.ts';

const COLORS = [0x3b6fd6, 0xd32336, 0x3a3f4b, 0xf08c00, 0x2f9e44, 0xe64980, 0x8b5a2b, 0xf6f2e4]; // INK_IDS order
const RARITY_CSS: Record<string, string> = { common: '#7a7f8c', uncommon: '#2f9e44', rare: '#2f7fd6', epic: '#9c36b5', legendary: '#e8a317' };
const PERK_TEXT: Record<PerkId, string> = {
  grenade: 'bounces, then a big blast', molotov: 'a patch of fire on the ground', shock: 'throws everyone through the air',
  smoke: 'a wall of smoke to hide in', launch: 'a pad that fires you into the sky', fort: 'four walls around you, instantly',
  kit: 'one upgrade star on your gun', c4: 'stick it, set it off, a full health bar', nuke: 'wipes out everything it lands on',
};

function picture(renderer: THREE.WebGLRenderer, obj: THREE.Object3D, yaw: number, pitch = 0.35): string {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 5, 4); scene.add(sun);
  obj.rotation.y = yaw;
  const lines: THREE.Object3D[] = [];
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; lines.push(Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: 0x1f2a5c })), { name: '__edge' })); m.add(lines.at(-1)!); } });
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) * 0.62 + 0.01;
  const cam = new THREE.PerspectiveCamera(30, 1.6, 0.01, 100);
  cam.position.set(c.x + Math.sin(0.7) * r * 3.2, c.y + Math.sin(pitch) * r * 3.2, c.z + Math.cos(0.7) * r * 3.2);
  cam.lookAt(c);
  renderer.clear();
  renderer.render(scene, cam);
  return renderer.domElement.toDataURL('image/png');
}

export function renderArsenal(el: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.width = 288; canvas.height = 180;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }); } catch { return; }
  renderer.setClearColor(0x000000, 0);
  const mats = COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const fakeInk = { material: (id: number) => mats[id] } as unknown as InkRenderer;
  const gm = { body: mats[0], dark: mats[2], accent: mats[3] };
  const card = (img: string, name: string, color: string, tag: string, stats: string) =>
    `<article class="arm-card"><img src="${img}" alt=""><b style="color:${color}">${name}</b><em style="background:${color}">${tag}</em><small>${stats}</small></article>`;
  const guns = WEAPON_IDS.map((id) => {
    const d = WEAPONS[id], rps = d.burst ? (d.burst / (d.cd + d.burst * 0.075)) : 1 / d.cd;
    return card(picture(renderer, buildGun(id, gm), -Math.PI / 2 + 0.25), d.name, RARITY_CSS[d.rarity], d.rarity,
      `${d.proj ? `${d.dmg} blast` : `${d.pellets > 1 ? `${d.pellets}×${d.dmg}` : d.dmg} dmg`} · ${rps.toFixed(1)}/s · mag ${d.mag}${d.proj === 'missile' ? ' · locks on aircraft' : ''}${id === 'heavy' ? ' · headshot kills' : ''}`);
  });
  guns.push(card(picture(renderer, buildAxe(gm), -Math.PI / 2 + 0.25), 'Axe', '#8b5a2b', 'always', 'chops walls, cars and people · gives material · places blocks'));
  const perks = (Object.keys(PERKS) as PerkId[]).map((k) => card(picture(renderer, buildItem(k, fakeInk), 0.6, 0.5), PERKS[k].name, RARITY_CSS[PERKS[k].rarity], `×${PERKS[k].count}`, PERK_TEXT[k]));
  const veh = VEHICLE_KINDS.map((k, i) => {
    const d = VEHICLES[k];
    return card(picture(renderer, buildVehicle(fakeInk, i, 1).root, 0.9, 0.45), d.name, '#2b2f3a', `${d.hp} hp`, `${Math.round(d.boost * 3.6)} km/h · ${d.seats + 1} seat${d.seats ? 's' : ''}${k === 'tank' ? ' · cannon · drives through walls' : k === 'heli' ? ' · nose gun' : k === 'plane' ? ' · guns + bombs' : k === 'moto' ? ' · fastest on wheels' : ' · drive-by'}`);
  });
  el.innerHTML = `<h3 class="wall-title">The arsenal <span>(${WEAPON_IDS.length} guns, ${perks.length} perks, ${veh.length} vehicles)</span></h3>`
    + `<div class="arm-row"><h4>Guns</h4><div class="arm-grid">${guns.join('')}</div></div>`
    + `<div class="arm-row"><h4>Perks & bombs</h4><div class="arm-grid">${perks.join('')}</div></div>`
    + `<div class="arm-row"><h4>Vehicles</h4><div class="arm-grid">${veh.join('')}</div></div>`;
  renderer.dispose(); renderer.forceContextLoss();
}

// the character picker: one picture per character, click to choose
export function renderSkins(el: HTMLElement, picked: number, onPick: (i: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 200;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true }); } catch { return; }
  renderer.setClearColor(0x000000, 0);
  const mats = COLORS.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const fakeInk = { material: (id: number) => mats[id] } as unknown as InkRenderer;
  const pics = SKINS.map((_, i) => {
    const f = buildFigure(fakeInk, 7, i);
    // hidden parts still count for the framing: take them off
    f.root.remove(f.chute, f.crown);
    for (const g of f.guns.values()) g.parent?.remove(g);
    f.axe.parent?.remove(f.axe);
    f.armL.rotation.x = -1.25; f.armR.rotation.x = -1.25; f.armL.rotation.y = 0; // arms down at the sides, face visible
    return picture(renderer, f.root, Math.PI + 0.5, 0.15);
  });
  renderer.dispose(); renderer.forceContextLoss();
  el.innerHTML = SKINS.map((n, i) => `<button type="button" class="skin ${i === picked ? 'on' : ''}" data-skin="${i}" aria-label="${n}"><img src="${pics[i]}" alt=""><span>${n}</span></button>`).join('');
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-skin]');
    if (!b) return;
    const i = Number(b.dataset.skin);
    el.querySelectorAll('.skin').forEach((x) => x.classList.toggle('on', x === b));
    onPick(i);
  };
}
