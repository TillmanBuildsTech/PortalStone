/**
 * Which specialization a set of abilities implies.
 *
 * The combat log records abilities, never talents. There is no respec event in the format — every
 * event type a `_forever_` log emits was checked (41 of them, 64 MB of real logs), and none of
 * them names a tree. So the only evidence a log carries is *what was cast*, and every answer here
 * is an inference. The job is to make that inference narrow enough to be worth showing:
 *
 *  - a **marker** is an ability a specialization cannot have without spending talent points in it.
 *    Seal of Command at 146 casts is not a hint, it is a named tree.
 *  - an ability every spec can cast proves nothing. Holy Light is not evidence of Holy.
 *  - with no marker in the data the answer is null, not a plausible guess wearing a label.
 *
 * The table is data, and entries were promoted or demoted by looking at real logs rather than at a
 * wiki. Consecration is a Holy talent in vanilla and appears in *every* session on this server,
 * including the Retribution ones, so it is not evidence of anything and is deliberately absent. A
 * server that hands a talent to everyone makes that talent worthless as a marker, and the table
 * has to know it.
 *
 * None of this replaces ground truth. The sensor addon (addons/PortalStoneSense) writes the tree
 * the character actually has; this module is what the app can still say about the logs it already
 * holds, and it says it in those words.
 */

export type SpecRole = 'damage' | 'healing' | 'tank';

export interface SpecEvidence {
  spell: string;
  kind: string;
  /** how much of it the log recorded: casts, damage done, or healing done */
  amount: number;
  hits: number;
  /** 1: talent-locked. 0.4: strongly associated, but a character of another spec can have it */
  weight: number;
}

export interface SpecGuess {
  className: string;
  spec: string;
  role: SpecRole;
  /** 0..1, and deliberately capped below certainty: this is read from behaviour, not from a tree */
  confidence: number;
  evidence: SpecEvidence[];
  /** other specs the same markers fit, when the evidence did not separate them */
  alternates: string[];
}

interface Signature {
  className: string;
  spec: string;
  role: SpecRole;
  /** talent-locked: seeing one of these is the proof */
  markers: string[];
  /** seen on this spec, but obtainable elsewhere: support and tie-breaks only */
  likely: string[];
}

/**
 * Classic-era trees. Every marker is a talent that cannot be taken without spending points in the
 * tree that names the spec; the `likely` entries exist because a marker set of one produces ties.
 */
const SIGNATURES: Signature[] = [
  {
    className: 'PALADIN',
    spec: 'Retribution',
    role: 'damage',
    markers: ['Seal of Command', 'Judgement of Command', 'Repentance'],
    likely: ['Crusader Strike', 'Hammer of Wrath', 'Exorcism'],
  },
  {
    className: 'PALADIN',
    spec: 'Holy',
    role: 'healing',
    markers: ['Holy Shock', 'Divine Favor'],
    likely: ['Holy Light', 'Flash of Light', 'Lay on Hands'],
  },
  {
    className: 'PALADIN',
    spec: 'Protection',
    role: 'tank',
    markers: ['Holy Shield', "Blessing of Sanctuary"],
    likely: ['Avenger\'s Shield', 'Righteous Fury'],
  },
  {
    className: 'MAGE',
    spec: 'Fire',
    role: 'damage',
    markers: ['Combustion', 'Blast Wave'],
    likely: ['Pyroblast', 'Fireball'],
  },
  {
    className: 'MAGE',
    spec: 'Frost',
    role: 'damage',
    markers: ['Ice Barrier', 'Cold Snap'],
    likely: ['Frostbolt', 'Ice Block'],
  },
  {
    className: 'MAGE',
    spec: 'Arcane',
    role: 'damage',
    markers: ['Arcane Power', 'Presence of Mind'],
    likely: ['Arcane Missiles', 'Arcane Explosion'],
  },
  {
    className: 'PRIEST',
    spec: 'Shadow',
    role: 'damage',
    markers: ['Shadowform', 'Vampiric Embrace'],
    likely: ['Mind Flay', 'Shadow Word: Pain'],
  },
  {
    className: 'PRIEST',
    spec: 'Discipline',
    role: 'healing',
    markers: ['Power Infusion', 'Divine Spirit'],
    likely: ['Power Word: Shield', 'Flash Heal'],
  },
  {
    className: 'PRIEST',
    spec: 'Holy',
    role: 'healing',
    markers: ['Spirit of Redemption', 'Lightwell'],
    likely: ['Heal', 'Greater Heal'],
  },
  {
    className: 'WARRIOR',
    spec: 'Arms',
    role: 'damage',
    markers: ['Mortal Strike', 'Sweeping Strikes'],
    likely: ['Overpower', 'Hamstring'],
  },
  {
    className: 'WARRIOR',
    spec: 'Fury',
    role: 'damage',
    markers: ['Bloodthirst', 'Death Wish'],
    likely: ['Whirlwind', 'Execute'],
  },
  {
    className: 'WARRIOR',
    spec: 'Protection',
    role: 'tank',
    markers: ['Shield Slam', 'Concussion Blow'],
    likely: ['Revenge', 'Shield Block'],
  },
  {
    className: 'ROGUE',
    spec: 'Assassination',
    role: 'damage',
    markers: ['Cold Blood', 'Vigor'],
    likely: ['Eviscerate', 'Kidney Shot'],
  },
  {
    className: 'ROGUE',
    spec: 'Combat',
    role: 'damage',
    markers: ['Blade Flurry', 'Adrenaline Rush'],
    likely: ['Sinister Strike', 'Slice and Dice'],
  },
  {
    className: 'ROGUE',
    spec: 'Subtlety',
    role: 'damage',
    markers: ['Preparation', 'Premeditation'],
    likely: ['Hemorrhage', 'Backstab'],
  },
  {
    className: 'DRUID',
    spec: 'Balance',
    role: 'damage',
    markers: ['Moonkin Form', "Nature's Grace"],
    likely: ['Starfire', 'Wrath'],
  },
  {
    className: 'DRUID',
    spec: 'Feral',
    role: 'tank',
    markers: ['Leader of the Pack', 'Mangle'],
    likely: ['Maul', 'Shred'],
  },
  {
    className: 'DRUID',
    spec: 'Restoration',
    role: 'healing',
    markers: ['Innervate', "Nature's Swiftness"],
    likely: ['Rejuvenation', 'Healing Touch'],
  },
  {
    className: 'SHAMAN',
    spec: 'Elemental',
    role: 'damage',
    markers: ['Elemental Mastery', 'Lightning Mastery'],
    likely: ['Lightning Bolt', 'Chain Lightning'],
  },
  {
    className: 'SHAMAN',
    spec: 'Enhancement',
    role: 'damage',
    markers: ['Stormstrike', 'Flurry'],
    likely: ['Windfury Weapon', 'Earth Shock'],
  },
  {
    className: 'SHAMAN',
    spec: 'Restoration',
    role: 'healing',
    markers: ['Mana Tide Totem', "Nature's Swiftness"],
    likely: ['Healing Wave', 'Lesser Healing Wave'],
  },
  {
    className: 'WARLOCK',
    spec: 'Affliction',
    role: 'damage',
    markers: ['Siphon Life', 'Dark Pact', 'Curse of Exhaustion'],
    likely: ['Corruption', 'Drain Life'],
  },
  {
    className: 'WARLOCK',
    spec: 'Demonology',
    role: 'damage',
    markers: ['Soul Link', 'Demonic Sacrifice'],
    likely: ['Shadow Bolt', 'Summon Felhunter'],
  },
  {
    className: 'WARLOCK',
    spec: 'Destruction',
    role: 'damage',
    markers: ['Conflagrate', 'Shadowburn'],
    likely: ['Immolate', 'Searing Pain'],
  },
  {
    className: 'HUNTER',
    spec: 'Beast Mastery',
    role: 'damage',
    markers: ['Bestial Wrath', 'Intimidation'],
    likely: ['Kill Command', 'Arcane Shot'],
  },
  {
    className: 'HUNTER',
    spec: 'Marksmanship',
    role: 'damage',
    markers: ['Trueshot Aura', 'Scatter Shot'],
    likely: ['Aimed Shot', 'Multi-Shot'],
  },
  {
    className: 'HUNTER',
    spec: 'Survival',
    role: 'damage',
    markers: ['Wyvern Sting', 'Deterrence'],
    likely: ['Immolation Trap', 'Wing Clip'],
  },
];

export interface AbilityInput {
  name: string;
  /**
   * What the log recorded it under: 'cast', 'damage' (done), 'healing' (done), or 'taken'. Only the
   * first three are the player's own actions and count as evidence; 'taken' is damage received and
   * is ignored, since its spell belongs to whoever hit the player.
   */
  kind?: string;
  amount?: number;
  hits?: number;
}

export interface InferInput {
  abilities: AbilityInput[];
  /**
   * The class, when SavedVariables knows it. A paladin cannot have Cold Blood, so a marker from
   * another class is noise from a group-mate's spell that leaked into the same table.
   */
  className?: string | null;
}

/** 'Paladin' and 'PALADIN' are the same class; anything else is compared as written. */
function classKey(name: string): string {
  return name.trim().toUpperCase();
}

function said(input: AbilityInput): number {
  // Casts carry counts in `amount`; damage and healing carry volume. Either proves the spell.
  return Math.max(input.amount ?? 0, input.hits ?? 0, 1);
}

/**
 * The best spec the abilities support, or null when they support none.
 *
 * Ties are real: 21 points in one tree and 30 in another can unlock two markers at once. Then the
 * call goes to the spec with more distinct markers, and the loser is reported as an alternate
 * rather than dropped — a page that shows one name and hides the other would be lying about how
 * much the log actually said.
 */
export function inferSpec(input: InferInput): SpecGuess | null {
  // One row per (spell, kind): a seal is a cast *and* a damage source, and both are evidence.
  const seen = new Map<string, SeenRow>();
  for (const a of input.abilities) {
    const name = a.name.trim();
    if (!name) continue;
    const kind = a.kind ?? 'cast';
    // Evidence is only what the player performed — casts, damage done, healing done. Damage *taken*
    // names the attacker's ability, not the player's: a Stockade warrior's Shield Slam landing on
    // you is not proof you are Protection. Received abilities are never evidence of your spec.
    if (kind === 'taken') continue;
    const key = `${name}\u0000${kind}`;
    const prev = seen.get(key);
    if (prev) {
      prev.amount += a.amount ?? 0;
      prev.hits += a.hits ?? 0;
    } else {
      seen.set(key, { name, kind, amount: a.amount ?? 0, hits: a.hits ?? 0 });
    }
  }
  if (seen.size === 0) return null;

  const wanted = input.className ? classKey(input.className) : null;
  const scored = SIGNATURES.map((sig) => {
    const evidence = match(sig, seen);
    const weight = evidence.reduce((a, e) => a + e.weight, 0);
    const volume = evidence.reduce((a, e) => a + said({ name: e.spell, amount: e.amount, hits: e.hits }), 0);
    return { sig, evidence, weight, volume };
  })
    .filter((s) => s.evidence.some((e) => e.weight === 1))
    .filter((s) => (wanted ? s.sig.className === wanted : true))
    .sort((a, b) => b.weight - a.weight || b.volume - a.volume);

  const best = scored[0];
  if (!best) return null;

  // Two markers against one is a decision. One against one is not: name the louder cast and say
  // the other fits too.
  const alternates = scored
    .slice(1)
    .filter((s) => s.weight >= best.weight * 0.8)
    .map((s) => s.sig.spec);

  return {
    className: best.sig.className,
    spec: best.sig.spec,
    role: best.sig.role,
    confidence: confidence(best.weight, alternates.length),
    evidence: best.evidence,
    alternates,
  };
}

interface SeenRow {
  name: string;
  kind: string;
  amount: number;
  hits: number;
}

/** The row that best argues for one spell: a cast count reads clearer than a damage total. */
function bestRow(spell: string, seen: Map<string, SeenRow>): SeenRow | null {
  let pick: SeenRow | null = null;
  for (const row of seen.values()) {
    if (row.name !== spell) continue;
    if (!pick) {
      pick = row;
      continue;
    }
    const pickIsCast = pick.kind === 'cast';
    if (row.kind === 'cast' && !pickIsCast) pick = row;
    else if (row.kind !== 'cast' && !pickIsCast && said(row) > said(pick)) pick = row;
  }
  return pick;
}

function match(sig: Signature, seen: Map<string, SeenRow>): SpecEvidence[] {
  const out: SpecEvidence[] = [];
  for (const name of sig.markers) {
    const hit = bestRow(name, seen);
    if (!hit) continue;
    out.push({ spell: name, kind: hit.kind, amount: hit.amount, hits: hit.hits, weight: 1 });
  }
  for (const name of sig.likely) {
    const hit = bestRow(name, seen);
    if (!hit) continue;
    out.push({ spell: name, kind: hit.kind, amount: hit.amount, hits: hit.hits, weight: 0.4 });
  }
  return out;
}

/**
 * Certainty is capped at 0.9 on purpose. The tree was not read; the abilities were. A page that
 * prints 97% next to an inference is claiming precision the log does not have.
 */
function confidence(weight: number, alternates: number): number {
  const base = 0.55 + Math.min(weight, 2) * 0.175;
  const open = alternates > 0 ? 0.12 : 0;
  return Math.round(Math.max(0.5, Math.min(0.9, base - open)) * 100) / 100;
}

/** How much of a piece of evidence the log recorded. */
function emitted(e: SpecEvidence): number {
  return Math.max(e.amount, e.hits, 1);
}

/**
 * The single strongest piece of evidence, for a chip's tooltip.
 *
 * Cast counts win over damage totals even when the total is bigger: "×146 casts" is a number the
 * reader can check against their own rotation, and mixing the two units in one tooltip would be
 * comparing a count to a hit.
 */
export function topEvidence(guess: SpecGuess): SpecEvidence | null {
  const markers = guess.evidence.filter((e) => e.weight === 1);
  const pool = markers.length > 0 ? markers : guess.evidence;
  if (pool.length === 0) return null;
  const casts = pool.filter((e) => e.kind === 'cast');
  const from = casts.length > 0 ? casts : pool;
  return from.reduce((a, b) => (emitted(b) > emitted(a) ? b : a));
}

export interface SpecRun {
  guess: SpecGuess | null;
  startMs: number;
  endMs: number;
}

export interface SpecPhase {
  spec: string;
  className: string;
  role: SpecRole;
  fromMs: number;
  toMs: number;
  /** how many consecutive runs carried this spec */
  runs: number;
  confidence: number;
}

export interface SpecTimeline {
  phases: SpecPhase[];
  /** every run with no marker at all */
  unstatedRuns: number;
  /**
   * Runs before the first named phase. A single phase with a run of these in front of it is a
   * switch that was dated, not a session that was one spec throughout: the label starts where the
   * evidence starts, and the page must not say "all session" about it.
   */
  unstatedFirst: number;
  /** more than one phase means the character changed spec inside this sequence */
  switched: boolean;
}

/**
 * Where a run sequence changes spec.
 *
 * A session label is a summary, and a respec inside a session makes any single summary wrong: one
 * evening can be two builds, and averaging them reads as "mixed" instead of "holy, then
 * retribution from 20:28". Runs are already the unit the app reasons in, so the phases are runs
 * collapsed until the answer changes.
 */
export function specTimeline(runs: SpecRun[]): SpecTimeline {
  const phases: SpecPhase[] = [];
  let unstatedRuns = 0;
  let unstatedFirst = 0;
  for (const run of runs) {
    if (!run.guess) {
      unstatedRuns++;
      if (phases.length === 0) unstatedFirst++;
      continue;
    }
    const g = run.guess;
    const last = phases[phases.length - 1];
    if (last && last.spec === g.spec && last.className === g.className) {
      last.toMs = run.endMs;
      last.runs++;
      last.confidence = Math.min(last.confidence, g.confidence);
      continue;
    }
    phases.push({
      spec: g.spec,
      className: g.className,
      role: g.role,
      fromMs: run.startMs,
      toMs: run.endMs,
      runs: 1,
      confidence: g.confidence,
    });
  }
  return { phases, unstatedRuns, unstatedFirst, switched: phases.length > 1 };
}
