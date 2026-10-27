/**
 * Collector factory: pick the best sensor this machine can actually run.
 *
 * Selection is capability-driven rather than a bare platform switch, because
 * "am I on Linux" is not the interesting question — "can I see the foreground
 * window" is.
 */

import type { CollectorStatus } from '@attentio/shared';

import { DarwinCollector } from './darwin.ts';
import { LinuxCollector } from './linux.ts';
import { NullCollector, type Collector } from './types.ts';
import { Win32Collector } from './win32.ts';

export type { Collector } from './types.ts';
export { NullCollector } from './types.ts';

export interface CreateCollectorOptions {
  /** Force a specific collector id; mainly for tests and `attentio doctor`. */
  force?: string;
}

export async function createCollector(options: CreateCollectorOptions = {}): Promise<Collector> {
  const forced = options.force;
  if (forced === 'null') return new NullCollector('explicitly disabled');

  if (process.platform === 'win32') {
    if (!forced || forced === 'win32') {
      const collector = await Win32Collector.create();
      if (collector) return collector;
      return new NullCollector(
        'koffi could not be loaded, so native Win32 sampling is unavailable. Reinstall with `npm install -g attentio` or set ATTENTIO_COLLECTOR=null to silence this.',
        'win32',
      );
    }
  }

  if (process.platform === 'linux') return new LinuxCollector();
  if (process.platform === 'darwin') return new DarwinCollector();

  return new NullCollector(`no collector implemented for platform "${process.platform}"`);
}

export function summarizeCollectors(statuses: readonly CollectorStatus[]): string {
  return statuses.map((s) => `${s.id}: ${s.health} — ${s.detail}`).join('\n');
}
