/**
 * Does the collector on *this* machine work?
 *
 * The Windows collector is exercised by the daemon checks. This exists for Linux
 * and macOS, whose collectors cannot be started on the machine Attentio is
 * developed on, and it asserts the things that can be checked without a desktop:
 *
 *   * the module loads — an import that throws is the most likely failure, and the
 *     only one that makes the daemon useless rather than merely wrong;
 *   * `status()` is coherent and its capabilities match its health;
 *   * every sample it returns satisfies the invariants the engine relies on.
 *
 * It deliberately does not assert *values*. A CI runner is headless, so no window
 * is focused and nothing is busy; demanding a foreground window there would either
 * fail spuriously or push someone into faking one. What is checked is that the
 * shapes are right and the numbers are not nonsense.
 */

import { createCollector } from '../packages/daemon/src/collector/index.ts';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const now = Date.now();

console.log(`attentio collector check · platform ${process.platform} · node ${process.version}`);
console.log(`  ${process.env['CI'] ? 'running under CI' : 'not running under CI'}`);

let collector;
try {
  collector = await createCollector();
} catch (error) {
  // Nothing below can run, and "it threw on import" is the answer.
  console.log(`  FAIL the collector module loaded — ${(error as Error).message}`);
  console.log(`\nRESULT: FAILED (0/${checks + 1})`);
  process.exit(1);
}

console.log(`collector: ${collector.id}`);
const status = collector.status();

// --- status -----------------------------------------------------------------
check('status.id matches the collector', status.id === collector.id, `${status.id} vs ${collector.id}`);
check(
  'status.platform matches the running platform',
  status.platform === process.platform,
  `${status.platform} vs ${process.platform}`,
);
check('status.health is a known value', ['ok', 'degraded', 'unavailable'].includes(status.health), status.health);
check('status.detail is non-empty', status.detail.trim().length > 0);

// A collector that claims a capability but reports itself unavailable is the
// failure this catches: the UI would show a panel that can never fill.
check(
  'capabilities are internally consistent',
  status.health !== 'unavailable' || !Object.values(status.capabilities).some(Boolean),
  `${status.health} with ${JSON.stringify(status.capabilities)}`,
);

// --- processes --------------------------------------------------------------
const processes = collector.sampleProcesses(now);
check('sampleProcesses returns an array', Array.isArray(processes));
check('sampleProcesses found at least one process', processes.length > 0, `got ${processes.length}`);

let badApp = 0;
let badPid = 0;
let badCpu = 0;
let badMem = 0;
let badTs = 0;
let anonymous = 0;
for (const sample of processes) {
  if (!sample.app || sample.app === 'Unknown') badApp++;
  if (!Number.isInteger(sample.pid) || sample.pid <= 0) badPid++;
  if (!Number.isFinite(sample.cpuPct) || sample.cpuPct < 0) badCpu++;
  if (!Number.isFinite(sample.memBytes) || sample.memBytes < 0) badMem++;
  if (sample.ts !== now) badTs++;
  // The Linux fallback this replaced named processes "Pid1234"; a regression to it
  // would show up here as a burst of those rather than as a crash.
  if (/^Pid\d+$/i.test(sample.app)) anonymous++;
}

check('every process has an app name', badApp === 0, `${badApp} unnamed`);
check('every process has a positive integer pid', badPid === 0, `${badPid} bad`);
check('every process has a non-negative cpu percentage', badCpu === 0, `${badCpu} bad`);
check('every process has a non-negative memory figure', badMem === 0, `${badMem} bad`);
check('every process is stamped with the sample time', badTs === 0, `${badTs} bad`);
check(
  'processes are named, not left as anonymous pids',
  anonymous === 0,
  `${anonymous} of ${processes.length} are named Pid<n>`,
);

// --- window, inventory, system ----------------------------------------------
// All three may legitimately be null on a headless runner; what must hold is that
// they do not throw and that a non-null answer has a coherent shape.
let window = null;
try {
  window = collector.sampleWindow(now);
  check('sampleWindow does not throw', true);
} catch (error) {
  check('sampleWindow does not throw', false, (error as Error).message);
}
if (window) {
  check('the window sample has an app name', Boolean(window.app), JSON.stringify(window));
  check('the window sample is stamped', window.ts === now, String(window.ts));
  check('the window sample has a non-negative idle time', window.idleMs >= 0, String(window.idleMs));
  check('the window sample has a non-negative pid', window.pid >= 0, String(window.pid));
}

let inventory = null;
try {
  inventory = collector.sampleInventory(now);
  check('sampleInventory does not throw', true);
} catch (error) {
  check('sampleInventory does not throw', false, (error as Error).message);
}
if (inventory) {
  check('the inventory apps are unique', new Set(inventory.apps).size === inventory.apps.length);
  check(
    'the inventory window count is not less than its app count',
    inventory.windowCount >= inventory.apps.length,
    `${inventory.windowCount} windows, ${inventory.apps.length} apps`,
  );
}

let system = null;
try {
  system = collector.sampleSystem(now);
  check('sampleSystem does not throw', true);
} catch (error) {
  check('sampleSystem does not throw', false, (error as Error).message);
}
if (system) {
  check('the system sample is stamped', system.ts === now);
  // cpuLoad is documented as 0..1 normalized across cores. A collector that
  // reported a raw load average here would read as several hundred percent.
  check(
    'the system cpu load is normalized to 0..1',
    system.cpuLoad >= 0 && system.cpuLoad <= 1.0001,
    String(system.cpuLoad),
  );
  check('the system sample reports a positive total memory', system.memTotalBytes > 0, String(system.memTotalBytes));
  check(
    'used memory does not exceed total memory',
    system.memUsedBytes >= 0 && system.memUsedBytes <= system.memTotalBytes,
    `${system.memUsedBytes} of ${system.memTotalBytes}`,
  );
  check('the system sample reports a non-negative uptime', system.uptimeSec >= 0, String(system.uptimeSec));
}

// --- what the collector says about itself -----------------------------------
console.log('');
console.log(`  health      ${status.health}`);
console.log(`  detail      ${status.detail}`);
console.log(`  processes   ${processes.length}`);
console.log(`  window      ${window ? `${window.app} "${window.title}"` : 'null (headless is fine)'}`);
console.log(`  inventory   ${inventory ? `${inventory.apps.length} apps / ${inventory.windowCount} windows` : 'null'}`);
console.log(
    `  system      ${system ? `load ${system.cpuLoad.toFixed(3)}, mem ${Math.round(system.memUsedBytes / 1e9)}/${Math.round(system.memTotalBytes / 1e9)} GB` : 'null'}`,
  );
console.log(`  caps        ${JSON.stringify(status.capabilities)}`);

collector.dispose?.();
check('dispose does not throw', true);

console.log('');
console.log(failures === 0 ? `RESULT: all collector checks passed (${checks})` : `RESULT: FAILED (${failures} of ${checks})`);
process.exit(failures > 0 ? 1 : 0);
