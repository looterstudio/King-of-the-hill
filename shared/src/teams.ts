// Team assignment for duos and squads: parties first (split if bigger than a team), then solo
// players fill the gaps. Used by the server's rooms and by the offline demo.
export function makeTeams(players: { id: number; party: string }[], size: number): Map<number, number> {
  const out = new Map<number, number>();
  if (size <= 1) { players.forEach((p, i) => out.set(p.id, i + 1)); return out; }
  const parties = new Map<string, number[]>(), solos: number[] = [];
  for (const p of players) { if (p.party) { const g = parties.get(p.party) ?? []; g.push(p.id); parties.set(p.party, g); } else solos.push(p.id); }
  const teams: number[][] = [];
  for (const g of parties.values()) for (let i = 0; i < g.length; i += size) teams.push(g.slice(i, i + size));
  teams.sort((a, b) => b.length - a.length);
  for (const t of teams) while (t.length < size && solos.length) t.push(solos.shift()!);
  while (solos.length) teams.push(solos.splice(0, size));
  teams.forEach((t, i) => { for (const id of t) out.set(id, i + 1); });
  return out;
}
