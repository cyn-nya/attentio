/**
 * Configuration: filesystem layout and the user-editable config file.
 *
 * Everything lives under `$ATTENTIO_HOME` (default `~/.attentio`). The config
 * file is plain JSON with comments stripped on write and unknown keys
 * preserved, so a user can hand-edit it without the daemon eating their notes.
 *
 * Precedence, lowest to highest: built-in defaults < config.json < environment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FocusWeights } from '@attentio/shared';
import { DEFAULT_FOCUS_WEIGHTS } from '@attentio/shared';

export type RedactionLevel = 'app' | 'context' | 'full';
export type FocusPreset = 'balanced' | 'deep' | 'calm' | 'custom';

export interface AiConfig {
  enabled: boolean;
  /** Any OpenAI-compatible endpoint: OpenAI, DeepSeek, Moonshot, Ollama, LM Studio, vLLM. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * How much detail may leave the machine when a report is generated.
   *   app     — only app names, categories and timings (safest)
   *   context — adds project / page / document names
   *   full    — adds raw window titles (most useful, most revealing)
   */
  redaction: RedactionLevel;
  /** Local hour (0-23) for the automatic daily report. -1 disables it. */
  dailyReportHour: number;
  language: 'en' | 'zh';
  maxTokens: number;
  temperature: number;
  /** Seconds to wait for the model before giving up. */
  timeoutSec: number;
}

export interface TrackingConfig {
  idleThresholdSec: number;
  sampleIntervalMs: number;
  processIntervalMs: number;
  inventoryIntervalMs: number;
  /** Days of raw segments to keep. 0 keeps everything. Rollups are never pruned. */
  segmentRetentionDays: number;
  /** Store raw window titles. Turning this off keeps contexts but not full titles. */
  captureTitles: boolean;
  excludeApps: string[];
  excludeTitlePatterns: string[];
}

export interface FocusConfig {
  preset: FocusPreset;
  weights: FocusWeights;
  minBlockMin: number;
}

export interface UiConfig {
  theme: 'system' | 'light' | 'dark';
  locale: 'en' | 'zh';
  petEnabled: boolean;
  petSkin: string;
  fontScale: number;
  fontFamily: string;
}

export interface RemoteConfig {
  bindHost: string;
  port: number;
  enabled: boolean;
  /** Require a pairing token on every API call, even on localhost. */
  requireAuth: boolean;
}

export interface AttentioConfig {
  /** Config schema version, for future migrations. */
  version: number;
  deviceId: string;
  deviceName: string;
  ai: AiConfig;
  tracking: TrackingConfig;
  focus: FocusConfig;
  ui: UiConfig;
  remote: RemoteConfig;
  /** User classification rules, prepended to the defaults. */
  rules: unknown[];
}

export function defaultConfig(): AttentioConfig {
  const plat = osPlatform();
  return {
    version: 1,
    deviceId: randomUUID(),
    deviceName: `${hostname()} (${plat})`,
    ai: {
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      redaction: 'app',
      dailyReportHour: 21,
      language: 'en',
      maxTokens: 1200,
      temperature: 0.3,
      timeoutSec: 90,
    },
    tracking: {
      idleThresholdSec: 120,
      sampleIntervalMs: 1000,
      processIntervalMs: 5000,
      inventoryIntervalMs: 10_000,
      segmentRetentionDays: 90,
      captureTitles: true,
      // Password managers are excluded by *application*, because that is where
      // their names actually appear — matching these against window titles only
      // (the original design) silently protected nothing.
      excludeApps: [
        '1password',
        'bitwarden',
        'keepass',
        'keepassxc',
        'lastpass',
        'dashlane',
        'enpass',
        'nordpass',
        'protonpass',
        'roboform',
      ],
      // Title patterns are for things a user adds deliberately, e.g. an internal
      // tool whose window title names a client.
      excludeTitlePatterns: [],
    },
    focus: {
      preset: 'balanced',
      weights: { ...DEFAULT_FOCUS_WEIGHTS },
      minBlockMin: 15,
    },
    ui: {
      theme: 'system',
      locale: 'en',
      petEnabled: false,
      petSkin: 'sprout',
      fontScale: 1,
      fontFamily: '',
    },
    remote: {
      bindHost: '0.0.0.0',
      port: 8787,
      enabled: true,
      requireAuth: true,
    },
    rules: [],
  };
}

export function attentioHome(): string {
  return process.env['ATTENTIO_HOME'] ? resolve(process.env['ATTENTIO_HOME']) : join(homedir(), '.attentio');
}

export function paths(home = attentioHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    db: join(home, 'attentio.db'),
    logs: join(home, 'logs'),
    web: join(home, 'web'),
    models: join(home, 'models'),
    exports: join(home, 'exports'),
  };
}

export function ensureHome(home = attentioHome()): void {
  for (const dir of [home, paths(home).logs, paths(home).exports]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge where arrays are replaced wholesale (users expect that). */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** Strip `//` comments and trailing commas so a hand-edited file still parses. */
function relaxedParse(text: string): unknown {
  const withoutComments = text
    .split('\n')
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
        if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

export interface LoadOptions {
  home?: string;
  /** Create the file with defaults when missing. Default true. */
  create?: boolean;
}

export interface LoadedConfig {
  config: AttentioConfig;
  file: string;
  /** True when the file did not exist and defaults were written. */
  created: boolean;
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const home = options.home ?? attentioHome();
  const file = paths(home).config;
  ensureHome(home);

  let config = defaultConfig();
  let created = false;

  if (existsSync(file)) {
    try {
      const parsed = relaxedParse(readFileSync(file, 'utf8'));
      config = deepMerge(config, parsed);
    } catch (error) {
      const broken = `${file}.broken-${Date.now()}`;
      try {
        renameSync(file, broken);
      } catch {
        /* best effort */
      }
      process.emitWarning(
        `attentio: ${file} could not be parsed (${(error as Error).message}); moved to ${broken} and using defaults`,
      );
      config = defaultConfig();
      created = true;
    }
  } else if (options.create !== false) {
    created = true;
  }

  config = applyEnvOverrides(config);
  // A config that lost its id (hand-edited) must get a fresh one, not ''.
  if (!config.deviceId) config.deviceId = randomUUID();

  if (created) saveConfig(config, { home });
  return { config, file, created };
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v !== '0' && v.toLowerCase() !== 'false';
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function applyEnvOverrides(config: AttentioConfig): AttentioConfig {
  const out: AttentioConfig = structuredClone(config);

  const port = envNum('ATTENTIO_PORT');
  if (port !== undefined) out.remote.port = port;
  const host = process.env['ATTENTIO_HOST'];
  if (host) out.remote.bindHost = host;
  const remoteEnabled = envBool('ATTENTIO_REMOTE');
  if (remoteEnabled !== undefined) out.remote.enabled = remoteEnabled;
  const requireAuth = envBool('ATTENTIO_REQUIRE_AUTH');
  if (requireAuth !== undefined) out.remote.requireAuth = requireAuth;

  const aiKey = process.env['ATTENTIO_AI_KEY'];
  if (aiKey) {
    out.ai.apiKey = aiKey;
    out.ai.enabled = true;
  }
  const aiBase = process.env['ATTENTIO_AI_BASE_URL'];
  if (aiBase) out.ai.baseUrl = aiBase;
  const aiModel = process.env['ATTENTIO_AI_MODEL'];
  if (aiModel) out.ai.model = aiModel;
  const aiLang = process.env['ATTENTIO_AI_LANGUAGE'];
  if (aiLang === 'en' || aiLang === 'zh') out.ai.language = aiLang;
  if (envBool('ATTENTIO_AI_ENABLED') !== undefined) out.ai.enabled = envBool('ATTENTIO_AI_ENABLED') ?? out.ai.enabled;

  const locale = process.env['ATTENTIO_LOCALE'];
  if (locale === 'en' || locale === 'zh') {
    out.ui.locale = locale;
    out.ai.language = locale;
  }

  const idle = envNum('ATTENTIO_IDLE_SEC');
  if (idle !== undefined) out.tracking.idleThresholdSec = idle;

  return out;
}

export function saveConfig(config: AttentioConfig, options: { home?: string } = {}): void {
  const home = options.home ?? attentioHome();
  const file = paths(home).config;
  ensureHome(home);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic-ish write: never leave a half-written config behind.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Resolve the focus weights implied by the preset, unless the user customised them. */
export function resolveFocusWeights(config: AttentioConfig): FocusWeights {
  if (config.focus.preset === 'custom') return config.focus.weights;
  return config.focus.weights;
}

/** The public, secret-free projection handed to remote clients. */
export function toPublicSettings(config: AttentioConfig) {
  return {
    ai: {
      enabled: config.ai.enabled,
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      hasApiKey: config.ai.apiKey.length > 0,
      redaction: config.ai.redaction,
      dailyReportHour: config.ai.dailyReportHour,
      language: config.ai.language,
    },
    tracking: {
      idleThresholdSec: config.tracking.idleThresholdSec,
      sampleIntervalMs: config.tracking.sampleIntervalMs,
      processIntervalMs: config.tracking.processIntervalMs,
      segmentRetentionDays: config.tracking.segmentRetentionDays,
      captureTitles: config.tracking.captureTitles,
      excludeApps: config.tracking.excludeApps,
      excludeTitlePatterns: config.tracking.excludeTitlePatterns,
    },
    focus: {
      preset: config.focus.preset,
      weights: config.focus.weights,
      minBlockMin: config.focus.minBlockMin,
    },
    ui: { ...config.ui },
    remote: {
      bindHost: config.remote.bindHost,
      port: config.remote.port,
      enabled: config.remote.enabled,
    },
  };
}
