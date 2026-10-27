/**
 * Analytics: everything that reads stored activity and produces an answer.
 *
 * All of it is pure with respect to the database — it takes a `Db`, queries,
 * and returns the API contract types. Nothing here writes.
 *
 * Multi-device days are merged by *summing* per-minute accounts and rebuilding
 * the derived statistics, never by concatenating per-device summaries: two
 * machines used at the same time must not produce a 30-hour day.
 */

import {
  aggregateDay,
  dayKey,
  detectFocusBlocks,
  endOfLocalDay,
  mergeRollups,
  parseDayKey,
  shiftDayKey,
  startOfLocalDay,
  DAY,
  MINUTE,
} from '@attentio/shared';
import type {
  ActivitySegment,
  BlocksResponse,
  DayQuery,
  DayResponse,
  DayStats,
  Device,
  FocusWeights,
  TimelineQuery,
  TimelineResponse,
  TrendPoint,
  TrendResponse,
} from '@attentio/shared';

import { resolveFocusWeights, type AttentioConfig as Config } from './config.ts';
import type { Db } from './db/index.ts';

export interface AnalyticsDeps {
  db: Db;
  config: Config;
}

/** Local calendar bounds of a day key. */
export function dayBounds(day: string): { from: number; to: number } {
  const anchor = parseDayKey(day);
  return { from: startOfLocalDay(anchor), to: endOfLocalDay(anchor) };
}

export function todayKey(now = Date.now()): string {
  return dayKey(now);
}

/** Trusted devices, filtered to one when requested. */
export function scopedDevices(db: Db, deviceId?: string): Device[] {
  const devices = db.listDevices().filter((d) => d.trusted);
  if (!deviceId) return devices;
  return devices.filter((d) => d.id === deviceId);
}

function weightsFor(config: Config, preset?: 'balanced' | 'deep' | 'calm'): Partial<FocusWeights> {
  if (!preset) return resolveFocusWeights(config);
  return resolveFocusWeights({ ...config, focus: { ...config.focus, preset } });
}

/**
 * Build one device's day, or `null` when that device recorded nothing.
 * `segments` are used for context-level analysis; `rollups` for the accounts.
 */
function buildDeviceDay(
  day: string,
  deviceId: string,
  rollups: ReturnType<Db['queryRollups']>,
  segments: readonly ActivitySegment[],
  weights: Partial<FocusWeights>,
): DayStats | null {
  if (rollups.length === 0) return null;
  return aggregateDay({
    deviceId,
    day,
    rollups,
    segments,
    focusWeights: weights,
  });
}

export function computeDay(deps: AnalyticsDeps, query: DayQuery = {}): DayResponse {
  const { db, config } = deps;
  const day = query.day ?? todayKey();
  const { from, to } = dayBounds(day);
  const devices = scopedDevices(db, query.deviceId);
  const weights = weightsFor(config, query.focusPreset);

  const perDevice: DayStats[] = [];
  const allRollups: ReturnType<Db['queryRollups']> = [];
  const allSegments: ActivitySegment[] = [];

  for (const device of devices) {
    const rollups = db.queryRollups({ from, to, deviceId: device.id });
    if (rollups.length === 0) continue;
    // Timeline is capped because a busy day can hold tens of thousands of rows
    // and the summary does not need every one of them.
    const segments = db.querySegments({ from, to, deviceId: device.id, limit: 4000 });
    allRollups.push(...rollups);
    allSegments.push(...segments);
    const stats = buildDeviceDay(day, device.id, rollups, segments, weights);
    if (stats) perDevice.push(stats);
  }

  // When a single device is selected there is nothing to merge, and reusing the
  // exact object keeps device-level numbers bit-identical to the merged view.
  let merged: DayStats;
  if (perDevice.length === 1) {
    merged = perDevice[0] as DayStats;
  } else {
    merged = aggregateDay({
      deviceId: query.deviceId ?? 'all',
      day,
      rollups: mergeRollups(allRollups),
      segments: allSegments,
      focusWeights: weights,
    });
  }

  return {
    day,
    stats: merged,
    perDevice,
    devices,
    rollupsIncluded: true,
  };
}

export function computeTimeline(deps: AnalyticsDeps, query: TimelineQuery = {}): TimelineResponse {
  const { db } = deps;
  const day = query.day ?? todayKey();
  const { from, to } = dayBounds(day);
  const limit = Math.min(Math.max(query.limit ?? 2000, 1), 20_000);
  const segments = db.querySegments({ from, to, deviceId: query.deviceId, limit: limit + 1 });
  const truncated = segments.length > limit;
  return {
    day,
    segments: truncated ? segments.slice(segments.length - limit) : segments,
    truncated,
  };
}

export interface TrendQuery {
  /** Inclusive last day key; defaults to today. */
  end?: string;
  days?: number;
  deviceId?: string;
  /** Include per-app totals, which cost one extra query per day. */
  apps?: boolean;
}

export function computeTrend(deps: AnalyticsDeps, query: TrendQuery = {}): TrendResponse {
  const { db, config } = deps;
  const days = Math.min(Math.max(query.days ?? 14, 1), 366);
  const end = query.end ?? todayKey();
  const devices = scopedDevices(db, query.deviceId);
  const weights = weightsFor(config);
  const points: TrendPoint[] = [];
  const byApp: { day: string; app: string; foregroundMs: number }[] = [];

  for (let offset = days - 1; offset >= 0; offset--) {
    const day = shiftDayKey(end, -offset);
    const { from, to } = dayBounds(day);
    const rollups: ReturnType<Db['queryRollups']> = [];
    const segments: ActivitySegment[] = [];
    for (const device of devices) {
      rollups.push(...db.queryRollups({ from, to, deviceId: device.id }));
      if (query.apps) segments.push(...db.querySegments({ from, to, deviceId: device.id, limit: 4000 }));
    }
    if (rollups.length === 0) {
      points.push({
        day,
        activeMs: 0,
        deepMs: 0,
        distractingMs: 0,
        idleMs: 0,
        cpuMs: 0,
        switches: 0,
        score: 0,
        topApp: '',
      });
      continue;
    }

    const merged = mergeRollups(rollups);
    const stats = aggregateDay({
      deviceId: query.deviceId ?? 'all',
      day,
      rollups: merged,
      segments,
      focusWeights: weights,
    });

    let deepMs = 0;
    let distractingMs = 0;
    for (const category of stats.categories) {
      if (category.category === 'deep-work' || category.category === 'learning' || category.category === 'creative') {
        deepMs += category.ms;
      }
      if (category.category === 'entertainment' || category.category === 'social' || category.category === 'shopping') {
        distractingMs += category.ms;
      }
    }

    points.push({
      day,
      activeMs: stats.activeMs,
      deepMs,
      distractingMs,
      idleMs: stats.idleMs,
      cpuMs: stats.cpuMs,
      switches: stats.switches,
      score: stats.focus.score,
      topApp: stats.apps[0]?.app ?? '',
    });

    if (query.apps) {
      for (const app of stats.apps.slice(0, 8)) {
        byApp.push({ day, app: app.app, foregroundMs: app.foregroundMs });
      }
    }
  }

  return query.apps ? { days: points, byApp } : { days: points };
}

export interface BlocksQuery {
  day?: string;
  deviceId?: string;
  minBlockMs?: number;
}

export function computeBlocks(deps: AnalyticsDeps, query: BlocksQuery = {}): BlocksResponse {
  const { db } = deps;
  const day = query.day ?? todayKey();
  const { from, to } = dayBounds(day);
  const minBlockMs = query.minBlockMs ?? 15 * MINUTE;
  const segments = db.querySegments({ from, to, deviceId: query.deviceId, limit: 20_000 });
  const blocks = detectFocusBlocks(segments, {
    minBlockMs,
    blockGapMs: 5 * MINUTE,
    isBlockCategory: (category) =>
      category === 'deep-work' || category === 'learning' || category === 'creative' || category === 'reference',
  });
  return { day, blocks, minBlockMs };
}

/** Longest stretch with no activity at all, inside the day's observed span. */
export function longestIdleStreak(stats: DayStats): number {
  if (stats.hours.length === 0) return 0;
  let longest = 0;
  let current = 0;
  for (const hour of stats.hours) {
    if (hour.foregroundMs === 0) {
      current += 1;
    } else {
      longest = Math.max(longest, current);
      current = 0;
    }
  }
  return Math.max(longest, current) * 60 * MINUTE;
}

export { DAY };
