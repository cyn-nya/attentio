/**
 * System-wide load sampling, implemented with Node's own `os` module so it is
 * identical on every platform. Per-process detail is the collector's job; this
 * is only the headline number.
 */

import { cpus, freemem, totalmem, uptime } from 'node:os';

import type { SystemSample } from '@attentio/shared';

interface CpuSnapshot {
  idle: number;
  total: number;
}

function snapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

export class SystemSampler {
  private previous: CpuSnapshot | null = null;

  sample(now: number): SystemSample {
    const current = snapshot();
    let cpuLoad = 0;
    if (this.previous) {
      const idleDelta = current.idle - this.previous.idle;
      const totalDelta = current.total - this.previous.total;
      cpuLoad = totalDelta > 0 ? Math.max(0, Math.min(1, 1 - idleDelta / totalDelta)) : 0;
    }
    this.previous = current;

    const totalBytes = totalmem();
    const free = freemem();
    return {
      ts: now,
      cpuLoad,
      memUsedBytes: totalBytes - free,
      memTotalBytes: totalBytes,
      uptimeSec: uptime(),
    };
  }
}
