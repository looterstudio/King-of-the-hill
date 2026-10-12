// Walks, sprints, jumps and slides players into every mountain from all sides and reports any that end up inside a block.
//   npx tsx scripts/sweep-mountains.ts [seed]
import { World, moveBody, newBody } from '../shared/src/world.ts';
import { GRAVITY, JUMP_V, SPRINT_SPEED, WALK_SPEED, TICK_HZ } from '../shared/src/constants.ts';

const seed = Number(process.argv[2] ?? 1), w = new World(seed), DT = 1 / TICK_HZ;
let bad = 0, runs = 0;
let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
for (const poi of w.pois.filter((p) => /Doodle|Snowpeak|Pyramid|Ridge|Mine|Castle|Mesa/i.test(p.name))) {
  const seen = new Set<string>();
  for (let k = 0; k < 400; k++) {
    const a = rnd() * Math.PI * 2, r = 5 + rnd() * 70, x = poi.x + Math.cos(a) * r, z = poi.z + Math.sin(a) * r;
    const p = newBody(x, w.groundAt(x, z, 400), z);
    let yaw = Math.atan2(-(poi.x - x), -(poi.z - z)) + (rnd() - 0.5) * 1.5;
    const mode = k % 6;
    for (let t = 0; t < 600; t++) {
      if (t % 45 === 0) yaw += (rnd() - 0.5) * 2.2;
      const inp = { fwd: 1, strafe: rnd() < 0.2 ? (rnd() < 0.5 ? 1 : -1) : 0, yaw, pitch: mode >= 4 ? 0.1 + rnd() * 0.5 : 0, jump: mode >= 1 && t % 25 === 0, sprint: mode >= 2, slide: mode === 3 && t % 60 === 10, grapple: mode >= 4 && t % 90 < 60 };
      moveBody(w, p, inp, DT, GRAVITY, WALK_SPEED, SPRINT_SPEED, JUMP_V);
      const b = w.overlapsAll(p.x, p.y + 0.02, p.z, []).find((q) => q.hard && q.x1 - q.x0 > 6 && q.z1 - q.z0 > 6);
      if (b) { const key = `${Math.round(p.x)},${Math.round(p.z)}`; if (!seen.has(key)) { seen.add(key); bad++; if (seen.size <= 3) console.log(`${poi.name}: inside a block at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} (box ${b.x0.toFixed(1)}..${b.x1.toFixed(1)}, y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}, z ${b.z0.toFixed(1)}..${b.z1.toFixed(1)}) mode ${mode}`); } break; }
    }
    runs++;
  }
  console.log(poi.name, 'embedded:', seen.size);
}
console.log(`${bad} embedded of ${runs} runs`);
