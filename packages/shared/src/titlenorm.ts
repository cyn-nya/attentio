/**
 * Window-title normalization.
 *
 * "What were you working on" is the question this whole product answers, and the
 * only free-form signal the OS gives us is the window title. Raw titles are
 * however unusable as-is: they embed the app name, dirty-state markers, browser
 * profile suffixes and other chrome. This module reduces a title to a stable
 * `app` plus a meaningful `context` (a project, a document, a page).
 *
 * Two hard rules:
 *   1. Never throw and never return an empty app — there is always a fallback.
 *   2. Never invent information. If we cannot find a context, say so with ''.
 */

import { exeStem, truncate } from './format.ts';
import { BROWSER_STEMS } from './rules.ts';

export interface NormalizedWindow {
  /** Human display name of the application, e.g. `VS Code`. */
  app: string;
  /** Lowercased executable stem, e.g. `code`. Empty when unresolvable. */
  stem: string;
  /** Project / document / page. Empty string when unknown. */
  context: string;
  /** File name or secondary detail, when the app exposes one. */
  detail: string;
  /** True when `app` came from a built-in display-name table. */
  known: boolean;
}

const MAX_CONTEXT = 140;

const DISPLAY_NAMES: Record<string, string> = {
  code: 'VS Code',
  'code-insiders': 'VS Code Insiders',
  codium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  devenv: 'Visual Studio',
  chrome: 'Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  operagx: 'Opera GX',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  chromium: 'Chromium',
  safari: 'Safari',
  explorer: 'File Explorer',
  finder: 'Finder',
  windowsterminal: 'Windows Terminal',
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  conhost: 'Console',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  wps: 'WPS Writer',
  et: 'WPS Spreadsheet',
  wpp: 'WPS Presentation',
  wechat: 'WeChat',
  weixin: 'WeChat',
  wechatappex: 'WeChat (mini program)',
  qq: 'QQ',
  qqnt: 'QQ',
  tim: 'TIM',
  dingtalk: 'DingTalk',
  wxwork: 'WeCom',
  feishu: 'Feishu',
  lark: 'Lark',
  wemeetapp: 'Tencent Meeting',
  idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm',
  webstorm64: 'WebStorm',
  goland64: 'GoLand',
  clion64: 'CLion',
  rider64: 'Rider',
  studio64: 'Android Studio',
  sublime_text: 'Sublime Text',
  'notepad++': 'Notepad++',
  notepad: 'Notepad',
  nvim: 'Neovim',
  vim: 'Vim',
  emacs: 'Emacs',
  zed: 'Zed',
  obsidian: 'Obsidian',
  logseq: 'Logseq',
  typora: 'Typora',
  notion: 'Notion',
  slack: 'Slack',
  discord: 'Discord',
  telegram: 'Telegram',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  'ms-teams': 'Microsoft Teams',
  outlook: 'Outlook',
  spotify: 'Spotify',
  steam: 'Steam',
  unity: 'Unity',
  tuanjie: 'Tuanjie Engine',
  blender: 'Blender',
  figma: 'Figma',
  photoshop: 'Photoshop',
  illustrator: 'Illustrator',
  premiere: 'Premiere Pro',
  afterfx: 'After Effects',
  jianyingpro: 'CapCut',
  potplayermini64: 'PotPlayer',
  vlc: 'VLC',
  mstsc: 'Remote Desktop',
  taskmgr: 'Task Manager',
  systemsettings: 'Settings',
  dwm: 'Desktop Window Manager',
  msedgewebview2: 'WebView2 host',
};

/** Apps whose title layout we understand in detail. */
const VSCODE_STEMS = new Set(['code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf', 'trae', 'positron']);
const VSCODE_SUFFIXES = ['Visual Studio Code - Insiders', 'Visual Studio Code', 'VSCodium', 'Cursor', 'Windsurf', 'Trae', 'Positron'];
const JETBRAINS_STEMS = new Set(['idea64', 'pycharm64', 'webstorm64', 'goland64', 'clion64', 'phpstorm64', 'rubymine64', 'rider64', 'datagrip64', 'dataspell64', 'aqua64', 'rustrover64', 'fleet']);
const JETBRAINS_NAMES = ['IntelliJ IDEA', 'PyCharm', 'WebStorm', 'GoLand', 'CLion', 'PhpStorm', 'RubyMine', 'Rider', 'DataGrip', 'DataSpell', 'Aqua', 'RustRover', 'Fleet', 'Android Studio'];
const OFFICE_SUFFIXES: Record<string, string> = {
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  wps: 'WPS Writer',
  et: 'WPS Spreadsheet',
  wpp: 'WPS Presentation',
  onenote: 'OneNote',
};
const TERMINAL_STEMS = new Set(['windowsterminal', 'wt', 'powershell', 'pwsh', 'cmd', 'conhost', 'openconsole', 'alacritty', 'wezterm', 'kitty', 'mintty', 'git-bash', 'bash', 'zsh', 'fish', 'wsl', 'wslhost', 'mobaxterm', 'tabby', 'hyper', 'terminus', 'iterm2', 'konsole', 'gnome-terminal', 'xterm', 'guake', 'tilix', 'electerm', 'finalshell', 'xshell', 'putty', 'securecrt']);

/** Titles that carry no information at all. */
const NIL_TITLES = new Set([
  '',
  'new tab',
  'newtab',
  'untitled',
  'untitled-1',
  'welcome',
  'start page',
  'about:blank',
  'about:newtab',
  'settings',
  'program manager',
  'default ime',
  'msctfime ui',
]);

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `notepad++` -> `Notepad++`, `totalcmd64` -> `Totalcmd64`. */
export function prettifyStem(stem: string): string {
  if (!stem) return 'Unknown';
  const cleaned = stem.replace(/\.(exe|app|bin|sh|desktop)$/i, '');
  const pretty = cleaned
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
  return pretty || cleaned || 'Unknown';
}

function stripKnownSuffix(title: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    for (const sep of [' — ', ' – ', ' - ', ' —', ' –', ' -']) {
      const tail = sep + suffix;
      if (title.endsWith(tail)) return title.slice(0, -tail.length).trim();
    }
  }
  return title;
}

/** Remove browser chrome: profile suffixes, tab counts, app names. */
export function stripBrowserChrome(title: string, browserName: string): string {
  let t = collapse(title);
  const suffixes = [browserName, 'Google Chrome', 'Chromium', 'Microsoft Edge', 'Mozilla Firefox', 'Firefox', 'Brave', 'Vivaldi', 'Opera GX', 'Opera', 'Safari', 'Zen Browser', 'Zen', 'LibreWolf', 'Waterfox', 'Arc', 'Samsung Internet', 'QQ浏览器', '360安全浏览器', '夸克'];
  // Order matters: Edge titles read "Page and 3 more pages - Personal - Microsoft Edge",
  // so the browser name has to come off before the tab count and profile are
  // at the end of the string where the anchors can see them.
  t = stripKnownSuffix(t, suffixes);
  t = t.replace(/\s+-\s+(Personal|Work|School|Profile \d+)$/i, '');
  t = t.replace(/\s+and \d+ more pages?$/i, '');
  t = stripKnownSuffix(t, suffixes);
  t = t.replace(/\s+-\s+Incognito$/i, ' (incognito)');
  t = t.replace(/\s+-\s+Private Browsing$/i, ' (private)');
  // Chrome prefixes audio/notification glyphs.
  t = t.replace(/^[\u266A\u25B6\u23F8\uD83D\uDD07\uD83C\uDFA4\uD83D\uDCF7\uD83D\uDC49]+\s*/u, '');
  return collapse(t);
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/**
 * Reduce an application's raw title to (context, detail).
 * Exported separately so it can be unit-tested per app family.
 */
export function extractContext(
  stem: string,
  title: string,
  browserName: string,
): { context: string; detail: string } {
  const raw = collapse(title);
  const low = raw.toLowerCase();
  if (NIL_TITLES.has(low)) return { context: '', detail: '' };

  if (BROWSER_STEMS.includes(stem)) {
    return { context: truncate(stripBrowserChrome(raw, browserName), MAX_CONTEXT), detail: '' };
  }

  if (VSCODE_STEMS.has(stem)) {
    let t = stripKnownSuffix(raw, VSCODE_SUFFIXES);
    t = t.replace(/^[\u25CF\u25CB\u2022]\s*/u, ''); // unsaved-changes dot
    t = t.replace(/\s*\((workspace|folder)\)$/i, '');
    const parts = t.split(/\s+[—–-]\s+/).map(collapse).filter(Boolean);
    if (parts.length >= 2) {
      const detail = parts[0] ?? '';
      const context = parts.slice(1).join(' - ');
      return { context: truncate(context, MAX_CONTEXT), detail: truncate(detail, 80) };
    }
    return { context: truncate(t, MAX_CONTEXT), detail: '' };
  }

  if (JETBRAINS_STEMS.has(stem)) {
    const t = stripKnownSuffix(raw, JETBRAINS_NAMES);
    const parts = t.split(/\s+[–—]\s+/).map(collapse).filter(Boolean);
    if (parts.length >= 2) {
      const context = parts[0] ?? '';
      const rest = parts.slice(1).join(' – ');
      const file = rest.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      return { context: truncate(context, MAX_CONTEXT), detail: truncate(file, 80) };
    }
    return { context: truncate(t, MAX_CONTEXT), detail: '' };
  }

  const officeSuffix = OFFICE_SUFFIXES[stem];
  if (officeSuffix) {
    let t = stripKnownSuffix(raw, [officeSuffix]);
    t = t.replace(/\s*[\[(](兼容模式|Compatibility Mode|只读|Read-Only)[\])]\s*/gi, '').trim();
    t = t.replace(/^[*-]\s*/, '');
    return { context: truncate(t, MAX_CONTEXT), detail: '' };
  }

  if (TERMINAL_STEMS.has(stem)) {
    // "user@host: ~/dev/attentio" -> "attentio"; "C:\src\app — PowerShell" -> "app"
    let t = stripKnownSuffix(raw, ['PowerShell', 'Command Prompt', 'Windows PowerShell', 'bash', 'zsh', 'fish', 'Terminal']);
    const m = /^(?:[^\s:]+@[^\s:]+)?\s*:\s*(.+)$/.exec(t);
    const pathPart = m?.[1]?.trim() ?? '';
    if (pathPart && /[\\/~]/.test(pathPart)) {
      const leaf = basename(pathPart.replace(/^~/, ''));
      return { context: truncate(leaf || pathPart, MAX_CONTEXT), detail: truncate(pathPart, 80) };
    }
    if (/^(administrator|admin)?:?\s*$/i.test(t) || low === 'administrator') return { context: '', detail: '' };
    return { context: truncate(t, MAX_CONTEXT), detail: '' };
  }

  // Generic: many apps use "<context> - <App Name>".
  const appName = DISPLAY_NAMES[stem] ?? prettifyStem(stem);
  const stripped = stripKnownSuffix(raw, [appName]);
  if (stripped && stripped.toLowerCase() !== low) {
    return { context: truncate(stripped, MAX_CONTEXT), detail: '' };
  }
  if (low === appName.toLowerCase()) return { context: '', detail: '' };
  return { context: truncate(raw, MAX_CONTEXT), detail: '' };
}

export interface NormalizeInput {
  exePath: string;
  title: string;
  /** Used when `exePath` is unavailable (e.g. macOS/Linux fallbacks). */
  appHint?: string;
}

export function normalizeWindow(input: NormalizeInput): NormalizedWindow {
  const stem = exeStem(input.exePath) || (input.appHint ?? '').toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(DISPLAY_NAMES, stem);
  const app = DISPLAY_NAMES[stem] ?? (input.appHint ? prettifyStem(input.appHint) : prettifyStem(stem));
  const { context, detail } = extractContext(stem, input.title ?? '', DISPLAY_NAMES[stem] ?? app);
  return { app, stem, context, detail, known };
}

export { DISPLAY_NAMES };
