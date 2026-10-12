// One line on everything you can carry: what it does and how to use it. The hotbar, the inventory,
// the item wheel and the "picked up" toasts all read from here.
import { C4, ITEMS, MOLOTOV, PERKS, UPGRADE, WEAPONS, type ItemId, type PerkId, type WeaponId, AMMO, type AmmoId } from '../../shared/src/constants.ts';

export interface Doc { name: string; what: string; how: string }

const GUN: Record<WeaponId, string> = {
  pistol: 'Reliable sidearm. Tap for accurate shots.',
  smg: 'Sprays fast up close. Hold to fire.',
  tac: 'Quick-firing shotgun. Deadly within 20 m.',
  pump: 'Slow shotgun that hits hard up close.',
  ar: 'All-rounder. Aim down sights for range.',
  burst: 'Three rounds per click. Precise at range.',
  hunting: 'One shot, then reload. Headshots hit double.',
  minigun: 'Hold to spin up, then it shreds. Long reload.',
  scar: 'The best rifle. Hard hitting and steady.',
  heavy: 'Scoped sniper. A headshot drops anyone.',
  rocket: 'Blows up players, vehicles and walls.',
  stinger: 'Locks onto helicopters and planes.',
  guided: 'Fire, then steer the missile with your crosshair.',
  blade: 'Melee. Cuts everyone in front of you, through walls.',
  wand: 'A spell that hurts and throws people back.',
};
export const gunDoc = (id: WeaponId): Doc => ({ name: WEAPONS[id].name, what: GUN[id], how: WEAPONS[id].melee ? 'Left click to swing' : WEAPONS[id].auto ? 'Hold left click · R reload' : 'Left click · R reload' });

export const ITEM_DOCS: Record<ItemId, Doc> = {
  big: { name: ITEMS.big.name, what: `+${ITEMS.big.shield} shield, up to ${ITEMS.big.shieldCap}. Takes ${ITEMS.big.use} s.`, how: 'Press 5 (or pick it on the wheel)' },
  mini: { name: ITEMS.mini.name, what: `+${ITEMS.mini.shield} shield, up to ${ITEMS.mini.shieldCap}. Takes ${ITEMS.mini.use} s.`, how: 'Press 5 when out of potions, or the wheel' },
  med: { name: ITEMS.med.name, what: `Heals you to full. Takes ${ITEMS.med.use} s.`, how: 'Press 6 (or pick it on the wheel)' },
};

export const PERK_DOCS: Record<PerkId, Doc> = {
  grenade: { name: PERKS.grenade.name, what: 'Bounces, then a big blast.', how: 'G to throw where you look' },
  molotov: { name: PERKS.molotov.name, what: `A patch of fire that burns for ${MOLOTOV.life} s.`, how: 'G to throw where you look' },
  shock: { name: PERKS.shock.name, what: 'Throws everyone nearby through the air, you too.', how: 'G to throw · look down to launch yourself' },
  smoke: { name: PERKS.smoke.name, what: 'A cloud to hide a revive or an escape.', how: 'G to throw' },
  launch: { name: PERKS.launch.name, what: 'A pad that fires you into the sky. Glide away.', how: 'G to place it, then step on' },
  fort: { name: PERKS.fort.name, what: 'Four walls around you, instantly.', how: 'G where you stand' },
  kit: { name: PERKS.kit.name, what: `One upgrade star on the gun in your hands (max ${UPGRADE.max}).`, how: 'Hold the gun, press G' },
  c4: { name: PERKS.c4.name, what: `Sticks where it lands. Up to ${C4.dmg} damage, yours too.`, how: 'G to throw, G again to set it off' },
  nuke: { name: PERKS.nuke.name, what: 'Wipes out everything where it lands.', how: 'Look at the spot, press G, run' },
};

export const AXE_DOC: Doc = { name: 'Diamond Pickaxe', what: 'Breaks walls, cars and people. Every block gives ▦ material.', how: 'Q · left click break · right click or B build' };
// ammo: which guns take it
const AMMO_FOR: Record<AmmoId, string> = { light: 'Pistol, SMG and Minigun', medium: 'Assault Rifle, Burst Rifle and SCAR', heavy: 'Hunting Rifle and Heavy Sniper', shells: 'the shotguns', rockets: 'the launchers' };
export const ammoDoc = (a: AmmoId): Doc => ({ name: AMMO[a].name, what: `Reloads for ${AMMO_FOR[a]}. You carry up to ${AMMO[a].max}.`, how: 'Walk over it · R reloads' });
export const MATS_DOC: Doc = { name: 'Material ▦', what: 'Building blocks. Break things with the pickaxe for more.', how: 'Pickaxe out, right click to place a block' };
