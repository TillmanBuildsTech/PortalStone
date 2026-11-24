import { describe, expect, it } from 'vitest';
import { inferSpec, specTimeline, topEvidence, type AbilityInput } from '../src/combatlog/spec';

/** What the parser stores for one session: every ability, with the volume it saw. */
function cast(name: string, amount: number): AbilityInput {
  return { name, kind: 'cast', amount, hits: 0 };
}
function dealt(name: string, amount: number, hits: number): AbilityInput {
  return { name, kind: 'damage', amount, hits };
}
/** An ability that hit the player — its spell belongs to the attacker, not the player. */
function taken(name: string, amount: number, hits: number): AbilityInput {
  return { name, kind: 'taken', amount, hits };
}

/** The two abilities a Retribution paladin cannot have without the tree. */
const RET_ONLY: AbilityInput[] = [
  cast('Seal of Command', 146),
  cast('Judgement', 73),
  dealt('Seal of Command', 11517, 59),
  dealt('Judgement of Command', 14167, 66),
];

/**
 * A Holy paladin's rotation on this server, with nothing talent-locked in it: Holy Light is
 * baseline for every spec, and Consecration is a Holy talent the server hands to everyone — which
 * is exactly why the table does not list it as a marker.
 */
const HOLY_ONLY: AbilityInput[] = [
  cast('Holy Light', 145),
  cast('Flash of Light', 160),
  cast('Consecration', 49),
  cast('Seal of Light', 20),
  cast('Judgement', 140),
  cast('Holy Strike', 149),
];

/** Session 451 of the reference character: Holy first, Retribution after the respec. */
const HOLY_THEN_RET: AbilityInput[] = [...HOLY_ONLY, ...RET_ONLY, cast('Exorcism', 7), cast('Crusader Strike', 3)];

describe('inferSpec', () => {
  it('names the spec a talent-locked ability proves', () => {
    const guess = inferSpec({ abilities: RET_ONLY });
    expect(guess?.className).toBe('PALADIN');
    expect(guess?.spec).toBe('Retribution');
    expect(guess?.role).toBe('damage');
    expect(guess?.evidence.map((e) => e.spell)).toContain('Seal of Command');
  });

  it('never infers a spec from damage the player took', () => {
    // The Stockade case: a warrior mob lands Shield Slam (a Protection marker) on the player, who
    // cast nothing talent-locked themselves. The attacker's ability is not the player's spec.
    expect(inferSpec({ abilities: [taken('Shield Slam', 52, 3)] })).toBeNull();
    // And a taken marker must not override, or sit beside, what the player actually performed.
    const guess = inferSpec({ abilities: [...RET_ONLY, taken('Shield Slam', 52, 3)] });
    expect(guess?.spec).toBe('Retribution');
    expect(guess?.evidence.map((e) => e.spell)).not.toContain('Shield Slam');
  });

  it('says nothing when the log holds no talent-locked ability', () => {
    // A Holy paladin's rotation on this server: Holy Light is baseline for every spec, and
    // Consecration is a Holy talent the server hands to everyone, which is exactly why the table
    // does not list it.
    expect(inferSpec({ abilities: HOLY_ONLY })).toBeNull();
  });

  it('prefers the spec with more markers when a build straddles two trees', () => {
    // 21 Holy / 30 Retribution unlocks Divine Favor *and* the Command pair. The pair wins, and one
    // marker against two is not close enough to report as an open question.
    const guess = inferSpec({ abilities: [...RET_ONLY, cast('Divine Favor', 2)] });
    expect(guess?.spec).toBe('Retribution');
    expect(guess?.alternates).toEqual([]);
    expect(guess!.confidence).toBe(0.9);
  });

  it('reports the other candidate when a single marker ties', () => {
    const guess = inferSpec({ abilities: [cast('Seal of Command', 40), cast('Divine Favor', 9)] });
    expect(guess?.spec).toBe('Retribution');
    expect(guess?.alternates).toEqual(['Holy']);
    // Two markers against one is a decision; one against one is not, so the certainty drops.
    const sure = inferSpec({ abilities: [cast('Seal of Command', 40), cast('Judgement of Command', 40)] });
    expect(guess!.confidence).toBeLessThan(sure!.confidence);
  });

  it('never claims more than 0.9: the tree was not read, the abilities were', () => {
    const guess = inferSpec({ abilities: RET_ONLY });
    expect(guess!.confidence).toBeLessThanOrEqual(0.9);
  });

  it('ignores a marker from another class when the class is known', () => {
    // A mage cannot have Seal of Command; that row is a group-mate's spell in the same table.
    expect(inferSpec({ abilities: RET_ONLY, className: 'MAGE' })).toBeNull();
    expect(inferSpec({ abilities: RET_ONLY, className: 'paladin' })?.spec).toBe('Retribution');
  });

  it('merges the same spell recorded as a cast and as damage', () => {
    const guess = inferSpec({ abilities: HOLY_THEN_RET });
    const seal = guess?.evidence.find((e) => e.spell === 'Seal of Command');
    // Casts read clearer than damage totals, so the cast row is the one shown.
    expect(seal?.kind).toBe('cast');
    expect(seal?.amount).toBe(146);
  });

  it('returns null for an empty table rather than guessing', () => {
    expect(inferSpec({ abilities: [] })).toBeNull();
  });
});

describe('topEvidence', () => {
  it('picks the busiest talent-locked ability, not a supporting one', () => {
    const guess = inferSpec({ abilities: HOLY_THEN_RET })!;
    expect(topEvidence(guess)?.spell).toBe('Seal of Command');
  });
});

describe('specTimeline', () => {
  const ret = inferSpec({ abilities: RET_ONLY })!;

  it('says nothing at all when no run carried a marker', () => {
    const t = specTimeline([
      { guess: null, startMs: 0, endMs: 1000 },
      { guess: null, startMs: 1000, endMs: 2000 },
    ]);
    expect(t.phases).toEqual([]);
    expect(t.switched).toBe(false);
    expect(t.unstatedRuns).toBe(2);
  });

  it('collapses consecutive runs of one spec into one phase', () => {
    const t = specTimeline([
      { guess: null, startMs: 0, endMs: 1000 },
      { guess: ret, startMs: 1000, endMs: 2000 },
      { guess: ret, startMs: 2000, endMs: 3000 },
    ]);
    expect(t.phases).toHaveLength(1);
    expect(t.phases[0]).toMatchObject({ spec: 'Retribution', fromMs: 1000, toMs: 3000, runs: 2 });
    expect(t.unstatedRuns).toBe(1);
    // The marker-less run sits in front of the named phase: a dated switch, not a session in one
    // spec, and the page must not print "all session" about it.
    expect(t.unstatedFirst).toBe(1);
    expect(t.switched).toBe(false);
  });

  it('dates the switch when the answer changes mid-sequence', () => {
    const holy = inferSpec({ abilities: [cast('Divine Favor', 4)] })!;
    const t = specTimeline([
      { guess: holy, startMs: 0, endMs: 1000 },
      { guess: holy, startMs: 1000, endMs: 2000 },
      { guess: ret, startMs: 2000, endMs: 3000 },
    ]);
    expect(t.switched).toBe(true);
    expect(t.phases.map((p) => p.spec)).toEqual(['Holy', 'Retribution']);
    expect(t.phases[1]!.fromMs).toBe(2000);
  });

  it('counts a return to an earlier spec as a second phase, not a merge', () => {
    const holy = inferSpec({ abilities: [cast('Divine Favor', 4)] })!;
    const t = specTimeline([
      { guess: holy, startMs: 0, endMs: 1000 },
      { guess: ret, startMs: 1000, endMs: 2000 },
      { guess: holy, startMs: 2000, endMs: 3000 },
    ]);
    expect(t.phases.map((p) => p.spec)).toEqual(['Holy', 'Retribution', 'Holy']);
  });
});
