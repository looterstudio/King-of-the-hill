// The weapons HUD, bottom centre, Half-Life style: the pickaxe and four gun slots, each with the
// gun's silhouette in its rarity colour, its name, upgrade stars and ammo; the one in your hands is
// lifted and outlined. Shields, medkits and the perk sit to its right with their keys.
import { PERKS, WEAPONS } from '../../shared/src/constants.ts';
import type { SnapSelf } from '../../shared/src/protocol.ts';
import { RARITY_CSS } from './game3d.ts';

export function hotbarHTML(me: SnapSelf): string {
  const slot = (key: string, cls: string, color: string, icon: string, name: string, extra: string, ammo: string) =>
    `<div class="hb-slot ${cls}" style="--rc:${color}"><kbd>${key}</kbd><i class="ico ${icon}"></i><span class="hb-name">${name}${extra}</span><em>${ammo}</em></div>`;
  const guns = [slot('X', `axe ${me.axe ? 'on' : ''}`, '#0fa3c4', 'ico-axe', 'Pickaxe', '', `▦ ${me.mats}`)];
  me.slots.forEach((s, i) => {
    if (!s) { guns.push(`<div class="hb-slot empty"><kbd>${i + 1}</kbd><span class="hb-name">empty</span></div>`); return; }
    const d = WEAPONS[s], on = i === me.cur && !me.axe, ups = me.ups?.[i] ?? 0;
    const ammo = d.melee ? '∞' : `${me.mags[i]}<small>/${d.ammo ? me.ammo?.[d.ammo] ?? 0 : d.mag}</small>`; // in the magazine / left to reload with
    guns.push(slot(String(i + 1), `${on ? 'on' : ''} ${!d.melee && me.mags[i] === 0 ? 'dry' : ''} r-${d.rarity}`, RARITY_CSS[d.rarity], `ico-gun-${s}`, d.name, ups ? `<b class="hb-stars">${'★'.repeat(ups)}</b>` : '', ammo));
  });
  const item = (key: string, n: number, what: string, name: string, color = '') =>
    `<div class="hb-item ${n ? '' : 'none'}" ${color ? `style="--rc:${color}"` : ''}><kbd>${key}</kbd><i class="pic ico-item-${what}"></i><b>${n ? `×${n}` : ''}</b><small>${name}</small></div>`;
  const perk = me.perk;
  const items = item('5', me.items.big, 'big', 'Shield') + item('5', me.items.mini, 'mini', 'Mini')
    + item('6', me.items.med, 'med', 'Medkit')
    + (perk ? item('G', perk.n, perk.kind, PERKS[perk.kind].name, RARITY_CSS[PERKS[perk.kind].rarity]) : `<div class="hb-item none"><kbd>G</kbd><i class="pic"></i><b></b><small>no perk</small></div>`);
  return `<div class="hb-guns">${guns.join('')}</div><div class="hb-items">${items}<div class="hb-keys"><span><kbd>Z</kbd> wheel</span><span><kbd>Tab</kbd> inventory</span></div></div>`;
}
