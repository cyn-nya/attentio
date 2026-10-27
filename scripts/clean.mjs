#!/usr/bin/env node
/** Remove build output. Data in ~/.attentio is never touched. */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const targets = [
  'packages/shared/dist',
  'packages/daemon/dist',
  'packages/cli/dist',
  'apps/web/dist',
  'node_modules/.cache',
];

for (const target of targets) {
  rmSync(join(process.cwd(), target), { recursive: true, force: true });
  console.log(`removed ${target}`);
}

console.log('\nYour recorded data in ~/.attentio was left alone.');
