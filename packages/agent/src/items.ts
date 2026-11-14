/**
 * Item names.
 *
 * SavedVariables give item *ids* (BagBrother writes `3581::::::::31:1486::11:::::::`) and nothing
 * else. Names come from whatever external source the user has, and every source is optional:
 *
 *   - `PORTALSTONE_ITEM_API`     any endpoint where GET `/{id}` returns `{"name": "…"}`
 *   - `PORTALSTONE_ITEM_NAMES`   a JSON file `{"123": "Name"}`
 *   - `PORTALSTONE_BNET_ID` + `PORTALSTONE_BNET_SECRET` [+ `PORTALSTONE_BNET_REGION`]
 *                                Blizzard's official game-data API, client credentials, per user
 *
 * Two behaviours matter more than coverage:
 *
 * 1. **A name is fetched once.** Everything lands in `item_name` and is never overwritten, so a
 *    source that breaks tomorrow cannot erase what it gave today.
 * 2. **A miss is remembered.** A private-server item that does not exist upstream is recorded in
 *    `item_name_miss` and skipped for a week, instead of being re-requested on every scan.
 *
 * Blizzard's API returns **404 for both "no such item" and "no token"**, so an unauthorized client
 * looks exactly like an empty database. This module authenticates first and reports 401/403 as an
 * error, never as an unknown item.
 */
import { readFileSync } from 'node:fs';
import type { Store } from './store';

export interface BlizzardConfig {
  clientId: string;
  clientSecret: string;
  region: string;
  /** test seams: defaults are the real Blizzard endpoints */
  tokenUrl?: string;
  itemUrl?: string;
}

export interface ItemNameConfig {
  /** base URL where GET `${base}/${id}` returns `{ "name": "..." }` */
  apiBase?: string;
  /** JSON file of `{ "123": "Name" }` */
  file?: string;
  /** official Blizzard game-data API, per-user client credentials */
  blizzard?: BlizzardConfig;
}

/** How many ids one refresh may ask any one network source for. */
const MAX_LOOKUPS_PER_REFRESH = 25;
const TIMEOUT_MS = 5000;
/** How long an item a source could not resolve is left alone before being asked about again. */
export const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function itemNameConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ItemNameConfig {
  const apiBase = env.PORTALSTONE_ITEM_API?.trim();
  const file = env.PORTALSTONE_ITEM_NAMES?.trim();
  const clientId = env.PORTALSTONE_BNET_ID?.trim();
  const clientSecret = env.PORTALSTONE_BNET_SECRET?.trim();
  const region = (env.PORTALSTONE_BNET_REGION?.trim() || 'us').toLowerCase();
  return {
    ...(apiBase ? { apiBase: apiBase.replace(/\/$/, '') } : {}),
    ...(file ? { file } : {}),
    ...(clientId && clientSecret ? { blizzard: { clientId, clientSecret, region } } : {}),
  };
}

/**
 * `3581::::::::31:1486::11:::::::` → 3581. Bag strings use `id;count`, equip strings use
 * `id:enchant:gem:...`; both start with the item id.
 */
export function itemIdFromString(value: string): number | null {
  const head = value.split(/[:;]/)[0] ?? '';
  if (!/^\d+$/.test(head)) return null;
  const id = Number(head);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Every item id present in a set's members, for name resolution. */
export function itemIdsIn(members: { k: string; v: string }[]): number[] {
  const ids: number[] = [];
  for (const m of members) {
    const id = itemIdFromString(m.v);
    if (id !== null) ids.push(id);
  }
  return ids;
}

export interface NameRefresh {
  /** ids whose names were added by this call */
  added: number;
  /** ids still without a name, and not known to be unresolvable */
  missing: number;
  /** sources that contributed names */
  sources: string[];
  /** ids a source reported as nonexistent (recorded, not retried for a week) */
  unknown: number;
  /** ids a source failed on transiently (429/5xx/network) — retried next scan */
  failed: number;
  /** the Blizzard client was rejected: credentials are wrong or absent */
  unauthorized: boolean;
  errors: string[];
}

/** Last problem seen by a name source, for the diagnostics page. */
let lastError: string | null = null;
export function lastItemNameError(): string | null {
  return lastError;
}

export async function refreshItemNames(
  store: Store,
  ids: number[],
  config: ItemNameConfig = itemNameConfigFromEnv(),
): Promise<NameRefresh> {
  const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  const result: NameRefresh = {
    added: 0,
    missing: unique.length,
    sources: [],
    unknown: 0,
    failed: 0,
    unauthorized: false,
    errors: [],
  };
  if (unique.length === 0) return result;

  if (config.file) {
    const fromFile = readNameFile(config.file);
    if (fromFile.size > 0) {
      const wanted = unique.filter((id) => fromFile.has(id)).map((id) => ({ id, name: fromFile.get(id)!, source: 'file' }));
      result.added += store.saveItemNames(wanted);
      if (wanted.length) result.sources.push('file');
    }
  }

  const misses = store.itemNameMisses(unique, MISS_TTL_MS);
  const pending = (): number[] => {
    const known = store.itemNames(unique);
    return unique.filter((id) => !known.has(id) && !misses.has(id));
  };

  if (config.apiBase) {
    const wanted = pending().slice(0, MAX_LOOKUPS_PER_REFRESH);
    const fetched: { id: number; name: string; source: string }[] = [];
    for (const id of wanted) {
      const name = await fetchJsonName(`${config.apiBase}/${id}`);
      if (name) fetched.push({ id, name, source: 'api' });
      else result.failed++;
    }
    if (fetched.length > 0) {
      result.added += store.saveItemNames(fetched);
      result.sources.push('api');
    }
  }

  if (config.blizzard) {
    const wanted = pending().slice(0, MAX_LOOKUPS_PER_REFRESH);
    if (wanted.length > 0) {
      let token: string;
      try {
        token = await blizzardToken(config.blizzard);
      } catch (err) {
        // 401 here means bad or missing credentials, and the item endpoint would answer 404,
        // which must not be mistaken for "this item has no name".
        result.unauthorized = true;
        lastError = `Blizzard auth failed: ${(err as Error).message}`;
        result.errors.push(lastError);
        return finish(store, unique, result);
      }

      const fetched: { id: number; name: string; source: string }[] = [];
      const unknownIds: number[] = [];
      for (const id of wanted) {
        const lookup = await blizzardItem(config.blizzard, id, token);
        if (lookup.kind === 'name') fetched.push({ id, name: lookup.name, source: 'blizzard' });
        else if (lookup.kind === 'missing') unknownIds.push(id);
        else if (lookup.kind === 'auth') {
          result.unauthorized = true;
          lastError = 'Blizzard rejected the access token (401/403)';
          result.errors.push(lastError);
          break;
        } else {
          lastError = `Blizzard lookup failed for ${id}: ${lookup.reason}`;
          result.errors.push(lastError);
          break; // 429/5xx: stop for this scan rather than hammer the endpoint
        }
      }
      if (fetched.length > 0) {
        result.added += store.saveItemNames(fetched);
        result.sources.push('blizzard');
      }
      if (unknownIds.length > 0) {
        store.saveItemNameMisses(unknownIds, 'blizzard');
        result.unknown = unknownIds.length;
      }
    }
  }

  return finish(store, unique, result);
}

function finish(store: Store, ids: number[], result: NameRefresh): NameRefresh {
  const misses = store.itemNameMisses(ids, MISS_TTL_MS);
  const known = store.itemNames(ids);
  result.missing = ids.filter((id) => !known.has(id) && !misses.has(id)).length;
  return result;
}

// ---- Blizzard official game data ------------------------------------------------------------

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

/** Test seam: forget the cached OAuth token. */
export function resetBlizzardToken(): void {
  tokenCache = null;
}

async function blizzardToken(cfg: BlizzardConfig): Promise<string> {
  const key = `${cfg.region}:${cfg.clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const tokenUrl = cfg.tokenUrl ?? 'https://oauth.battle.net/token';
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  const payload = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!token) throw new Error('token endpoint returned no access_token');
  const lifetime = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 86_400;
  tokenCache = { key, token, expiresAt: Date.now() + lifetime * 1000 };
  return token;
}

type BlizzardLookup =
  | { kind: 'name'; name: string }
  | { kind: 'missing' }
  | { kind: 'auth' }
  | { kind: 'error'; reason: string };

async function blizzardItem(cfg: BlizzardConfig, id: number, token: string): Promise<BlizzardLookup> {
  const base = cfg.itemUrl ?? `https://${cfg.region}.api.blizzard.com/data/wow/item`;
  const namespace = `static-${cfg.region}`;
  try {
    const res = await fetch(`${base}/${id}?namespace=${namespace}&locale=en_US`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Deliberate order: an unauthenticated request also answers 404, so auth is checked first.
    if (res.status === 401 || res.status === 403) return { kind: 'auth' };
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error', reason: `HTTP ${res.status}` };
    const payload = (await res.json()) as { name?: unknown };
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    return name ? { kind: 'name', name: name.slice(0, 120) } : { kind: 'missing' };
  } catch (err) {
    return { kind: 'error', reason: (err as Error).message };
  }
}

async function fetchJsonName(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const payload = (await res.json()) as { name?: unknown };
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    return name.length > 0 ? name.slice(0, 120) : null;
  } catch {
    return null;
  }
}

function readNameFile(path: string): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (typeof value === 'string' && value.trim().length > 0) out.set(id, value.trim().slice(0, 120));
    }
  } catch {
    /* a missing or broken dump file is not an error: it is just no names */
  }
  return out;
}
