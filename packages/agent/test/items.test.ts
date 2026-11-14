import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import {
  itemIdFromString,
  itemIdsIn,
  lastItemNameError,
  refreshItemNames,
  resetBlizzardToken,
  type BlizzardConfig,
} from '../src/items';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-items-'));
let server: Server | null = null;
let store: Store;

function newStore(): Store {
  store = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  return store;
}

/** A stand-in for the Forever item endpoint: names for known ids, 404 for the rest. */
async function mockApi(names: Record<number, string>): Promise<{ base: string; hits: number[] }> {
  const hits: number[] = [];
  const s = createServer((req, res) => {
    const id = Number((req.url ?? '').split('/').pop());
    hits.push(id);
    const name = names[id];
    if (!name) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, name }));
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = s;
  const address = s.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/item`, hits };
}

afterEach(() => {
  server?.close();
  server = null;
  store?.close();
});

describe('item ids', () => {
  it('reads the id out of both SavedVariables forms', () => {
    expect(itemIdFromString('3581::::::::31:1486::11:::::::')).toBe(3581);
    expect(itemIdFromString('1179;7')).toBe(1179);
    expect(itemIdFromString('250531')).toBe(250531);
    expect(itemIdFromString('nil')).toBeNull();
    expect(itemIdFromString('')).toBeNull();
  });

  it('collects ids from a set of members', () => {
    expect(
      itemIdsIn([
        { k: '1', v: '250531' },
        { k: '16', v: '3581::::::::31:1486::11:::::::' },
        { k: '3', v: 'not-an-item' },
      ]),
    ).toEqual([250531, 3581]);
  });
});

/**
 * Names are a cache, not a dependency: ids always render, names fill in when a source provides them,
 * and a failed lookup must not lose what is already known.
 */
describe('item name cache', () => {
  it('fetches missing names and keeps them for good', async () => {
    newStore();
    const api = await mockApi({ 3581: 'Frostweave Robe', 250531: 'Bloodspiller' });
    const first = await refreshItemNames(store, [3581, 250531, 999], { apiBase: api.base });
    expect(first.sources).toEqual(['api']);
    expect(first.added).toBe(2);
    expect(first.missing).toBe(1);
    expect(first.failed).toBe(1);
    expect([...api.hits].sort((a, b) => a - b)).toEqual([999, 3581, 250531]);

    const second = await refreshItemNames(store, [3581, 250531], { apiBase: api.base });
    expect(second.added).toBe(0);
    expect(second.missing).toBe(0);
    // nothing was re-fetched: the cache answered
    expect(api.hits).toHaveLength(3);
  });

  it('leaves the cache untouched when the source is broken', async () => {
    newStore();
    store.saveItemNames([{ id: 3581, name: 'Known', source: 'file' }]);
    const out = await refreshItemNames(store, [3581, 4000], { apiBase: 'http://127.0.0.1:1/item' });
    expect(out.added).toBe(0);
    expect(out.missing).toBe(1);
    expect(store.itemNames([3581]).get(3581)).toBe('Known');
  });

  it('imports a local dump so a wiki export works without any network', async () => {
    newStore();
    const file = join(DIR, 'names.json');
    writeFileSync(file, JSON.stringify({ 3581: 'Frostweave Robe', 9999: 'Crude Bastard Sword' }));
    const out = await refreshItemNames(store, [3581, 9999, 1234], { file });
    expect(out.sources).toEqual(['file']);
    expect(out.added).toBe(2);
    expect(out.missing).toBe(1);
    expect(store.itemNames([3581, 9999])).toEqual(
      new Map([
        [3581, 'Frostweave Robe'],
        [9999, 'Crude Bastard Sword'],
      ]),
    );
  });

  it('keeps the first name it learned rather than overwriting on every scan', async () => {
    newStore();
    const file = join(DIR, 'first.json');
    writeFileSync(file, JSON.stringify({ 3581: 'First Name' }));
    await refreshItemNames(store, [3581], { file });
    const second = join(DIR, 'second.json');
    writeFileSync(second, JSON.stringify({ 3581: 'Different Name' }));
    await refreshItemNames(store, [3581], { file: second });
    expect(store.itemNames([3581]).get(3581)).toBe('First Name');
  });

  it('limits how many ids one refresh asks for', async () => {
    newStore();
    const names: Record<number, string> = {};
    for (let i = 1; i <= 100; i++) names[i] = `Item ${i}`;
    const api = await mockApi(names);
    const ids = Object.keys(names).map(Number);
    const out = await refreshItemNames(store, ids, { apiBase: api.base });
    expect(out.added).toBe(25);
    expect(out.missing).toBe(75);
    expect(api.hits).toHaveLength(25);
  });
});

/**
 * Blizzard's official game-data API.
 *
 * The trap it sets: an unauthenticated request answers 404, exactly like a missing item. So the
 * client must authenticate first and treat 401/403 as a configuration error — otherwise every
 * item looks unknown and the app reports "no names available" when it is simply unauthorized.
 */
async function mockBlizzard(opts: {
  tokenStatus?: number;
  items: Record<number, string>;
  itemStatus?: Record<number, number>;
}) {
  const counts = { token: 0, item: 0 };
  const s = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/token')) {
      counts.token++;
      if ((opts.tokenStatus ?? 200) !== 200) {
        res.writeHead(opts.tokenStatus ?? 401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-1', expires_in: 86_400 }));
      return;
    }
    counts.item++;
    const id = Number(url.split('/item/')[1]?.split('?')[0]);
    const forced = opts.itemStatus?.[id];
    if (forced) {
      res.writeHead(forced).end();
      return;
    }
    const name = opts.items[id];
    if (!name) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, name }));
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = s;
  const address = s.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const cfg: BlizzardConfig = {
    clientId: 'id',
    clientSecret: 'secret',
    region: 'us',
    tokenUrl: `http://127.0.0.1:${port}/token`,
    itemUrl: `http://127.0.0.1:${port}/item`,
  };
  return { cfg, counts };
}

describe('blizzard game data', () => {
  afterEach(() => resetBlizzardToken());

  it('authenticates once, then names items and tags their source', async () => {
    newStore();
    const api = await mockBlizzard({ items: { 3581: 'Frostweave Robe', 250531: 'Bloodspiller' } });
    const out = await refreshItemNames(store, [3581, 250531], { blizzard: api.cfg });
    expect(out.sources).toEqual(['blizzard']);
    expect(out.added).toBe(2);
    expect(out.unauthorized).toBe(false);
    expect(store.itemNames([3581]).get(3581)).toBe('Frostweave Robe');
    expect(store.itemNameSources()).toEqual([{ source: 'blizzard', count: 2 }]);
    expect(api.counts.token).toBe(1);

    // a second refresh reuses the token and asks the cache, not the API
    await refreshItemNames(store, [3581, 250531], { blizzard: api.cfg });
    expect(api.counts.token).toBe(1);
    expect(api.counts.item).toBe(2);
  });

  it('records an upstream 404 as unknown so it is not asked again', async () => {
    newStore();
    const api = await mockBlizzard({ items: { 3581: 'Known' } });
    const first = await refreshItemNames(store, [3581, 999999], { blizzard: api.cfg });
    expect(first.added).toBe(1);
    expect(first.unknown).toBe(1);
    expect(first.missing).toBe(0);

    const itemsBefore = api.counts.item;
    const second = await refreshItemNames(store, [3581, 999999], { blizzard: api.cfg });
    expect(second.added).toBe(0);
    expect(second.missing).toBe(0);
    expect(api.counts.item).toBe(itemsBefore);
  });

  it('reports bad credentials instead of pretending every item is unknown', async () => {
    newStore();
    const api = await mockBlizzard({ tokenStatus: 401, items: {} });
    const out = await refreshItemNames(store, [3581], { blizzard: api.cfg });
    expect(out.unauthorized).toBe(true);
    expect(out.errors[0]).toMatch(/auth/i);
    expect(out.unknown).toBe(0);
    expect(api.counts.item).toBe(0);
    expect(lastItemNameError()).toMatch(/auth/i);
  });

  it('treats a 401 on the item endpoint as unauthorized, not as a missing item', async () => {
    newStore();
    const api = await mockBlizzard({ items: {}, itemStatus: { 3581: 401 } });
    const out = await refreshItemNames(store, [3581], { blizzard: api.cfg });
    expect(out.unauthorized).toBe(true);
    expect(out.unknown).toBe(0);
    // nothing recorded as nonexistent: the item may be perfectly valid
    expect(store.itemNameMisses([3581], 60_000).size).toBe(0);
  });

  it('stops on rate limiting without recording a miss', async () => {
    newStore();
    const api = await mockBlizzard({ items: {}, itemStatus: { 3581: 429 } });
    const out = await refreshItemNames(store, [3581], { blizzard: api.cfg });
    expect(out.errors[0]).toMatch(/429/);
    expect(out.unknown).toBe(0);
    expect(store.itemNameMisses([3581], 60_000).size).toBe(0);
  });

  it('prefers a name it already has over a second source', async () => {
    newStore();
    store.saveItemNames([{ id: 3581, name: 'From File', source: 'file' }]);
    const api = await mockBlizzard({ items: { 3581: 'From Blizzard' } });
    await refreshItemNames(store, [3581], { blizzard: api.cfg });
    expect(store.itemNames([3581]).get(3581)).toBe('From File');
    expect(api.counts.item).toBe(0);
  });
});
