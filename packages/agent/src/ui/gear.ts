/**
 * Inventory slots.
 *
 * BagBrother stores `equip` as an array indexed 1..19 exactly as the client's inventory slots are
 * numbered, so the index *is* the slot. These names are game knowledge, not a guess: slot 1 is the
 * head, 16 the main hand, 19 the tabard.
 *
 * Item strings are `itemId:enchant:gem:...`, and there is no local item database, so a slot can
 * only show its item id. Names would need an item table (the Forever API 404s on a large share of
 * ids), which is deliberately not invented here.
 */
export const SLOT_NAMES: Record<string, string> = {
  '1': 'head',
  '2': 'neck',
  '3': 'shoulder',
  '4': 'shirt',
  '5': 'chest',
  '6': 'waist',
  '7': 'legs',
  '8': 'feet',
  '9': 'wrist',
  '10': 'hands',
  '11': 'finger 1',
  '12': 'finger 2',
  '13': 'trinket 1',
  '14': 'trinket 2',
  '15': 'back',
  '16': 'main hand',
  '17': 'off hand',
  '18': 'ranged',
  '19': 'tabard',
};

export const SLOT_ORDER = Object.keys(SLOT_NAMES);

/** True when every key is an inventory slot number: this set is equipment. */
export function looksLikeEquipment(keys: string[]): boolean {
  if (keys.length === 0) return false;
  return keys.every((k) => /^\d+$/.test(k) && Number(k) >= 1 && Number(k) <= 19);
}

export function slotName(key: string): string {
  return SLOT_NAMES[key] ?? `[${key}]`;
}

/**
 * `3581::::::::31:1486::11:::::::` is item 3581 with enchant/gem context. Only the id is shown;
 * the trailing fields are another addon's serialisation, not something to interpret as a stat.
 */
export function itemLabel(value: string, names?: Map<number, string>): string {
  const id = value.split(':')[0] ?? '';
  if (!/^\d+$/.test(id)) return value;
  const name = names?.get(Number(id));
  return name ? `#${id} ${name}` : `#${id}`;
}

/** Sort members by slot number when they are slots, alphabetically otherwise. */
export function compareKeys(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}
