/**
 * SavedVariables introspection: what properties does this addon actually expose?
 *
 * The point is to answer "what could I track?" without writing an adapter per addon. A file is
 * walked once into a shape tree — every distinct path, its type, how many values landed on it, the
 * numeric range, and sample values. Repeated siblings collapse: 4,000 quest ids become one `[*]`
 * path with 4,000 instances, so the result is a page, not a dump.
 *
 * Values are aggregated, never guessed: a node says how many instances were seen and the min/max
 * of what was actually there. Nothing here is addon-specific — that is what makes it a base.
 */
import { isTable, type LuaKey, type LuaTable, type LuaValue } from './lua';

export type ShapeType = 'number' | 'string' | 'boolean' | 'table' | 'mixed';

export interface NumericStats {
  count: number;
  min: number;
  max: number;
  sum: number;
}

export interface ShapeNode {
  /** this level's key: a name, an index, or '*' for a collapsed collection */
  segment: string;
  /** full path from the global's root, inclusive */
  path: string[];
  type: ShapeType;
  /** how many values were seen at this path */
  instances: number;
  /** for a table: entries at this node (max across instances) */
  entries?: number;
  /** up to 3 distinct scalar samples, for the "is this the thing I mean" check */
  samples: string[];
  numeric?: NumericStats;
  children?: ShapeNode[];
  /** collapsed collection: how many elements it had, and a few real keys for context */
  collectionOf?: number;
  sampleKeys?: string[];
}

export interface IntrospectOptions {
  /** name of the SavedVariables global, so paths read `Attune_DB.char...` and not just `char...` */
  rootName?: string;
  /** stop descending past this depth (a shape map, not an infinite tree) */
  maxDepth?: number;
  /** at most this many distinct paths; the rest are counted as truncated */
  maxNodes?: number;
  /** integer-keyed tables at or above this size collapse to `[*]` */
  collapseAt?: number;
  /** string-keyed tables at or above this size collapse too: the names are data, not structure */
  collapseNamedAt?: number;
  sampleScalars?: number;
}

const DEFAULTS = {
  maxDepth: 8,
  maxNodes: 4000,
  collapseAt: 8,
  collapseNamedAt: 64,
  sampleScalars: 3,
};

export interface Introspection {
  /** synthetic root: its children are the top-level keys */
  root: ShapeNode;
  nodes: number;
  truncated: boolean;
}

/** Walk one global's value into a shape tree. */
export function introspect(value: LuaValue, opts: IntrospectOptions = {}): Introspection {
  const o = { ...DEFAULTS, ...opts };
  const rootName = opts.rootName ?? '';
  const root: ShapeNode = {
    segment: rootName,
    path: rootName ? [rootName] : [],
    type: 'table',
    instances: 1,
    entries: 0,
    samples: [],
    children: [],
  };
  let nodes = 0;
  let truncated = false;

  const walk = (v: LuaValue, parent: ShapeNode, segment: string, depth: number): void => {
    if (nodes >= o.maxNodes) {
      truncated = true;
      return;
    }
    const { node, created } = childFor(parent, segment);
    if (created) nodes++;
    node.instances++;

    if (!isTable(v)) {
      node.type = mergeType(node.type, typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
      if (typeof v === 'number') {
        node.numeric = node.numeric
          ? {
              count: node.numeric.count + 1,
              min: Math.min(node.numeric.min, v),
              max: Math.max(node.numeric.max, v),
              sum: node.numeric.sum + v,
            }
          : { count: 1, min: v, max: v, sum: v };
      }
      if (node.samples.length < o.sampleScalars) {
        const s = previewScalar(v);
        if (!node.samples.includes(s)) node.samples.push(s);
      }
      return;
    }

    node.type = mergeType(node.type, 'table');
    node.entries = Math.max(node.entries ?? 0, v.entries.length);
    if (depth >= o.maxDepth) {
      truncated = true;
      return;
    }

    const collection = classify(v, o);
    if (collection) {
      node.collectionOf = Math.max(node.collectionOf ?? 0, v.entries.length);
      node.sampleKeys ??= v.entries.slice(0, 6).map(([k]) => String(k));
      for (const [, child] of v.entries) walk(child, node, '*', depth + 1);
      return;
    }

    for (const [key, child] of v.entries) walk(child, node, String(key), depth + 1);
  };

  for (const [key, child] of (isTable(value) ? value : syntheticTable(value)).entries) {
    walk(child, root, String(key), 1);
  }
  root.entries = root.children?.length ?? 0;
  return { root, nodes, truncated };
}

function syntheticTable(v: LuaValue): LuaTable {
  return { t: 'table', entries: [['value', v]] };
}

function childFor(parent: ShapeNode, segment: string): { node: ShapeNode; created: boolean } {
  const existing = parent.children?.find((c) => c.segment === segment);
  if (existing) return { node: existing, created: false };
  const node: ShapeNode = {
    segment,
    path: [...parent.path, segment],
    // '' until a value is folded in, so the first scalar decides the type rather than 'table'.
    type: '' as ShapeType,
    instances: 0,
    samples: [],
  };
  parent.children ??= [];
  parent.children.push(node);
  return { node, created: true };
}

function mergeType(current: ShapeType, next: ShapeType): ShapeType {
  if (!current) return next;
  return current === next ? current : 'mixed';
}

/**
 * Is this table a collection of like things (collapse it) or a set of distinct named things
 * (list them)? Character names are named things; 4,000 quest ids are a collection.
 */
function classify(v: LuaTable, o: Pick<Required<IntrospectOptions>, 'collapseAt' | 'collapseNamedAt'>): boolean {
  if (v.entries.length < o.collapseAt) return false;
  let numericKeys = 0;
  for (const [k] of v.entries) if (typeof k === 'number') numericKeys++;
  if (numericKeys === v.entries.length) return true;
  return v.entries.length >= o.collapseNamedAt;
}

/** All distinct paths, depth-first, for search and for "what numbers are in here". */
export function flatten(root: ShapeNode): ShapeNode[] {
  const out: ShapeNode[] = [];
  const stack = [...(root.children ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    if (node.children?.length) stack.push(...[...node.children].reverse());
  }
  return out;
}

export function pathKey(segments: string[]): string {
  return segments.join('\u0001');
}

export function indexTree(root: ShapeNode): Map<string, ShapeNode> {
  const map = new Map<string, ShapeNode>();
  for (const node of flatten(root)) map.set(pathKey(node.path), node);
  return map;
}

/** Resolve a UI path against the real value, so a page can show entries, not just shapes. */
export function resolvePath(value: LuaValue, segments: string[]): LuaValue | undefined {
  let cur: LuaValue | undefined = value;
  for (const seg of segments) {
    if (!isTable(cur)) return undefined;
    const hit: [LuaKey, LuaValue] | undefined =
      cur.entries.find(([k]) => String(k) === seg) ?? (seg === '*' ? cur.entries[0] : undefined);
    if (!hit) return undefined;
    cur = hit[1];
  }
  return cur;
}

/**
 * The real keys behind the *first* wildcard in a path.
 *
 * A folded path says `forever[*].money`: one wallet per character. Tracking that sums two people's
 * money into a number neither of them has. This returns the names the wildcard stands for
 * (`forever["Slouch Mage"].money`), so a metric can be pinned to one entity instead of all of them.
 *
 * Only the first wildcard is expanded, on purpose. In every addon shape seen so far the first one
 * is the character and later ones are rows inside that character's data (bank slots, quest ids),
 * where a key from this level would point at nothing.
 */
export function entityOptions(value: LuaValue, segments: string[]): string[] {
  let cur: LuaValue | undefined = value;
  for (const seg of segments) {
    if (!isTable(cur)) return [];
    if (seg === '*') return cur.entries.map(([k]) => String(k));
    const hit: [LuaKey, LuaValue] | undefined = cur.entries.find(([k]) => String(k) === seg);
    if (!hit) return [];
    cur = hit[1];
  }
  return [];
}

/** The same path with the first wildcard replaced by a concrete key, or the path unchanged. */
export function pinEntity(segments: string[], entity: string): string[] {
  const at = segments.indexOf('*');
  if (at < 0) return segments;
  return segments.map((s, i) => (i === at ? entity : s));
}

/** Does this path, pinned to `entity`, still resolve in the given value? */
export function hasEntity(value: LuaValue, segments: string[], entity: string): boolean {
  return entityOptions(value, segments).includes(entity);
}

/**
 * Every value a path reaches, keeping the key that produced it.
 *
 * Tracking a number needs values; tracking equipment needs *slots*, so a change reads
 * "slot 4: 6713 → 6511" rather than "one of 16 strings changed". The key is the last table key on
 * the path — an inventory slot index for `equip[*]`, a name for a named map.
 */
export interface CollectedEntry {
  key: string;
  value: LuaValue;
}

export function collectEntries(value: LuaValue, segments: string[]): CollectedEntry[] {
  const walk = (v: LuaValue, rest: string[], key: string): CollectedEntry[] => {
    if (rest.length === 0) return [{ key, value: v }];
    if (!isTable(v)) return [];
    const [seg, ...tail] = rest;
    const picked: [LuaKey, LuaValue][] =
      seg === '*' ? [...v.entries] : v.entries.filter(([k]) => String(k) === seg);
    return picked.flatMap(([k, child]) => walk(child, tail, String(k)));
  };
  return walk(value, segments, '');
}

/** Every value a path reaches, not just the first.
 *
 * `BrotherBags.forever[*].money` is one value per character; tracking gold means summing or
 * comparing all of them, not peeking at whichever character happens to be first. `[*]` expands to
 * every entry of that table, a literal segment picks the one key.
 */
export function collectValues(value: LuaValue, segments: string[]): LuaValue[] {
  if (segments.length === 0) return [value];
  if (!isTable(value)) return [];
  const [seg, ...rest] = segments;
  const picked =
    seg === '*'
      ? value.entries.map(([, v]) => v)
      : value.entries.filter(([k]) => String(k) === seg).map(([, v]) => v);
  return picked.flatMap((v) => collectValues(v, rest));
}

/**
 * Which nodes are instances of an entity collection?
 *
 * `BrotherBags.forever["Dead Sadfatkid"]` and `...["Slouch Mage"]` are the same kind of thing twice:
 * siblings whose children overlap heavily. Array tables are already collapsed during the walk; this
 * catches the named case (characters, profiles, per-boss records) without inventing structure —
 * candidates are folded onto a `[*]` path afterwards, the tree itself stays untouched.
 *
 * Overlap threshold is high on purpose: two config tables that happen to share `enabled` must not
 * be treated as one property.
 */
function entityInstanceKeys(root: ShapeNode): Set<string> {
  const keys = new Set<string>();
  const visit = (node: ShapeNode, isRoot: boolean): void => {
    // The global's own children are named containers (`toons`, `forever`), not instances of one
    // another: keep those names, and look for entity groups one level down.
    const tables = isRoot ? [] : (node.children ?? []).filter((c) => (c.children?.length ?? 0) > 0);
    const used = new Set<string>();
    for (const a of tables) {
      if (used.has(a.segment)) continue;
      const namesA = new Set((a.children ?? []).map((c) => c.segment));
      const group = [a];
      for (const b of tables) {
        if (b === a || used.has(b.segment)) continue;
        const namesB = new Set((b.children ?? []).map((c) => c.segment));
        if (overlapShare(namesA, namesB) >= 0.7) {
          group.push(b);
          used.add(b.segment);
        }
      }
      if (group.length >= 2) {
        used.add(a.segment);
        for (const g of group) keys.add(pathKey(g.path));
      }
    }
    for (const c of node.children ?? []) visit(c, false);
  };
  visit(root, true);
  return keys;
}

function overlapShare(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const k of b) if (a.has(k)) hits++;
  return hits / Math.min(a.size, b.size);
}

/** Replace entity-instance segments with `*`, so every character's money lands on one path. */
export function canonicalPath(path: string[], entityKeys: Set<string>): string[] {
  return path.map((seg, i) => (seg === '*' || entityKeys.has(pathKey(path.slice(0, i + 1))) ? '*' : seg));
}

export interface MetricCandidate {
  /** canonical path: `[*]` where any instance of a collection appears */
  path: string[];
  label: string;
  type: 'number';
  /** how many values landed here (characters × whatever) */
  instances: number;
  numeric: NumericStats;
  samples: string[];
  /** the path crosses a collection: one value per entity */
  perEntity: boolean;
  /** min === max: a flag or config value that never moved in this file */
  constant: boolean;
  depth: number;
  /** higher is a better metric candidate; see score() */
  score: number;
}

/**
 * The numbers worth putting on a dashboard.
 *
 * This is discovery, not semantics: the score only encodes what makes a number *trackable* —
 * it varies, it is per-entity, it appears often, it is shallow, and it is not a 0..1 fraction
 * (colours and alphas) or a one-letter field (r/g/b). A user still decides what a value means.
 */
export function numericCandidates(root: ShapeNode, limit = 80): MetricCandidate[] {
  const entityKeys = entityInstanceKeys(root);
  const byPath = new Map<string, MetricCandidate>();
  for (const node of flatten(root)) {
    if (node.type !== 'number' || !node.numeric) continue;
    if (node.numeric.count === 0) continue;
    if (node.numeric.min === 0 && node.numeric.max === 0) continue;
    const path = canonicalPath(node.path, entityKeys);
    const key = pathKey(path);
    const prev = byPath.get(key);
    if (prev) {
      prev.instances += node.numeric.count;
      prev.numeric = {
        count: prev.numeric.count + node.numeric.count,
        min: Math.min(prev.numeric.min, node.numeric.min),
        max: Math.max(prev.numeric.max, node.numeric.max),
        sum: prev.numeric.sum + node.numeric.sum,
      };
      prev.samples = [...new Set([...prev.samples, ...node.samples])].slice(0, 3);
      continue;
    }
    byPath.set(key, {
      path,
      label: node.segment,
      type: 'number',
      instances: node.numeric.count,
      numeric: { ...node.numeric },
      samples: [...node.samples],
      perEntity: path.includes('*'),
      constant: node.numeric.min === node.numeric.max,
      depth: path.length,
      score: 0,
    });
  }
  const out = [...byPath.values()];
  for (const c of out) {
    // Folding two per-character values can turn a constant into a varying one (and back).
    c.constant = c.numeric.min === c.numeric.max;
    c.score = scoreCandidate(c);
  }
  out.sort((a, b) => b.score - a.score || b.instances - a.instances);
  return out.slice(0, limit);
}

function scoreCandidate(c: MetricCandidate): number {
  let score = 0;
  if (!c.constant) score += 3;
  if (c.perEntity) score += 2;
  score += (Math.min(c.instances, 100) / 100) * 0.6;
  score -= c.depth * 0.2;
  // Colours, alphas, percentages: a 0..1 range is almost never a trackable quantity.
  if (c.numeric.min >= 0 && c.numeric.max <= 1) score -= 1.5;
  if (c.label.length <= 2) score -= 1;
  if (Math.abs(c.numeric.max) >= 1000) score += 0.3;
  return score;
}

/** Text leaves: identifiers and names, useful as dimensions rather than metrics. */
export function textCandidates(root: ShapeNode, limit = 40): ShapeNode[] {
  const entityKeys = entityInstanceKeys(root);
  const byPath = new Map<string, ShapeNode>();
  for (const node of flatten(root)) {
    if (node.type !== 'string' || node.samples.length === 0) continue;
    const path = canonicalPath(node.path, entityKeys);
    const key = pathKey(path);
    const prev = byPath.get(key);
    if (prev) {
      prev.instances += node.instances;
      prev.samples = [...new Set([...prev.samples, ...node.samples])].slice(0, 3);
      continue;
    }
    byPath.set(key, { ...node, path, samples: [...node.samples] });
  }
  return [...byPath.values()].sort((a, b) => b.instances - a.instances).slice(0, limit);
}

/** `forever["Dead Sadfatkid"].money` — readable, copy-pasteable, unambiguous. */
export function formatPath(segments: string[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg === '*') out += '[*]';
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else if (/^\d+$/.test(seg)) out += `[${seg}]`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out || '(root)';
}

export function previewScalar(v: string | number | boolean): string {
  if (typeof v === 'string') return v.length > 48 ? `${v.slice(0, 47)}…` : v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return v ? 'true' : 'false';
}

/** Human label for one table entry, e.g. `[3]` or `money`. */
export function segmentLabel(segment: string): string {
  return /^\d+$/.test(segment) ? `[${segment}]` : segment;
}
