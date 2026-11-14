/**
 * What a session was actually about.
 *
 * A healer's damage is incidental and a damage dealer's healing is usually a bandage, so no single
 * metric can headline every session: pick damage and a healer's page reads "0 dps" next to 70,000
 * healing, pick healing and a battleground looks empty. Take the larger total instead.
 *
 * Rates are per second of time actually spent fighting (engaged), falling back to active time and
 * then wall clock — the same basis the session cards use, and never a division by zero.
 */

export interface ThroughputInput {
  damage: number;
  healing: number;
  /** time in combat, with activity gaps of <=5s counted */
  engagedS: number;
  /** time with any activity at all */
  activeS: number;
  /** wall clock */
  durationS: number;
}

export interface Throughput {
  /** the metric that dominated this session */
  kind: 'damage' | 'healing';
  otherKind: 'damage' | 'healing';
  total: number;
  otherTotal: number;
  /** per second of basisS */
  rate: number;
  otherRate: number;
  basisS: number;
  /** the two are within 10% of each other: neither really dominates */
  mixed: boolean;
}

export function throughput(input: ThroughputInput): Throughput {
  const basisS = Math.max(input.engagedS || input.activeS || input.durationS || 0, 0);
  const kind: Throughput['kind'] = input.healing > input.damage ? 'healing' : 'damage';
  const total = kind === 'healing' ? input.healing : input.damage;
  const otherTotal = kind === 'healing' ? input.damage : input.healing;
  const per = (v: number): number => (basisS > 0 ? Math.round(v / basisS) : 0);
  return {
    kind,
    otherKind: kind === 'healing' ? 'damage' : 'healing',
    total,
    otherTotal,
    rate: per(total),
    otherRate: per(otherTotal),
    basisS,
    mixed: total > 0 && otherTotal >= total * 0.9,
  };
}
