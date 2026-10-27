#!/usr/bin/env node
/**
 * Thin launcher.
 *
 * Prefers the compiled `dist` entry, and falls back to the TypeScript sources so
 * that a fresh clone works with no build step at all (Node 22.6+ strips types).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'index.js');
const source = join(here, '..', 'src', 'index.ts');

await import(existsSync(built) ? built : source);
