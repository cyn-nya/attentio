/**
 * The category taxonomy.
 *
 * Design rule (this is a product decision, not an implementation detail):
 * the taxonomy must stay small enough that a user can look at a chart and
 * immediately agree or disagree with it. Ten buckets, one obvious meaning each.
 * Everything a rule cannot place lands in `unknown`, which the UI surfaces as
 * "needs a rule" rather than silently guessing.
 */

import type { FocusGrade } from './types.ts';

export interface CategoryMeta {
  id: string;
  label: string;
  labelZh: string;
  /**
   * Productivity weight in [-1, 1]. Used by the focus scorer as an opinionated
   * default that the user can override per app.
   *  +1 = clearly productive, 0 = neutral, -1 = clearly distracting.
   */
  productivity: number;
  /** Whether the category counts as "on task" for focus ratio purposes. */
  countsAsWork: boolean;
  color: string;
  icon: string;
  blurb: string;
}

export const CATEGORIES = {
  'deep-work': {
    id: 'deep-work',
    label: 'Deep work',
    labelZh: '深度工作',
    productivity: 1,
    countsAsWork: true,
    color: '#4f8cff',
    icon: '⚒️',
    blurb: 'Writing code, prose, design or analysis — the work that compounds.',
  },
  learning: {
    id: 'learning',
    label: 'Learning',
    labelZh: '学习',
    productivity: 0.7,
    countsAsWork: true,
    color: '#8a6cff',
    icon: '📚',
    blurb: 'Courses, tutorials and deliberate study.',
  },
  creative: {
    id: 'creative',
    label: 'Creative',
    labelZh: '创作',
    productivity: 0.7,
    countsAsWork: true,
    color: '#ff7ac6',
    icon: '🎨',
    blurb: 'Media production, image, audio and video editing.',
  },
  reference: {
    id: 'reference',
    label: 'Reference',
    labelZh: '查阅',
    productivity: 0.5,
    countsAsWork: true,
    color: '#3fb6a8',
    icon: '🔎',
    blurb: 'Docs, search, wikis and Q&A — useful, but easy to drift in.',
  },
  communication: {
    id: 'communication',
    label: 'Communication',
    labelZh: '沟通',
    productivity: 0.3,
    countsAsWork: true,
    color: '#f2b53c',
    icon: '💬',
    blurb: 'Chat, mail and meetings. Work, but rarely deep work.',
  },
  admin: {
    id: 'admin',
    label: 'Admin',
    labelZh: '事务',
    productivity: 0.1,
    countsAsWork: false,
    color: '#9aa4b2',
    icon: '🗂️',
    blurb: 'File managers, settings, installers, system utilities.',
  },
  social: {
    id: 'social',
    label: 'Social',
    labelZh: '社交',
    productivity: -0.4,
    countsAsWork: false,
    color: '#ff6b8a',
    icon: '👥',
    blurb: 'Social feeds and timelines.',
  },
  shopping: {
    id: 'shopping',
    label: 'Shopping',
    labelZh: '购物',
    productivity: -0.3,
    countsAsWork: false,
    color: '#e08b4a',
    icon: '🛒',
    blurb: 'Stores, marketplaces and browsing for things to buy.',
  },
  entertainment: {
    id: 'entertainment',
    label: 'Entertainment',
    labelZh: '娱乐',
    productivity: -0.8,
    countsAsWork: false,
    color: '#e5534b',
    icon: '🎮',
    blurb: 'Video, streaming, games. Legitimate — just not work.',
  },
  system: {
    id: 'system',
    label: 'System',
    labelZh: '系统',
    productivity: 0,
    countsAsWork: false,
    color: '#6b7280',
    icon: '⚙️',
    blurb: 'The OS shell, lock screen and background services.',
  },
  idle: {
    id: 'idle',
    label: 'Away',
    labelZh: '离开',
    productivity: 0,
    countsAsWork: false,
    color: '#4b5563',
    icon: '💤',
    blurb: 'No input for longer than the idle threshold.',
  },
  unknown: {
    id: 'unknown',
    label: 'Unclassified',
    labelZh: '未分类',
    productivity: 0,
    countsAsWork: false,
    color: '#a1a1aa',
    icon: '❓',
    blurb: 'No rule matched yet. Assign a category to turn this into signal.',
  },
} as const satisfies Record<string, CategoryMeta>;

export type CategoryId = keyof typeof CATEGORIES;

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

/** Categories in display order: most productive first, unclassified last. */
export const CATEGORY_ORDER: CategoryId[] = [
  'deep-work',
  'learning',
  'creative',
  'reference',
  'communication',
  'admin',
  'social',
  'shopping',
  'entertainment',
  'system',
  'idle',
  'unknown',
];

export function isCategoryId(value: string): value is CategoryId {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, value);
}

/** Never throws: unknown ids degrade to the `unknown` bucket. */
export function categoryMeta(id: string): CategoryMeta {
  return isCategoryId(id) ? CATEGORIES[id] : CATEGORIES.unknown;
}

export function categoryProductivity(id: string): number {
  return categoryMeta(id).productivity;
}

export function categoryColor(id: string): string {
  return categoryMeta(id).color;
}

export function categoryLabel(id: string, locale: 'en' | 'zh' = 'en'): string {
  const meta = categoryMeta(id);
  return locale === 'zh' ? meta.labelZh : meta.label;
}

export function gradeForScore(score: number): FocusGrade {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

export const GRADE_BLURB: Record<FocusGrade, string> = {
  A: 'Long, coherent blocks with little drift.',
  B: 'Solid work, a few interruptions.',
  C: 'Fragmented — lots of switching, little depth.',
  D: 'Attention scattered across distracting or idle time.',
};
