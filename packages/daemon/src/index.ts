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
export * from './analytics.ts';
export * from './server.ts';
// `report.ts` re-declares Locale/RedactionLevel as its own public contract; the
// config types win so there is exactly one name for each concept.
export { renderReportMarkdown, observations, suggestions, buildRedactedPayload, reportPrompts, observedSpan, segmentMinutes } from './report.ts';
export type { ReportBundle, NarrativeOptions, RedactionOptions } from './report.ts';
export * from './ai.ts';
