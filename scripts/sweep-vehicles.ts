// Drives every vehicle into the mountains from all sides; reports any that end up inside a big hard block.
import { World, newBody } from '../shared/src/world.ts';
import { moveVehicle } from '../shared/src/vehicles.ts';
import { GRAVITY, TICK_HZ, VEHICLES, VEHICLE_KINDS } from '../shared/src/constants.ts';
const seed = Number(process.argv[2] ?? 1), w = new World(seed), DT = 1 / TICK_HZ;
let s = 777; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
let bad = 0, runs = 0;
for (const poi of w.pois.filter((p) => /Doodle|Snowpeak|Pyramid|Ridge/i.test(p.name))) {
  const per: Record<string, number> = {};
  for (const kind of VEHICLE_KINDS) for (let k = 0; k < 60; k++) {
    const def = VEHICLES[kind], a = rnd() * Math.PI * 2, r = 70 + rnd() * 40, x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
    const p = newBody(x, kind === 'car' || kind === 'moto' || kind === 'tank' ? 0 : 6, z); if (w.hitBox(x, p.y + 0.01, z, def.r, def.h)) continue;
    p.ride = VEHICLE_KINDS.indexOf(kind) + 1; p.head = Math.atan2(-(poi.x - x), -(poi.z - z)) + (rnd() - 0.5);
    p.spd = kind === 'plane' ? 30 : 0;
    for (let t = 0; t < 900; t++) {
      const inp = { fwd: 1, strafe: Math.sin(t / 40 + k) * 0.5, yaw: p.head + Math.sin(t / 70 + k) * 0.8, pitch: Math.sin(t / 90) * 0.3, jump: t % 50 === 0, sprint: true, slide: false, grapple: false, up: Math.sin(t / 60 + k) };
      moveVehicle(w, p, inp, DT, GRAVITY);
      const b = w.hitBox(p.x, p.y + 0.01, p.z, def.r, def.h);
      if (b && b.hard && b.x1 - b.x0 > 6 && b.z1 - b.z0 > 6) { bad++; per[kind] = (per[kind] ?? 0) + 1; if (bad <= 4) console.log(`${poi.name}: ${kind} inside a block at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} t=${t}`); break; }
    }
    runs++;
  }
  console.log(poi.name, JSON.stringify(per));
}
console.log(`${bad} of ${runs}`);
