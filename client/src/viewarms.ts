// First person: your own arms holding the gun, drawn like everything else (boxes the ink pass outlines
// and hatches, so they read as a ballpoint sketch): a sleeve in your character's colour, a cuff, a paper
// hand on the grip and another on the handguard. The hands are pinned to the gun, so its sway, recoil,
// reload dip and swap drop carry them; during a reload the support hand leaves to slap the magazine.
// Also here: where the gun sits when you aim down sights, for each kind of sight.
import * as THREE from 'three';
import { WEAPONS, type Sight, type WeaponId } from '../../shared/src/constants.ts';
import { INK_IDS, type InkRenderer } from './ink.ts';

type V3 = [number, number, number];
// where each hand holds each gun, in the gun's own frame (grip at the origin, barrel down -z); null: one hand
const GRIPS: Record<WeaponId, { r: V3; l: V3 | null }> = {
  pistol: { r: [0, -0.07, 0.03], l: [-0.035, -0.1, 0.06] },
  smg: { r: [0, -0.08, 0.05], l: [0, -0.13, -0.08] },
  tac: { r: [0, -0.08, 0.06], l: [0, -0.02, -0.32] },
  pump: { r: [0, -0.08, 0.06], l: [0, -0.03, -0.36] },
  ar: { r: [0, -0.08, 0.04], l: [0, -0.04, -0.4] },
  scar: { r: [0, -0.08, 0.04], l: [0, -0.04, -0.4] },
  burst: { r: [0, -0.08, -0.12], l: [0, -0.03, -0.36] },
  hunting: { r: [0, -0.06, 0.08], l: [0, -0.03, -0.3] },
  heavy: { r: [0, -0.1, 0.08], l: [0, -0.04, -0.36] },
  minigun: { r: [0.06, -0.06, 0.12], l: [0, 0.14, -0.05] },
  rocket: { r: [0, -0.1, -0.05], l: [0, -0.1, -0.35] },
  guided: { r: [0, -0.1, -0.05], l: [0, -0.04, -0.4] },
  stinger: { r: [0, -0.1, -0.02], l: [0, -0.04, -0.42] },
  blade: { r: [0, 0, 0.04], l: null },
  wand: { r: [0, 0, 0.1], l: null },
};
// the shoulders, off the bottom corners of the screen (camera space)
const SHOULDER_R = new THREE.Vector3(0.42, -0.6, 0.15), SHOULDER_L = new THREE.Vector3(-0.42, -0.6, 0.1);
const SCALE = 0.62; // the view guns' scale

// where the gun sits: at the hip, or aimed. Irons and red dots come up to the middle of the screen with
// the sight just under the crosshair; a launcher stays on the shoulder, off to the side, so it never
// hides what you're aiming at; hip guns barely move; a scope hides the gun altogether
export function gunPose(w: WeaponId, top: number, ads: number): { x: number; y: number; z: number; ry: number } {
  const hip = { x: 0.2, y: -0.2, z: -0.5, ry: 0 }, s: Sight = WEAPONS[w].sight;
  const aim = s === 'iron' || s === 'dot' ? { x: 0, y: -top * SCALE - (WEAPONS[w].pellets > 1 ? 0.06 : 0.035), z: -0.38, ry: 0 }
    : s === 'ring' ? { x: 0.25, y: -0.16, z: -0.5, ry: 0.06 }
    : { x: 0.15, y: -0.19, z: -0.47, ry: 0 };
  return { x: hip.x + (aim.x - hip.x) * ads, y: hip.y + (aim.y - hip.y) * ads, z: hip.z + (aim.z - hip.z) * ads, ry: aim.ry * ads };
}

interface Arm { sleeve: THREE.Mesh; cuff: THREE.Mesh; hand: THREE.Group }
export class ViewArms {
  private group = new THREE.Group();
  private r: Arm; private l: Arm;
  private skinKey = '';
  private v = new THREE.Vector3(); private q = new THREE.Quaternion(); private m = new THREE.Matrix4();
  constructor(private ink: InkRenderer, scene: THREE.Scene) {
    this.r = this.arm(); this.l = this.arm();
    this.group.visible = false;
    scene.add(this.group);
  }
  private arm(): Arm {
    const front = (i: number) => this.ink.material(i, true);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.052, 1), front(INK_IDS.BLUE));
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.058, 0.03), front(INK_IDS.GRAPHITE));
    // a mitten of a hand: palm, the fingers wrapped round the grip, a thumb on top
    const hand = new THREE.Group(), paper = front(INK_IDS.PAPER);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.055, 0.07), paper);
    const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.03, 0.065), paper); fingers.position.set(0, -0.035, -0.012);
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.05), paper); thumb.position.set(-0.03, 0.02, -0.03);
    hand.add(palm, fingers, thumb); hand.scale.setScalar(0.8);
    this.group.add(sleeve, cuff, hand);
    return { sleeve, cuff, hand };
  }
  // your character's sleeves (the same colours as the figure others see)
  setSkin(skin: number, id: number) {
    const key = `${skin}:${id}`;
    if (key === this.skinKey) return;
    this.skinKey = key;
    const SUIT = [INK_IDS.RED, INK_IDS.PINK, INK_IDS.ORANGE, INK_IDS.GREEN, INK_IDS.BROWN];
    const ink = skin === 1 || skin === 2 || skin === 5 || skin === 7 ? INK_IDS.GRAPHITE : skin === 3 ? INK_IDS.BLUE : skin === 4 ? INK_IDS.RED : skin === 6 ? INK_IDS.GREEN : SUIT[id % SUIT.length];
    for (const a of [this.r, this.l]) a.sleeve.material = this.ink.material(ink, true);
  }
  hide() { this.group.visible = false; }
  // healing: both hands hold the potion or medkit (a group in the view scene, already posed this frame)
  updateItem(item: THREE.Group, half: number, up: number) {
    this.group.visible = true;
    item.updateMatrixWorld();
    this.place(this.r, item, [half, up, 0], SHOULDER_R, null);
    this.place(this.l, item, [-half, up, 0], SHOULDER_L, null);
    for (const o of [this.l.sleeve, this.l.cuff, this.l.hand]) o.visible = true;
  }
  // gun: the view gun, already posed this frame; reload: 0..1 through a reload (0 when not reloading)
  update(gun: THREE.Group, w: WeaponId, reload: number) {
    this.group.visible = true;
    gun.updateMatrixWorld();
    const g = GRIPS[w];
    this.place(this.r, gun, g.r, SHOULDER_R, null);
    if (g.l) {
      // the support hand drops to the magazine and back while reloading
      const k = Math.sin(Math.min(1, reload) * Math.PI);
      let at: V3 = [g.l[0] * (1 - k), g.l[1] + (-0.2 - g.l[1]) * k, g.l[2] + (-0.12 - g.l[2]) * k];
      // the heavy rifle: the hand goes up to the open action and feeds the rounds in one by one
      if (w === 'heavy') { const ins = Math.sin(Math.min(1, reload) * Math.PI * 6) * 0.045 * k; at = [g.l[0] * (1 - k) + 0.07 * k, g.l[1] * (1 - k) + 0.03 * k + ins, g.l[2] * (1 - k) + -0.04 * k]; }
      this.place(this.l, gun, at, SHOULDER_L, k);
    }
    for (const o of [this.l.sleeve, this.l.cuff, this.l.hand]) o.visible = !!g.l;
  }
  private place(a: Arm, gun: THREE.Group, local: V3, shoulder: THREE.Vector3, free: number | null) {
    const hand = this.v.set(local[0], local[1], local[2]);
    gun.localToWorld(hand);
    // the hand turns with the gun (a loose hand off to the magazine turns palm up a little)
    gun.getWorldQuaternion(this.q);
    a.hand.position.copy(hand); a.hand.quaternion.copy(this.q);
    if (free) a.hand.rotateX(-0.8 * free);
    // the forearm: from just behind the hand back to the shoulder, off screen
    const dir = shoulder.clone().sub(hand), len = dir.length();
    dir.divideScalar(len);
    const wrist = hand.clone().addScaledVector(dir, 0.045);
    this.m.lookAt(shoulder, wrist, new THREE.Vector3(0, 1, 0));
    a.sleeve.quaternion.setFromRotationMatrix(this.m); a.cuff.quaternion.copy(a.sleeve.quaternion);
    const sl = len - 0.08;
    a.sleeve.scale.set(1, 1, sl);
    a.sleeve.position.copy(wrist).addScaledVector(dir, 0.035 + sl / 2);
    a.cuff.position.copy(wrist).addScaledVector(dir, 0.02);
  }
}
