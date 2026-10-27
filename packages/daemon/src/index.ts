/**
 * @attentio/daemon — the local-first core.
 *
 * Public surface used by the CLI and by embedders:
 *   createCollector()  platform sensor selection
 *   Engine             the sampling loop
 *   Db                 SQLite persistence
 *   loadConfig()       configuration
 */

export * from './config.ts';
export * from './db/index.ts';
export * from './collector/index.ts';
export * from './engine.ts';
