/**
 * Turning the classifier into something a page can print.
 *
 * The pages ask two questions — "what was this run" and "what was this session" — and both answers
 * have to carry their evidence, because an inferred spec with no evidence beside it reads like a
 * fact. A run with no talent-locked ability gets no chip at all: silence is the correct label there,
 * and the throughput pill next to it already says whether the output was damage or healing.
 */
import { inferSpec, specTimeline, topEvidence, type SpecGuess, type SpecTimeline } from '../../../core/src/combatlog/spec';
import type { Store } from '../store';
import { when } from './format';

/** What one run can say about the character's spec. */
export function specForRun(store: Store, segmentId: number): SpecGuess | null {
  return inferSpec({ abilities: store.segmentAbilitiesAll(segmentId) });
}

export interface SessionSpec {
  timeline: SpecTimeline;
  /** the guess behind every run row, so a chip and the header never disagree */
  bySegment: Map<number, SpecGuess | null>;
  /** the evidence the header quotes, or null when nothing was named */
  evidence: string | null;
}

/** What the sequence of runs in one session can say, including where it changed. */
export function specForSession(
  store: Store,
  segments: { id: number; start_ms: number; end_ms: number }[],
): SessionSpec {
  const bySegment = new Map<number, SpecGuess | null>();
  const runs = segments.map((seg) => {
    const guess = specForRun(store, seg.id);
    bySegment.set(seg.id, guess);
    return { guess, startMs: seg.start_ms, endMs: seg.end_ms };
  });
  const timeline = specTimeline(runs);

  // Quote the build the session ended on: that answers "what am I now", and the earlier phases are
  // dated in the line anyway.
  const lastNamed = [...runs].reverse().find((r) => r.guess);
  return { timeline, bySegment, evidence: lastNamed?.guess ? specEvidenceText(lastNamed.guess) : null };
}

/** `Seal of Command ×146 casts` — the evidence, in the units the log recorded it in. */
export function specEvidenceText(guess: SpecGuess): string {
  const top = topEvidence(guess);
  if (!top) return 'no ability recorded';
  const unit = top.kind === 'cast' ? 'casts' : top.kind === 'healing' ? 'healing' : 'damage';
  return `${top.spell} ×${top.amount.toLocaleString('en-US')} ${unit}`;
}

/** The tooltip behind a chip: what the label rests on, and how sure it is. */
export function specTitle(guess: SpecGuess): string {
  const extra = guess.alternates.length > 0 ? ` · also fits ${guess.alternates.join(', ')}` : '';
  return `inferred from ${specEvidenceText(guess)} · ${Math.round(guess.confidence * 100)}%${extra}`;
}

/** A phase's own chip text, lowercased the way the rest of the UI labels roles. */
export function specLabel(guess: SpecGuess): string {
  return guess.spec.toLowerCase();
}

/**
 * One line for a session header, or null when no run carried evidence.
 *
 * A respec inside a session is the case that made this worth writing: the session-wide throughput
 * reads "mixed", and the honest answer is that the evening had two builds with a time between
 * them, not one average.
 */
export function sessionSpecLine(spec: SessionSpec, offsetMin: number): string | null {
  const phases = spec.timeline.phases;
  if (phases.length === 0) return null;
  const evidence = spec.evidence ? ` · ${spec.evidence}` : '';
  const first = phases[0]!;
  const gap = spec.timeline.unstatedFirst;
  if (phases.length === 1) {
    // A run of marker-less runs in front of the one named phase is a respec the log dates, not a
    // session spent in one spec: say where the evidence starts instead of "all session".
    if (gap > 0) {
      return `${first.spec.toLowerCase()} from ${when(first.fromMs, offsetMin)} · no marker in the ${gap} run${
        gap === 1 ? '' : 's'
      } before it${evidence}`;
    }
    return `${first.spec.toLowerCase()} all session${evidence}`;
  }
  const path = phases.map((p) => `${p.spec.toLowerCase()} from ${when(p.fromMs, offsetMin)}`).join(' → ');
  return `${path}${evidence}`;
}
