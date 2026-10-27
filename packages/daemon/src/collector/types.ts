/**
 * The collector contract.
 *
 * A collector answers four questions about the machine, each on its own
 * schedule. Everything is pull-based so the engine owns the timing and a slow
 * platform call can never block the sampling loop indefinitely.
 *
 * Capability reporting is not decoration: on Wayland or without macOS
 * Accessibility permission a collector genuinely cannot see the foreground
 * window, and the UI must say "we are half blind here" instead of silently
 * charting zeros.
 */

import type {
  CollectorStatus,
  Platform,
  ProcessSample,
  SystemSample,
  WindowInventorySample,
  WindowSample,
} from '@attentio/shared';

export interface Collector {
  readonly id: string;
  readonly platform: Platform;
  /**
   * Sampling cadence this collector can sustain. Windows FFI is cheap enough
   * for 1 Hz; subprocess-based collectors ask for 2 s so they do not spend the
   * machine's CPU measuring it.
   */
  readonly recommendedSampleIntervalMs?: number;
  /** What this collector can and cannot observe on this machine. */
  status(): CollectorStatus;
  /** Release OS resources. */
  dispose(): void;
  sampleWindow(now: number): WindowSample | null;
  sampleProcesses(now: number): ProcessSample[];
  sampleInventory(now: number): WindowInventorySample | null;
  sampleSystem(now: number): SystemSample | null;
}

export function capabilities(
  overrides: Partial<CollectorStatus['capabilities']> = {},
): CollectorStatus['capabilities'] {
  return {
    foregroundWindow: false,
    windowTitles: false,
    idleTime: false,
    perProcessCpu: false,
    perProcessMemory: false,
    backgroundInventory: false,
    inputActivity: false,
    ...overrides,
  };
}

/** A collector that reports nothing but stays honest about it. */
export class NullCollector implements Collector {
  readonly id = 'null';
  readonly platform: Platform;
  private readonly reason: string;

  constructor(reason: string, platform: Platform = 'unknown') {
    this.reason = reason;
    this.platform = platform;
  }

  status(): CollectorStatus {
    return {
      id: this.id,
      platform: this.platform,
      health: 'unavailable',
      detail: this.reason,
      capabilities: capabilities(),
    };
  }

  dispose(): void {
    /* nothing to release */
  }

  sampleWindow(): WindowSample | null {
    return null;
  }

  sampleProcesses(): ProcessSample[] {
    return [];
  }

  sampleInventory(): WindowInventorySample | null {
    return null;
  }

  sampleSystem(): SystemSample | null {
    return null;
  }
}
