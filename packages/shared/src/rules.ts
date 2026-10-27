/**
 * Rule engine.
 *
 * Classification is deliberately rule-based rather than learned: a user who
 * disagrees with "Discord is communication" must be able to read the exact rule
 * that decided it, change it, and see the change take effect immediately.
 * Every classification carries the id of the rule that produced it.
 *
 * Rules are evaluated in order and the first match wins, so user rules are
 * simply prepended to the defaults.
 */

import { type CategoryId, categoryProductivity } from './categories.ts';

export interface RuleMatchInput {
  /** Normalized display name, e.g. `VS Code`, `Chrome`. */
  app: string;
  /** Lowercased executable stem without extension, e.g. `code`, `chrome`. */
  stem: string;
  exePath: string;
  /** Raw window title. */
  title: string;
}

export interface CategoryRule {
  id: string;
  category: CategoryId;
  /** Match if the executable stem equals any entry (case-insensitive). */
  exe?: readonly string[];
  /** Match if the normalized display name equals any entry (case-insensitive). */
  app?: readonly string[];
  /** Case-insensitive regex applied to the raw window title. */
  title?: string;
  /** Force a context label instead of the derived one. */
  context?: string;
  /** Override the category's default productivity weight. */
  productivity?: number;
  note?: string;
}

export interface Classification {
  category: CategoryId;
  ruleId: string;
  productivity: number;
  /** Human-readable reason, surfaced in the UI's "why?" popover. */
  note: string;
}

export interface CompiledRule {
  rule: CategoryRule;
  exeSet: Set<string> | null;
  appSet: Set<string> | null;
  titleRe: RegExp | null;
}

/** Rules that only make sense inside a browser are gated on these stems. */
export const BROWSER_STEMS: readonly string[] = [
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'operagx',
  'vivaldi',
  'arc',
  'chromium',
  'thorium',
  'zen',
  'librewolf',
  'waterfox',
  'safari',
  'samsungbrowser',
  'quark',
  '360se',
  '360chrome',
  'sogouexplorer',
  'maxthon',
  'qqbrowser',
  'ucbrowser',
  'liebao',
];

const MAX_REGEX_LEN = 400;

export function compileRules(rules: readonly CategoryRule[]): CompiledRule[] {
  return rules.map((rule) => {
    let titleRe: RegExp | null = null;
    if (rule.title && rule.title.length <= MAX_REGEX_LEN) {
      try {
        titleRe = new RegExp(rule.title, 'i');
      } catch {
        titleRe = null;
      }
    }
    return {
      rule,
      exeSet: rule.exe ? new Set(rule.exe.map((s) => s.toLowerCase())) : null,
      appSet: rule.app ? new Set(rule.app.map((s) => s.toLowerCase())) : null,
      titleRe,
    };
  });
}

export class RuleSet {
  readonly compiled: CompiledRule[];
  private readonly byStem = new Map<string, CompiledRule[]>();

  constructor(rules: readonly CategoryRule[]) {
    this.compiled = compileRules(rules);
    // Index the rules whose *only* discriminator is the exe stem: those are the
    // overwhelmingly common case and let us skip most of the list per sample.
    for (const c of this.compiled) {
      if (c.exeSet && !c.titleRe && !c.appSet && c.exeSet.size <= 8) {
        for (const stem of c.exeSet) {
          const bucket = this.byStem.get(stem);
          if (bucket) bucket.push(c);
          else this.byStem.set(stem, [c]);
        }
      }
    }
  }

  get size(): number {
    return this.compiled.length;
  }

  classify(input: RuleMatchInput): Classification {
    const stem = input.stem.toLowerCase();
    const app = input.app.toLowerCase();

    for (const c of this.compiled) {
      const { rule } = c;
      if (!c.exeSet && !c.appSet && !c.titleRe) continue;
      // `exe` and `app` are two ways of naming the same program — a rule lists
      // both so it works on platforms that give us a path and on those that only
      // give a display name. They are alternatives, and `title` is the extra
      // condition that narrows a rule down to one page or document.
      if ((c.exeSet || c.appSet) && !(c.exeSet?.has(stem) ?? false) && !(c.appSet?.has(app) ?? false)) {
        continue;
      }
      if (c.titleRe && !c.titleRe.test(input.title)) continue;
      return {
        category: rule.category,
        ruleId: rule.id,
        productivity: rule.productivity ?? categoryProductivity(rule.category),
        note: rule.note ?? `matched rule "${rule.id}"`,
      };
    }

    return {
      category: 'unknown',
      ruleId: 'fallback:unknown',
      productivity: categoryProductivity('unknown'),
      note: 'no rule matched this app — classify it to improve your stats',
    };
  }

  /**
   * Every rule that matches, in evaluation order, so `attentio why` can show a
   * user *why* a window landed in a category instead of asking them to trust it.
   * The first entry is the one that actually won.
   */
  matches(input: RuleMatchInput): { id: string; category: string; matchedOn: string[] }[] {
    const stem = input.stem.toLowerCase();
    const app = input.app.toLowerCase();
    const out: { id: string; category: string; matchedOn: string[] }[] = [];

    for (const c of this.compiled) {
      const { rule } = c;
      if (!c.exeSet && !c.appSet && !c.titleRe) continue;
      const matchedOn: string[] = [];
      // Same exe-OR-app / title-AND semantics as classify(), so the explanation
      // `attentio why` prints always agrees with the category actually recorded.
      const exeOk = c.exeSet?.has(stem) ?? false;
      const appOk = c.appSet?.has(app) ?? false;
      if (exeOk) matchedOn.push(`exe=${stem}`);
      if (appOk) matchedOn.push(`app=${app}`);
      if ((c.exeSet || c.appSet) && !exeOk && !appOk) continue;
      if (c.titleRe) {
        if (!c.titleRe.test(input.title)) continue;
        matchedOn.push('title');
      }
      out.push({ id: rule.id, category: rule.category, matchedOn });
    }
    return out;
  }
}

/**
 * Merge user rules in front of the defaults. User rules win outright, which is
 * what people expect when they explicitly classify an app.
 */
export function mergeRules(
  userRules: readonly CategoryRule[],
  defaultRules: readonly CategoryRule[],
): CategoryRule[] {
  const seen = new Set(userRules.map((r) => r.id));
  return [...userRules, ...defaultRules.filter((r) => !seen.has(r.id))];
}
