/**
 * Item id → model display id, resolved once and cached.
 *
 * The addon records what a character has equipped as item ids. A 3D model engine dresses the body
 * by *display* id, a different number, so the viewer needs a lookup the game never writes down.
 * Wowhead's item pages carry it: `/item={id}&xml` returns an `<icon displayId="…">` on the item,
 * and the Classic site answers for Classic/WoW-Forever item ids.
 *
 * The caching rules mirror item names on purpose (see items.ts):
 *   1. A display id is fetched once and never overwritten.
 *   2. An id the source could not resolve is remembered and skipped for a week, not re-requested
 *      on every scan.
 *
 * The network call is injected (`config.resolve`) so the resolution policy is tested without the
 * network, and so a different item database can be dropped in without touching the cache logic.
 */
import type { Store } from './store';

/** How many ids one refresh may ask the network for, so a big wardrobe is spread over scans. */
const MAX_LOOKUPS_PER_REFRESH = 25;
const TIMEOUT_MS = 8000;
/** How long an id the source could not resolve is left alone before being asked about again. */
export const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Wowhead's Classic item endpoint; the source of truth for WoW Forever item ids. */
export const DEFAULT_RESOLVER_BASE = 'https://www.wowhead.com/classic';

export interface DisplayIdConfig {
  /** base for the item XML endpoint; `${base}/item=${id}&xml` must carry an icon display id */
  base?: string;
  /** test/replacement seam: resolve one item id to a display id, or null when there is none */
  resolve?: (id: number) => Promise<number | null>;
  /** label stored beside a resolved display id, for provenance */
  source?: string;
}

export interface DisplayRefresh {
  /** ids whose display id this call added to the cache */
  added: number;
  /** ids still without a display id and not known to be unresolvable */
  missing: number;
  /** ids the source reported as having no display id (recorded, not retried for a week) */
  unknown: number;
  /** ids the source failed on transiently (network/timeout) — retried next scan */
  failed: number;
  errors: string[];
}

/** Every item id equipped across a set of gear slots, deduped. */
export function equippedItemIds(slots: { id: number | null }[]): number[] {
  const out = new Set<number>();
  for (const s of slots) if (s.id && Number.isInteger(s.id) && s.id > 0) out.add(s.id);
  return [...out];
}

/** Pull the display id out of Wowhead's item XML, or null when the item has none. */
export function parseDisplayId(xml: string): number | null {
  // The item's own icon carries it: <icon displayId="5194">name</icon>. A display id of 0 means
  // "no model" (many quest items, some off-hands), which is a miss, not a value.
  const m = xml.match(/displayId=["'](\d+)["']/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function fetchDisplayId(base: string, id: number): Promise<number | null> {
  const res = await fetch(`${base}/item=${id}&xml`, {
    headers: { 'user-agent': 'portalstone-model-viewer' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDisplayId(await res.text());
}

export async function refreshDisplayIds(
  store: Store,
  ids: number[],
  config: DisplayIdConfig = {},
): Promise<DisplayRefresh> {
  const result: DisplayRefresh = { added: 0, missing: 0, unknown: 0, failed: 0, errors: [] };
  const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (unique.length === 0) return result;

  const source = config.source ?? 'wowhead-classic';
  const base = config.base ?? DEFAULT_RESOLVER_BASE;
  const resolve = config.resolve ?? ((id: number) => fetchDisplayId(base, id));

  const misses = store.itemDisplayMisses(unique, MISS_TTL_MS);
  const known = store.itemDisplayIds(unique);
  const pending = unique.filter((id) => !known.has(id) && !misses.has(id)).slice(0, MAX_LOOKUPS_PER_REFRESH);

  const resolved: { id: number; displayId: number; source: string }[] = [];
  const unknownIds: number[] = [];
  for (const id of pending) {
    try {
      const displayId = await resolve(id);
      if (displayId && displayId > 0) resolved.push({ id, displayId, source });
      else unknownIds.push(id);
    } catch (err) {
      // Transient (network/timeout/5xx): leave it for the next scan rather than recording a miss.
      result.failed++;
      result.errors.push(`item ${id}: ${(err as Error).message}`);
    }
  }

  if (resolved.length > 0) result.added = store.saveItemDisplayIds(resolved);
  if (unknownIds.length > 0) {
    store.saveItemDisplayMisses(unknownIds, source);
    result.unknown = unknownIds.length;
  }

  const stillKnown = store.itemDisplayIds(unique);
  const stillMissed = store.itemDisplayMisses(unique, MISS_TTL_MS);
  result.missing = unique.filter((id) => !stillKnown.has(id) && !stillMissed.has(id)).length;
  return result;
}
