import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';
import { renderSession } from '../src/ui/pages/session';
import type { Ctx } from '../src/ui/context';
import type { BagSnapshot, AbilityStat, CastStat } from '../../core/src/combatlog/aggregate';
import type { SessionSnapshot } from '../../core/src/combatlog/ingest';
import { sessionSpecLine, specForSession, specTitle } from '../src/ui/specInfo';

const DIR = mkdtempSync(join(tmpdir(), 'portalstone-specinfo-'));
const open: Store[] = [];

function store(): Store {
  const s = new Store(join(DIR, `db-${Math.random().toString(36).slice(2)}.sqlite`));
  open.push(s);
  return s;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function ability(id: number, name: string, amount: number, hits: number): AbilityStat {
  return { id, name, amount, hits, crits: 0 };
}
function cast(id: number, name: string, casts: number): CastStat {
  return { id, name, casts };
}

/** The Holy rotation: baseline abilities only, nothing talent-locked. */
const HOLY: BagSnapshot = {
  damageDone: 15_000,
  damageTaken: 4_000,
  healingDone: 29_000,
  overheal: 2_000,
  hits: 120,
  crits: 4,
  casts: 160,
  interrupts: 0,
  kills: 3,
  fieldKills: 8,
  deaths: 0,
  myDeaths: 0,
  playersDied: 0,
  durationS: 900,
  engagedS: 700,
  dps: 21,
  dpsEngaged: 21,
  hps: 41,
  topAbilities: [ability(1, 'Melee', 9_000, 60), ability(2, 'Holy Strike', 6_000, 60)],
  topHealing: [ability(3, 'Holy Light', 22_000, 40), ability(4, 'Flash of Light', 7_000, 60)],
  topDamageTaken: [],
  topCasts: [cast(3, 'Holy Light', 40), cast(4, 'Flash of Light', 60), cast(5, 'Consecration', 20)],
  misses: [],
  castFailures: [],
  topKills: [],
  pvpKills: [],
  pvpDeaths: [],
};

/** The same character after the respec: Seal of Command is talent-locked to Retribution. */
const RET: BagSnapshot = {
  ...HOLY,
  damageDone: 51_000,
  healingDone: 42_000,
  topAbilities: [ability(6, 'Melee', 32_000, 180), ability(7, 'Seal of Command', 11_500, 59)],
  topCasts: [cast(8, 'Seal of Command', 146), cast(9, 'Judgement', 73)],
};

function sessionWith(zones: { name: string; kind: string; bag: BagSnapshot; start: number; end: number }[]): SessionSnapshot {
  const first = zones[0]!;
  const last = zones[zones.length - 1]!;
  return {
    startMs: first.start,
    endMs: last.end,
    startByte: 0,
    offsetMin: -420,
    zoneId: 1,
    zoneName: first.name,
    zones: zones.map((z) => ({ zoneId: 1, name: z.name, kind: z.kind, startMs: z.start, endMs: z.end, ...z.bag })),
    open: last.bag,
    encounters: [],
  };
}

function ctxFor(s: Store): Ctx {
  return { store: s, installs: [], lastScan: { at: 0, entries: 0, errors: 0 }, dbPath: ':memory:', character: null, charQuery: '' };
}

const T0 = Date.UTC(2026, 10, 15, 19, 25);

describe('spec on a session page', () => {
  it('dates the switch instead of averaging the session into "mixed"', () => {
    const s = store();
    s.replaceSessionsFrom('a.txt', 0, [
      sessionWith([
        { name: 'Dalaran', kind: 'city', bag: HOLY, start: T0, end: T0 + 900_000 },
        { name: 'Scarlet Monastery', kind: 'dungeon', bag: RET, start: T0 + 900_000, end: T0 + 2_700_000 },
      ]),
    ]);
    const id = s.listSessions(10)[0]!.id;
    const html = renderSession(ctxFor(s), id)!;

    expect(html).toContain('retribution from');
    expect(html).toContain('no marker in the 1 run before it');
    expect(html).toContain('class="pill spec"');
    expect(html).toContain('inferred from Seal of Command');
    // The Holy run keeps no chip: nothing talent-locked appeared in it.
    expect(html.match(/class="pill spec"/g)).toHaveLength(1);
  });

  it('says "all session" only when every run carries evidence', () => {
    const s = store();
    s.replaceSessionsFrom('b.txt', 0, [
      sessionWith([
        { name: 'Scarlet Monastery', kind: 'dungeon', bag: RET, start: T0, end: T0 + 900_000 },
        { name: 'Undercity', kind: 'city', bag: RET, start: T0 + 900_000, end: T0 + 1_800_000 },
      ]),
    ]);
    const id = s.listSessions(10)[0]!.id;
    const html = renderSession(ctxFor(s), id)!;
    expect(html).toContain('retribution all session');
  });

  it('says nothing at all when no run holds a talent-locked ability', () => {
    const s = store();
    s.replaceSessionsFrom('c.txt', 0, [
      sessionWith([{ name: 'Scarlet Monastery', kind: 'dungeon', bag: HOLY, start: T0, end: T0 + 1_800_000 }]),
    ]);
    const id = s.listSessions(10)[0]!.id;
    const html = renderSession(ctxFor(s), id)!;
    expect(html).not.toContain('class="pill spec"');
    expect(html).not.toContain('inferred from');
  });
});

describe('sessionSpecLine', () => {
  it('quotes the evidence and the build the session ended on', () => {
    const s = store();
    s.replaceSessionsFrom('d.txt', 0, [
      sessionWith([
        { name: 'Dalaran', kind: 'city', bag: HOLY, start: T0, end: T0 + 900_000 },
        { name: 'Scarlet Monastery', kind: 'dungeon', bag: RET, start: T0 + 900_000, end: T0 + 2_700_000 },
      ]),
    ]);
    const session = s.listSessions(10)[0]!;
    const spec = specForSession(s, s.segments(session.id));
    const line = sessionSpecLine(spec, session.offset_min)!;
    expect(line).toContain('retribution from');
    expect(line).toContain('no marker in the 1 run before it');
    expect(line).toContain('Seal of Command ×146 casts');
    expect(spec.bySegment.size).toBe(2);
  });

  it('describes the evidence rather than the whole session when nothing was named', () => {
    const guess = { className: 'PALADIN', spec: 'Retribution', role: 'damage' as const, confidence: 0.9, evidence: [], alternates: [] };
    const line = sessionSpecLine(
      {
        timeline: { phases: [{ spec: 'Retribution', className: 'PALADIN', role: 'damage', fromMs: T0, toMs: T0 + 1, runs: 1, confidence: 0.9 }], unstatedRuns: 0, unstatedFirst: 0, switched: false },
        bySegment: new Map(),
        evidence: null,
      },
      0,
    );
    expect(line).toBe('retribution all session');
    expect(specTitle(guess)).toContain('no ability recorded');
  });
});
