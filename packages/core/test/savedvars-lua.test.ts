import { describe, expect, it } from 'vitest';
import { isTable, parseSavedVariables, type LuaTable } from '../src/savedvars/lua';

/** Read a path out of a parsed global, for assertions that do not care about node shape. */
function at(globals: ReturnType<typeof parseSavedVariables>['globals'], name: string, ...path: (string | number)[]) {
  const global = globals.find((g) => g.name === name);
  if (!global) throw new Error(`no global ${name}`);
  let cur = global.value;
  for (const seg of path) {
    if (!isTable(cur)) throw new Error(`${name}.${path.join('.')} is not a table`);
    const hit = (cur as LuaTable).entries.find(([k]) => k === seg);
    if (!hit) throw new Error(`${name}.${path.join('.')} missing at ${String(seg)}`);
    cur = hit[1];
  }
  return cur;
}

describe('savedvars reader', () => {
  it('reads the shape every addon actually writes', () => {
    const { globals, warnings } = parseSavedVariables(`\r
BrotherBags = {
["forever"] = {
["Dead Sadfatkid"] = {
["money"] = 152079,
["class"] = "PALADIN",
["bags"] = {
{ ["items"] = { "1179;7", "1708;13" }, ["size"] = 12 },
{ ["size"] = 8 },
},
["seen"] = true,
},
},
["rogue"] = {
["level"] = 29.5,
["notes"] = "he said \\"hi\\"",
},
}
`);
    expect(warnings).toEqual([]);
    expect(at(globals, 'BrotherBags', 'forever', 'Dead Sadfatkid', 'money')).toBe(152079);
    expect(at(globals, 'BrotherBags', 'forever', 'Dead Sadfatkid', 'class')).toBe('PALADIN');
    expect(at(globals, 'BrotherBags', 'forever', 'Dead Sadfatkid', 'bags', 2, 'size')).toBe(8);
    expect(at(globals, 'BrotherBags', 'rogue', 'level')).toBe(29.5);
    expect(at(globals, 'BrotherBags', 'rogue', 'notes')).toBe('he said "hi"');
  });

  it('keeps numeric and string keys apart, including 0', () => {
    const { globals } = parseSavedVariables(`X = { [0] = "zero", [1] = "one", ["1"] = "string one" }`);
    expect(at(globals, 'X', 0)).toBe('zero');
    expect(at(globals, 'X', 1)).toBe('one');
    expect(at(globals, 'X', '1')).toBe('string one');
  });

  it('records nil holes without shifting later array entries', () => {
    const { globals } = parseSavedVariables(`X = { "a", nil, "c", [9] = "nine", nil }`);
    expect(at(globals, 'X', 1)).toBe('a');
    expect(at(globals, 'X', 3)).toBe('c');
    expect(at(globals, 'X', 9)).toBe('nine');
    const table = at(globals, 'X') as LuaTable;
    expect(table.entries.map(([k]) => k)).toEqual([1, 3, 9]);
  });

  it('skips comments and reads long strings', () => {
    const { globals, warnings } = parseSavedVariables(`
-- a line comment with a { brace
--[[ a block comment with = signs and { braces }
still a comment ]]
X = {
-- inline
name = [==[multi
line]==],
}
`);
    expect(warnings).toEqual([]);
    expect(at(globals, 'X', 'name')).toBe('multi\nline');
  });

  it('decodes escapes the way Lua does', () => {
    const { globals } = parseSavedVariables(`X = "tab\\there\\nnewline \\65 \\x42 \\z   joined"`);
    expect(at(globals, 'X')).toBe('tab\there\nnewline A B joined');
  });

  it('reads numbers including hex, negatives and exponents', () => {
    const { globals } = parseSavedVariables(`X = { a = -12, b = 1.5, c = -0.25, d = 1e3, e = 0x1F }`);
    expect(at(globals, 'X', 'a')).toBe(-12);
    expect(at(globals, 'X', 'b')).toBe(1.5);
    expect(at(globals, 'X', 'c')).toBe(-0.25);
    expect(at(globals, 'X', 'd')).toBe(1000);
    expect(at(globals, 'X', 'e')).toBe(31);
  });

  it('treats an expression value as nil and says so, rather than inventing a value', () => {
    const { globals, warnings } = parseSavedVariables(`X = {
stamp = GetTime(),
name = "kept",
}`);
    expect(warnings.some((w) => w.includes('GetTime'))).toBe(true);
    expect(at(globals, 'X', 'name')).toBe('kept');
    const table = at(globals, 'X') as LuaTable;
    expect(table.entries.map(([k]) => k)).toEqual(['name']);
  });

  it('recovers after a broken global instead of losing the file', () => {
    const { globals, warnings } = parseSavedVariables(`Broken = { a = , b = 1 }
Good = { ok = 42 }
`);
    expect(warnings.length).toBeGreaterThan(0);
    expect(at(globals, 'Good', 'ok')).toBe(42);
  });

  it('never throws on a truncated file', () => {
    const { warnings } = parseSavedVariables(`X = { a = { b = 1, c = "unterminated`);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('handles an empty file and a BOM without complaint', () => {
    expect(parseSavedVariables('').globals).toEqual([]);
    const { globals } = parseSavedVariables('\uFEFFX = { a = 1 }');
    expect(at(globals, 'X', 'a')).toBe(1);
  });

  it('reads several globals from one file', () => {
    const { globals } = parseSavedVariables('A = { x = 1 }\nB = { y = 2 }\nC = 3');
    expect(globals.map((g) => g.name)).toEqual(['A', 'B', 'C']);
    expect(globals.find((g) => g.name === 'C')!.value).toBe(3);
  });
});
