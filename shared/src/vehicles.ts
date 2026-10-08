// Vehicle physics, shared by the server and the driver's client prediction (exactly like walking):
// the driver's own body carries the vehicle state (ride, heading, pitch, speed), so the client
// replays unacknowledged inputs through the same code and driving feels instant.
//  - car: throttle and steer, boost with Shift, hop with Space, climbs curbs and stairs
//  - helicopter: turns toward where you look, strafes, Space / C (or Ctrl) to climb and descend
//  - plane: always moving; mouse sets heading and pitch, W / S throttle, Shift afterburner
// Returns the speed at which it hit something this step (0 if nothing), for crash damage.
import { MAP_HALF, VEHICLES, VEHICLE_KINDS } from './constants.ts';
import type { Body, MoveInput, World } from './world.ts';

const angDiff = (a: number, b: number) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const kindOf = (ride: number) => VEHICLE_KINDS[ride - 1];

const CAR_STEP = 0.7;
const TAKEOFF = 19;

export function moveVehicle(w: World, p: Body, inp: MoveInput, dt: number, gravity: number, manned = true): number {
  const kind = kindOf(p.ride), def = VEHICLES[kind];
  let impact = 0;
  if (kind === 'car') {
    const top = inp.sprint ? def.boost : def.top;
    if (inp.fwd > 0) p.spd = Math.min(top, p.spd + def.accel * (p.spd < 0 ? 2 : 1) * inp.fwd * dt);
    else if (inp.fwd < 0) p.spd = Math.max(-9, p.spd + (p.spd > 0 ? -30 : -def.accel) * -inp.fwd * dt);
    else p.spd *= Math.max(0, 1 - dt * (p.grounded ? 1.1 : 0.2));
    if (p.spd > top) p.spd = Math.max(top, p.spd - 20 * dt);
    // steering bites harder at low speed, flips when reversing
    p.head += -inp.strafe * 2.3 * dt * clamp(p.spd / 7, -1, 1) * (1 - Math.min(0.45, Math.abs(p.spd) / 80));
    if (inp.jump && p.grounded) { p.vy = 6.5; p.grounded = false; }
    p.vx = -Math.sin(p.head) * p.spd; p.vz = -Math.cos(p.head) * p.spd;
    p.vy -= gravity * dt;
    p.vpitch += (clamp(-p.vy * 0.03, -0.35, 0.35) - p.vpitch) * Math.min(1, dt * 6);
    // horizontal, one axis at a time: climb small steps, otherwise crash
    for (const [dx, dz] of [[p.vx * dt, 0], [0, p.vz * dt]]) {
      if (!dx && !dz) continue;
      const nx = p.x + dx, nz = p.z + dz;
      const b = w.hitBox(nx, p.y, nz, def.r, def.h);
      if (!b) { p.x = nx; p.z = nz; continue; }
      const rise = b.y1 - p.y;
      if (p.grounded && rise > 0 && rise <= CAR_STEP && !w.hitBox(nx, b.y1 + 1e-3, nz, def.r, def.h)) { p.x = nx; p.z = nz; p.y = b.y1; continue; }
      impact = Math.max(impact, Math.abs(p.spd));
      p.spd *= -0.25;
    }
  } else if (kind === 'heli') {
    if (manned) {
      p.head += angDiff(inp.yaw, p.head) * Math.min(1, dt * 2.5);
      const top = inp.sprint ? def.boost : def.top;
      const s = Math.sin(p.head), c = Math.cos(p.head);
      let wx = -s * inp.fwd + c * inp.strafe, wz = -c * inp.fwd - s * inp.strafe;
      const l = Math.hypot(wx, wz); if (l > 1) { wx /= l; wz /= l; }
      const k = Math.min(1, dt * (def.accel / top) * 2.2);
      p.vx += (wx * top - p.vx) * k; p.vz += (wz * top - p.vz) * k;
      p.vy += ((inp.up ?? 0) * 11 - p.vy) * Math.min(1, dt * 3);
      p.vpitch += (-inp.fwd * 0.25 - p.vpitch) * Math.min(1, dt * 4);
    } else { // nobody at the stick: it drops
      p.vx *= 1 - dt * 0.4; p.vz *= 1 - dt * 0.4; p.vy -= gravity * 0.7 * dt;
    }
    p.spd = Math.hypot(p.vx, p.vz);
    impact = move3(w, p, def.r, def.h, dt);
  } else {
    // plane: heading and pitch follow the mouse at a limited rate; speed is throttle
    if (manned) {
      p.head += clamp(angDiff(inp.yaw, p.head), -1, 1) * 1.6 * dt;
      p.vpitch += clamp(clamp(inp.pitch, -0.7, 0.6) - p.vpitch, -1, 1) * 1.6 * dt;
      const top = inp.sprint ? def.boost : def.top;
      if (inp.fwd > 0) p.spd = Math.min(top, p.spd + def.accel * dt);
      else if (inp.fwd < 0) p.spd = Math.max(p.grounded ? 0 : 14, p.spd - def.accel * 1.4 * dt);
      else if (p.spd > top) p.spd -= 15 * dt;
    } else { p.vpitch += (-0.35 - p.vpitch) * dt; p.spd = Math.max(0, p.spd - (p.grounded ? 12 : 2) * dt); }
    // on the ground below take-off speed it rolls flat; in the air too slow and the nose drops
    if (p.grounded && (p.spd < TAKEOFF || p.vpitch < 0.05)) p.vpitch = Math.max(0, Math.min(p.vpitch, p.spd < TAKEOFF ? 0 : 1));
    if (!p.grounded && p.spd < TAKEOFF) p.vpitch += (-0.5 - p.vpitch) * dt;
    const cp = Math.cos(p.vpitch);
    p.vx = -Math.sin(p.head) * cp * p.spd; p.vz = -Math.cos(p.head) * cp * p.spd;
    p.vy = Math.sin(p.vpitch) * p.spd - (p.spd < TAKEOFF ? gravity * 0.6 * (1 - p.spd / TAKEOFF) * 3 : 0);
    if (p.grounded && p.vy < 0) p.vy = 0;
    const hit = move3(w, p, def.r, def.h, dt);
    if (hit) { impact = Math.max(hit, p.spd); p.spd *= 0.2; }
  }
  const lim = MAP_HALF - def.r;
  p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
  if (p.y > 160) { p.y = 160; if (p.vy > 0) p.vy = 0; }
  // vertical for the car (the others move in 3D in move3)
  if (kind === 'car') {
    const wasUp = !p.grounded;
    p.grounded = false;
    p.y += p.vy * dt;
    const b = w.hitBox(p.x, p.y, p.z, def.r, def.h);
    if (b) { if (p.vy <= 0) { if (wasUp && p.vy < -14) impact = Math.max(impact, -p.vy); p.y = b.y1; p.grounded = true; } else p.y = b.y0 - def.h - 1e-3; p.vy = 0; }
    if (p.y <= 0) { if (wasUp && p.vy < -14) impact = Math.max(impact, -p.vy); p.y = 0; p.vy = 0; p.grounded = true; }
  }
  return impact;
}

// free 3D movement for aircraft: slide along whatever it touches, report the speed lost
function move3(w: World, p: Body, r: number, h: number, dt: number): number {
  let impact = 0;
  for (const axis of [0, 1, 2]) {
    const d = (axis === 0 ? p.vx : axis === 1 ? p.vy : p.vz) * dt;
    if (!d) continue;
    const nx = p.x + (axis === 0 ? d : 0), ny = p.y + (axis === 1 ? d : 0), nz = p.z + (axis === 2 ? d : 0);
    const b = w.hitBox(nx, ny, nz, r, h);
    if (!b && ny >= 0) { p.x = nx; p.y = ny; p.z = nz; if (axis === 1) p.grounded = false; continue; }
    if (axis === 1) {
      if (d < 0) { p.y = b ? b.y1 : 0; p.grounded = true; impact = Math.max(impact, -p.vy > 9 ? -p.vy : 0); }
      p.vy = 0;
    } else {
      impact = Math.max(impact, Math.abs(axis === 0 ? p.vx : p.vz));
      if (axis === 0) p.vx *= -0.2; else p.vz *= -0.2;
    }
  }
  if (p.grounded) { p.vx *= 1 - Math.min(1, dt * 3); p.vz *= 1 - Math.min(1, dt * 3); }
  return impact;
}
