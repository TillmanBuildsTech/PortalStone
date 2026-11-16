import { describe, expect, it } from 'vitest';
import { parseSavedVariables } from '../src/savedvars/lua';
import {
  canonicalPath,
  collectEntries,
  collectValues,
  entityOptions,
  hasEntity,
  pinEntity,
  flatten,
  formatPath,
  introspect,
  numericCandidates,
  resolvePath,
  textCandidates,
} from '../src/savedvars/shape';

function shapeOf(src: string, name = 'X') {
  const { globals } = parseSavedVariables(src);
  const global = globals.find((g) => g.name === name)!;
  return { value: global.value, shape: introspect(global.value, { rootName: name }) };
}

const CHARACTERS = `BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = {
["money"] = 152079,
["class"] = "PALADIN",
["bags"] = {
{ ["items"] = { "1179;7", "1708;13" }, ["size"] = 12 },
{ ["items"] = { "954" }, ["size"] = 8 },
},
},
["Slouch Mage"] = {
["money"] = 370,
["class"] = "MAGE",
["bags"] = {
{ ["items"] = { "2589;11" }, ["size"] = 20 },
},
},
},
}
`;

describe('savedvars introspection', () => {
  it('records types, instance counts and numeric range per path', () => {
    const { shape } = shapeOf(CHARACTERS, 'BrotherBags');
    const nodes = flatten(shape.root);
    const money = nodes.find((n) => n.path.includes('Dead Sadfatkid') && n.segment === 'money')!;
    expect(money.type).toBe('number');
    expect(money.instances).toBe(1);
    expect(money.numeric).toMatchObject({ count: 1, max: 152079 });
    expect(money.samples).toEqual(['152079']);
    const klass = nodes.find((n) => n.segment === 'class')!;
    expect(klass.type).toBe('string');
  });

  it('collapses a repeated array into one [*] path instead of thousands of rows', () => {
    const big = Array.from({ length: 500 }, (_, i) => `{ q = ${i}, name = "q${i}" },`).join('');
    const { shape } = shapeOf(`DB = { quests = { ${big} } }`, 'DB');
    const nodes = flatten(shape.root);
    const questNodes = nodes.filter((n) => n.segment === 'q');
    expect(questNodes).toHaveLength(1);
    expect(questNodes[0]!.instances).toBe(500);
    expect(questNodes[0]!.path).toEqual(['DB', 'quests', '*', 'q']);
    expect(questNodes[0]!.numeric!.min).toBe(0);
    expect(questNodes[0]!.numeric!.max).toBe(499);
  });

  it('keeps a handful of named entries as named paths', () => {
    const { shape } = shapeOf(CHARACTERS, 'BrotherBags');
    const names = flatten(shape.root).filter((n) => n.path.length === 3).map((n) => n.segment);
    expect(names).toContain('Dead Sadfatkid');
    expect(names).toContain('Slouch Mage');
  });

  it('folds the same property across characters into one candidate', () => {
    const { shape } = shapeOf(CHARACTERS, 'BrotherBags');
    const money = numericCandidates(shape.root).filter((c) => c.label === 'money');
    expect(money).toHaveLength(1);
    expect(formatPath(money[0]!.path)).toBe('BrotherBags.forever[*].money');
    expect(money[0]!.instances).toBe(2);
    expect(money[0]!.perEntity).toBe(true);
    expect(money[0]!.numeric.max).toBe(152079);
  });

  it('ranks a varying per-character number above a constant', () => {
    const { shape } = shapeOf(`X = { a = { v = 1, money = 5 }, b = { v = 1, money = 9 } }`, 'X');
    const ranked = numericCandidates(shape.root);
    expect(ranked[0]!.label).toBe('money');
    const constant = ranked.find((c) => c.label === 'v')!;
    expect(constant.constant).toBe(true);
    expect(ranked.indexOf(constant)).toBeGreaterThan(0);
  });

  it('drops all-zero config values and explains constants', () => {
    const { shape } = shapeOf(`X = { disabled = 0, off = 0, real = 7 }`, 'X');
    const labels = numericCandidates(shape.root).map((c) => c.label);
    expect(labels).toEqual(['real']);
  });

  it('offers text leaves as dimensions', () => {
    const { shape } = shapeOf(CHARACTERS, 'BrotherBags');
    const klass = textCandidates(shape.root).find((n) => n.segment === 'class')!;
    expect(klass.samples).toEqual(expect.arrayContaining(['PALADIN', 'MAGE']));
    expect(klass.instances).toBe(2);
  });

  it('resolves a UI path back to real values, through collections', () => {
    const { value } = shapeOf(CHARACTERS, 'BrotherBags');
    expect(resolvePath(value, ['forever', 'Dead Sadfatkid', 'money'])).toBe(152079);
    const viaStar = resolvePath(value, ['forever', '*', 'money']) as number;
    expect(typeof viaStar).toBe('number');
    expect(resolvePath(value, ['forever', 'nobody', 'money'])).toBeUndefined();
  });

  it('collects every instance behind a [*] path, so a metric can be summed', () => {
    const { value } = shapeOf(CHARACTERS, 'BrotherBags');
    expect(collectValues(value, ['forever', '*', 'money'])).toEqual([152079, 370]);
    expect(collectValues(value, ['forever', 'Slouch Mage', 'money'])).toEqual([370]);
    expect(collectValues(value, ['forever', '*', 'nope'])).toEqual([]);
  });

  it('collects entries with their keys, which is what equipment tracking needs', () => {
    const { value } = shapeOf(
      `X = { char = { equip = { "1001", nil, "1003", "1004" } } }`,
      'X',
    );
    const slot4 = collectEntries(value, ['char', 'equip', '*']);
    const original = slot4.find((e) => e.value === '1004')!;
    expect(original.key).toBe('4');
    expect(collectEntries(value, ['char', 'equip', '3']).map((e) => e.value)).toEqual(['1003']);
  });

  it('marks entity instances so paths can be folded, but keeps containers named', () => {
    const { shape } = shapeOf(CHARACTERS, 'BrotherBags');
    const keys = new Set(flatten(shape.root).filter((n) => n.segment === 'Dead Sadfatkid').map((n) => n.path.join('\u0001')));
    expect(canonicalPath(['BrotherBags', 'forever', 'Dead Sadfatkid', 'money'], keys)).toEqual([
      'BrotherBags',
      'forever',
      '*',
      'money',
    ]);
    expect(canonicalPath(['BrotherBags', 'forever'], keys)).toEqual(['BrotherBags', 'forever']);
  });

  it('renders paths the way a user would type them', () => {
    expect(formatPath(['A', 'b c', '3', '*', 'money'])).toBe('A["b c"][3][*].money');
  });

  it('reports truncation instead of descending forever', () => {
    let src = 'X = {';
    for (let i = 0; i < 40; i++) src += ` a${i} = {`;
    src += ' v = 1 ';
    for (let i = 0; i < 40; i++) src += '} ';
    src += '}';
    const { shape } = shapeOf(src, 'X');
    expect(shape.truncated).toBe(true);
    expect(flatten(shape.root).length).toBeGreaterThan(0);
  });

  it('handles a global that is a bare scalar', () => {
    const { shape } = shapeOf('X = 42', 'X');
    const nodes = flatten(shape.root);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.numeric!.max).toBe(42);
  });
});


describe('entity options', () => {
  const value = parseSavedVariables(
    `BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = { ["level"] = 32, ["money"] = 167998 },
["Slouch Mage"] = { ["level"] = 10, ["money"] = 5122 },
},
}
`,
  ).globals[0]!.value;

  it('names the keys a wildcard stands for', () => {
    expect(entityOptions(value, ['forever', '*', 'level']).sort()).toEqual(['Dead Sadfatkid', 'Slouch Mage']);
  });

  it('pins the first wildcard and leaves the rest of the path alone', () => {
    expect(pinEntity(['forever', '*', 'equip', '*'], 'Slouch Mage')).toEqual([
      'forever',
      'Slouch Mage',
      'equip',
      '*',
    ]);
    // a literal path has nothing to pin
    expect(pinEntity(['forever', 'Slouch Mage', 'level'], 'Dead Sadfatkid')).toEqual([
      'forever',
      'Slouch Mage',
      'level',
    ]);
  });

  it('reports whether an entity is really there', () => {
    expect(hasEntity(value, ['forever', '*', 'level'], 'Slouch Mage')).toBe(true);
    expect(hasEntity(value, ['forever', '*', 'level'], 'Nobody')).toBe(false);
    // and the pinned path resolves to that entity's own value, not to a sum
    expect(collectValues(value, pinEntity(['forever', '*', 'level'], 'Slouch Mage'))).toEqual([10]);
  });
});
