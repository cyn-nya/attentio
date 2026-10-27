/**
 * @attentio/shared — pure domain logic shared by the daemon, the CLI and the web UI.
 *
 * Nothing in this package performs I/O, so it is safe to import from a browser
 * bundle as well as from Node.
 */

export * from './types.ts';
export * from './categories.ts';
export * from './rules.ts';
export * from './defaultRules.ts';
export * from './titlenorm.ts';
export * from './time.ts';
export * from './format.ts';
export * from './focus.ts';
export * from './accumulator.ts';
export * from './aggregate.ts';
export * from './taskparse.ts';
export * from './api.ts';
