/**
 * Focus scoring.
 *
 * The central design position of this project: **a focus score is an argument,
 * not a measurement.** Foreground window + idle time cannot tell whether you
 * were thinking hard or staring at the ceiling, so instead of hiding that
 * uncertainty behind a single opaque number we publish the whole argument —
 * five named factors, their weights, their contribution in points, and the raw
 * evidence behind each. The UI shows all of it, and the weights are user-editable.
 *
 * Consequences that are deliberate:
 *   - every score carries a `confidence` derived from how much data it saw;
 *   - a low-confidence score says so in `notes` and the UI dims it;
 *   - factors can disagree, and that disagreement is the interesting part.
 */

import { clamp, bump, normalize } from './format.ts';
import { gradeForScore } from './categories.ts';
import type { FocusFactor, FocusSummary } from './types.ts';

export interface FocusInput {
  /** Engaged foreground ms (idle already removed). */
  activeMs: number;
  /** Calendar ms from first to last observation in the window. */
  spanMs: number;
  /** Weighted productivity ratio in [-1, 1]: sum(productivity * ms) / activeMs. */
  qualityRatio: number;
  /** ms spent in the `deep-work` category. */
  deepMs: number;
  /** ms spent in categories with negative productivity. */
  distractingMs: number;
  /** Foreground transitions. */
  switches: number;
  /** Longest uninterrupted block, in minutes. */
  longestBlockMin: number;
  blockCount: number;
  /** Share of active time spent in the three most-used contexts, 0..1. */
  top3ContextShare: number;
  /** Share of the span actually covered by collector samples, 0..1. */
  sampleCoverage: number;
}

export interface FocusWeights {
  engagement: number;
  depth: number;
  continuity: number;
  fragmentation: number;
  coherence: number;
}

/**
 * Default weights.
 *
 * `depth` deliberately dominates. An early version weighted "engagement" and
 * the structural factors highly enough that a day with four hours of
 * distraction and two hours of work still scored 46/100 — the score was
 * rewarding *being at the machine* rather than *doing something worthwhile*.
 * What you were doing is the thing this number is supposed to be about, so it
 * carries 45% of the score and the structural factors share the rest.
 */
export const DEFAULT_FOCUS_WEIGHTS: FocusWeights = {
  engagement: 0.1,
  depth: 0.45,
  continuity: 0.2,
  fragmentation: 0.15,
  coherence: 0.1,
};

export const FOCUS_WEIGHT_META: Record<
  keyof FocusWeights,
  { label: string; labelZh: string; blurb: string }
> = {
  engagement: {
    label: 'Engagement',
    labelZh: '在场度',
    blurb: 'How much of the observed window you were actually at the machine rather than idle.',
  },
  depth: {
    label: 'Depth',
    labelZh: '深度',
    blurb: 'Productivity-weighted mix of what you were doing, from deep work to distraction.',
  },
  continuity: {
    label: 'Continuity',
    labelZh: '连续性',
    blurb: 'Length of your longest unbroken stretch of work.',
  },
  fragmentation: {
    label: 'Fragmentation',
    labelZh: '碎片度',
    blurb: 'Foreground switches per hour. Some switching is normal; a lot of it is not.',
  },
  coherence: {
    label: 'Coherence',
    labelZh: '聚焦度',
    blurb: 'How concentrated your time was in a few contexts instead of spread thin.',
  },
};

export interface FocusScoreOptions {
  weights?: Partial<FocusWeights>;
  /** Hours per day considered a full working day for engagement scaling. */
  fullDayHours?: number;
}

/**
 * Score a window of activity. Pure function: identical input, identical output.
 */
export function scoreFocus(input: FocusInput, options: FocusScoreOptions = {}): FocusSummary {
  const weights: FocusWeights = { ...DEFAULT_FOCUS_WEIGHTS, ...options.weights };
  const activeHours = input.activeMs / 3_600_000;

  // ---- factor values, all normalized to [0, 1] --------------------------
  // Engagement: active time as a share of the observed span.
  const engagementRatio = input.spanMs > 0 ? input.activeMs / input.spanMs : 0;
  const engagement = normalize(engagementRatio, 0.2, 0.8);

  // Depth: productivity-weighted mix. 0.85 is treated as "as good as it gets",
  // which keeps an all-deep-work day from reading as merely average.
  const depth = normalize(input.qualityRatio, -0.5, 0.85);

  // Continuity: 15 minutes of unbroken work scores 0, two hours scores 1.
  const continuity = normalize(input.longestBlockMin, 15, 120);

  // Fragmentation: 12 switches/hour is the sweet spot — below it you may be
  // stuck, above it you are thrashing. Width 25 is intentionally forgiving.
  const switchesPerHour = activeHours > 0.05 ? input.switches / activeHours : 0;
  const fragmentation = bump(switchesPerHour, 12, 25);

  // Coherence: share of active time in the top three contexts.
  const coherence = normalize(input.top3ContextShare, 0.35, 0.9);

  const values: Record<keyof FocusWeights, number> = {
    engagement,
    depth,
    continuity,
    fragmentation,
    coherence,
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

  const factors: FocusFactor[] = (Object.keys(FOCUS_WEIGHT_META) as (keyof FocusWeights)[]).map((id) => {
    const value = clamp(values[id], 0, 1);
    const weight = weights[id];
    const contribution = (weight * value * 100) / totalWeight;
    return {
      id,
      label: FOCUS_WEIGHT_META[id].label,
      value: round3(value),
      weight,
      contribution: round2(contribution),
      detail: describeFactor(id, {
        engagementRatio,
        qualityRatio: input.qualityRatio,
        longestBlockMin: input.longestBlockMin,
        switchesPerHour,
        top3ContextShare: input.top3ContextShare,
        deepMs: input.deepMs,
        distractingMs: input.distractingMs,
        activeMs: input.activeMs,
      }),
    };
  });

  const rawScore = factors.reduce((sum, f) => sum + f.contribution, 0);
  const score = Math.round(clamp(rawScore, 0, 100));

  // Confidence blends coverage with sheer volume of evidence: two hours of
  // solid data is enough to trust a day-level score.
  const volume = clamp(input.activeMs / (2 * 3_600_000), 0, 1);
  const confidence = round2(clamp(input.sampleCoverage * 0.5 + volume * 0.5, 0, 1));

  const notes: string[] = [];
  if (input.activeMs < 30 * 60_000) notes.push('Very little activity in this window — the score is barely meaningful.');
  if (confidence < 0.5) notes.push('Low confidence: not enough data yet. Keep the collector running.');
  if (input.distractingMs > 0 && input.distractingMs / Math.max(1, input.activeMs) > 0.3) {
    notes.push('More than 30% of engaged time went to distracting categories.');
  }
  if (switchesPerHour > 35) notes.push(`You switched windows ${Math.round(switchesPerHour)}×/hour — heavy context thrashing.`);
  if (input.longestBlockMin >= 90) notes.push('At least one 90-minute unbroken block — that is where real progress happens.');
  if (input.blockCount === 0 && input.activeMs > 60 * 60_000) notes.push('No focus block reached the minimum length all day.');
  if (input.deepMs === 0 && input.activeMs > 2 * 3_600_000) notes.push('No time landed in Deep work — either a non-coding day, or rules need tuning.');

  return {
    score,
    grade: gradeForScore(score),
    factors,
    confidence,
    notes,
  };
}

interface FactorEvidence {
  engagementRatio: number;
  qualityRatio: number;
  longestBlockMin: number;
  switchesPerHour: number;
  top3ContextShare: number;
  deepMs: number;
  distractingMs: number;
  activeMs: number;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Plain-language evidence, shown verbatim in the UI next to each factor. */
export function describeFactor(id: string, e: FactorEvidence): string {
  switch (id) {
    case 'engagement':
      return `Engaged ${pct(e.engagementRatio)} of the observed window (${minutes(e.activeMs)} active).`;
    case 'depth':
      return `Productivity mix ${e.qualityRatio >= 0 ? '+' : ''}${e.qualityRatio.toFixed(2)} on a -1..+1 scale; deep work ${minutes(e.deepMs)}, distraction ${minutes(e.distractingMs)}.`;
    case 'continuity':
      return `Longest unbroken block ${Math.round(e.longestBlockMin)} minutes.`;
    case 'fragmentation':
      return `${e.switchesPerHour.toFixed(0)} foreground switches per active hour (12/h is the sweet spot).`;
    case 'coherence':
      return `Top three contexts hold ${pct(e.top3ContextShare)} of engaged time.`;
    default:
      return '';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Recompute a summary at a different weight configuration without rescoring raw data. */
export function weightPreset(name: 'balanced' | 'deep' | 'calm'): FocusWeights {
  switch (name) {
    case 'deep':
      return { engagement: 0.05, depth: 0.55, continuity: 0.25, fragmentation: 0.1, coherence: 0.05 };
    case 'calm':
      // Rewards steadiness over intensity: for people recovering from burnout.
      return { engagement: 0.25, depth: 0.15, continuity: 0.2, fragmentation: 0.2, coherence: 0.2 };
    case 'balanced':
    default:
      return { ...DEFAULT_FOCUS_WEIGHTS };
  }
}
