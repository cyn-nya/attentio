/**
 * Terminal rendering.
 *
 * No dependency, colour-aware, and careful with alignment: CJK characters are
 * double-width, so a naive `padEnd` misaligns every table that contains Chinese.
 * `displayWidth` accounts for that.
 */

const NO_COLOR = Boolean(process.env['NO_COLOR']) || process.env['TERM'] === 'dumb';
const FORCE_COLOR = Boolean(process.env['FORCE_COLOR']);
const COLOR = FORCE_COLOR || (!NO_COLOR && Boolean(process.stdout.isTTY));

function wrap(open: number, close: number): (text: string) => string {
  return (text: string) => (COLOR ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgBlue: wrap(44, 49),
};

/** Terminal columns of a string, counting East Asian wide characters as two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function padEndWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

export function padStartWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

export function truncateWide(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function heading(text: string): string {
  return `\n${style.bold(text)}\n${style.gray('─'.repeat(Math.min(displayWidth(text), 72)))}\n`;
}

export function keyValue(pairs: [string, string][], indent = '  '): string {
  const width = Math.max(0, ...pairs.map(([key]) => displayWidth(key)));
  return pairs.map(([key, value]) => `${indent}${style.gray(padEndWide(key, width))}  ${value}`).join('\n');
}

export function table(headers: string[], rows: string[][], options: { right?: number[] } = {}): string {
  if (rows.length === 0) return style.dim('  (nothing to show)') + '\n';
  const right = new Set(options.right ?? []);
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const renderRow = (row: string[], headerRow: boolean): string =>
    row
      .map((cell, index) => {
        const text = headerRow ? style.bold(cell) : cell;
        const width = widths[index] ?? 0;
        return right.has(index) ? padStartWide(text, width) : padEndWide(text, width);
      })
      .join('  ')
      .replace(/\s+$/, '');
  return [
    `  ${renderRow(headers, true)}`,
    `  ${style.gray(widths.map((w) => '─'.repeat(w)).join('  '))}`,
    ...rows.map((row) => `  ${renderRow(row, false)}`),
  ].join('\n');
}

/** A horizontal bar. `value` and `max` are in the same unit. */
export function bar(value: number, max: number, width = 24, colour: (t: string) => string = style.cyan): string {
  if (max <= 0) return style.gray('·'.repeat(width));
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  if (filled === 0) return style.gray('·'.repeat(width));
  return `${colour('█'.repeat(filled))}${style.gray('·'.repeat(width - filled))}`;
}

/** A 24-hour activity sparkline using block characters. */
export function sparkline(values: number[], width = 24): string {
  const blocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(1, ...values);
  const sampled: number[] = [];
  if (values.length <= width) {
    sampled.push(...values);
  } else {
    const bucket = values.length / width;
    for (let i = 0; i < width; i++) {
      const slice = values.slice(Math.floor(i * bucket), Math.max(Math.floor((i + 1) * bucket), Math.floor(i * bucket) + 1));
      sampled.push(slice.reduce((sum, v) => sum + v, 0) / Math.max(slice.length, 1));
    }
  }
  return sampled
    .map((value) => {
      if (value <= 0) return blocks[0] as string;
      const index = Math.max(1, Math.min(blocks.length - 1, Math.round((value / max) * (blocks.length - 1))));
      return blocks[index] as string;
    })
    .join('');
}

export function scoreColour(score: number): (text: string) => string {
  if (score >= 75) return style.green;
  if (score >= 55) return style.cyan;
  if (score >= 40) return style.yellow;
  return style.red;
}

export function ok(text: string): string {
  return `${style.green('✔')} ${text}`;
}

export function warn(text: string): string {
  return `${style.yellow('!')} ${text}`;
}

export function fail(text: string): string {
  return `${style.red('✖')} ${text}`;
}

export function info(text: string): string {
  return `${style.blue('i')} ${text}`;
}

export function bullets(items: readonly string[], marker = '·'): string {
  return items.map((item) => `  ${style.gray(marker)} ${item}`).join('\n');
}

/** Wrap text to a width, respecting existing newlines and CJK width. */
export function wrapText(text: string, width = 78, indent = '  '): string {
  return text
    .split('\n')
    .map((line) => {
      if (displayWidth(line) <= width) return `${indent}${line}`;
      const words = line.split(/(\s+)/);
      const out: string[] = [];
      let current = '';
      for (const word of words) {
        if (displayWidth(current + word) > width) {
          out.push(current.trimEnd());
          current = word.trimStart();
        } else {
          current += word;
        }
      }
      if (current.trim()) out.push(current.trimEnd());
      return out.map((part) => `${indent}${part}`).join('\n');
    })
    .join('\n');
}
