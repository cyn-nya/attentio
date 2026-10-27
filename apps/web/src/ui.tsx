/**
 * Small presentation primitives.
 *
 * Everything visual is hand-rolled SVG and CSS rather than a chart library: the
 * whole dashboard ships in one small bundle, works offline, and the shapes here
 * (a 24-bar hour strip, a ring, a stacked account bar) are not what a general
 * charting library is good at anyway.
 */

import type { ComponentChildren, JSX } from 'preact';

import { categoryColor, categoryLabel, humanDuration, percent } from '@attentio/shared';

export function Card({
  title,
  action,
  children,
  class: className,
}: {
  title?: string;
  action?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`card${className ? ` ${className}` : ''}`}>
      {(title || action) && (
        <header class="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'bad' | 'muted';
}) {
  return (
    <div class={`stat${tone ? ` tone-${tone}` : ''}`}>
      <span class="stat-label">{label}</span>
      <strong class="stat-value">{value}</strong>
      {sub && <span class="stat-sub">{sub}</span>}
    </div>
  );
}

/** A labelled horizontal proportion bar. */
export function Meter({
  value,
  max,
  colour,
  label,
  right,
}: {
  value: number;
  max: number;
  colour?: string;
  label?: string;
  right?: string;
}) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div class="meter">
      {(label || right) && (
        <div class="meter-head">
          {label && <span>{label}</span>}
          {right && <span class="muted">{right}</span>}
        </div>
      )}
      <div class="meter-track">
        <div class="meter-fill" style={{ width: `${width}%`, background: colour ?? 'var(--accent)' }} />
      </div>
    </div>
  );
}

/** 24-hour activity strip. One bar per hour, height is relative to the peak. */
export function HourStrip({
  hours,
  value,
}: {
  hours: { hour: number; foregroundMs: number; topApp?: string }[];
  value: (hour: { hour: number; foregroundMs: number; topApp?: string }) => number;
}) {
  const values = hours.map(value);
  const peak = Math.max(1, ...values);
  const busiest = values.indexOf(peak);
  return (
    <div class="hour-strip" role="img" aria-label="Activity by hour of day">
      {hours.map((hour, index) => (
        <div
          key={hour.hour}
          class={`hour${index === busiest && peak > 0 ? ' peak' : ''}`}
          title={`${String(hour.hour).padStart(2, '0')}:00 — ${humanDuration(values[index] ?? 0)}${hour.topApp ? ` · ${hour.topApp}` : ''}`}
        >
          <div class="hour-fill" style={{ height: `${((values[index] ?? 0) / peak) * 100}%` }} />
          {index % 3 === 0 && <span class="hour-tick">{hour.hour}</span>}
        </div>
      ))}
    </div>
  );
}

/** Focus score ring. */
export function ScoreRing({ score, grade, confidence }: { score: number; grade: string; confidence: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  const tone = score >= 75 ? 'var(--good)' : score >= 55 ? 'var(--accent)' : score >= 40 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div class="ring-wrap">
      <svg viewBox="0 0 128 128" class="ring" role="img" aria-label={`Focus score ${score} of 100`}>
        <circle cx="64" cy="64" r={radius} fill="none" stroke="var(--ring-track)" stroke-width="11" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke={tone}
          stroke-width="11"
          stroke-linecap="round"
          stroke-dasharray={`${filled} ${circumference}`}
          transform="rotate(-90 64 64)"
        />
        <text x="64" y="62" class="ring-score" text-anchor="middle">
          {score}
        </text>
        <text x="64" y="82" class="ring-grade" text-anchor="middle">
          {grade}
        </text>
      </svg>
      <span class="muted small">confidence {Math.round(confidence * 100)}%</span>
    </div>
  );
}

/** Per-factor focus breakdown with the plain-language evidence. */
export function FocusFactors({
  factors,
  labels,
}: {
  factors: { id: string; label: string; labelZh?: string; value: number; weight: number; contribution: number; detail?: string }[];
  labels: boolean;
}) {
  return (
    <ul class="factors">
      {factors.map((factor) => (
        <li key={factor.id}>
          <div class="factor-row">
            <span class="factor-name">{labels && factor.labelZh ? factor.labelZh : factor.label}</span>
            <span class="muted small">
              ×{factor.weight} → {factor.contribution >= 0 ? '+' : ''}
              {factor.contribution.toFixed(1)}
            </span>
          </div>
          <Meter value={factor.value * 100} max={100} />
          {factor.detail && <p class="factor-detail">{factor.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Stacked engaged / background / away bar. */
export function AccountBar({ active, background, away }: { active: number; background: number; away: number }) {
  const total = Math.max(1, active + background + away);
  const segment = (value: number, colour: string, label: string) => (
    <div
      class="account-segment"
      style={{ width: `${(value / total) * 100}%`, background: colour }}
      title={`${label}: ${humanDuration(value)}`}
    />
  );
  return (
    <div class="account-bar" role="img" aria-label="Time split between engaged, background and away">
      {segment(active, 'var(--good)', 'engaged')}
      {segment(background, 'var(--accent)', 'background')}
      {segment(away, 'var(--muted)', 'away')}
    </div>
  );
}

export function CategoryChip({ category, locale }: { category: string; locale: 'en' | 'zh' }) {
  return (
    <span class="chip" style={{ borderColor: categoryColor(category) }}>
      <span class="dot" style={{ background: categoryColor(category) }} />
      {categoryLabel(category, locale)}
    </span>
  );
}

/** App list rows: foreground / background split, with a proportional bar. */
export function AppRows({
  apps,
  locale,
  peak,
  onSelect,
}: {
  apps: { app: string; category: string; foregroundMs: number; backgroundMs: number; cpuMs: number; switches: number }[];
  locale: 'en' | 'zh';
  peak: number;
  onSelect?: (app: string) => void;
}) {
  return (
    <ul class="rows">
      {apps.map((app) => (
        <li
          key={app.app}
          class={onSelect ? 'row tappable' : 'row'}
          onClick={onSelect ? () => onSelect(app.app) : undefined}
        >
          <div class="row-main">
            <div class="row-title">
              <span class="row-name">{app.app}</span>
              <CategoryChip category={app.category} locale={locale} />
            </div>
            <div class="split">
              <div class="split-fg" style={{ width: `${(app.foregroundMs / peak) * 100}%` }} />
              <div class="split-bg" style={{ width: `${(app.backgroundMs / peak) * 100}%` }} />
            </div>
          </div>
          <div class="row-nums">
            <span>{humanDuration(app.foregroundMs, { compact: true })}</span>
            {app.backgroundMs > 0 && <span class="muted">+{humanDuration(app.backgroundMs, { compact: true })}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Legend({ entries }: { entries: { label: string; colour: string }[] }) {
  return (
    <div class="legend">
      {entries.map((entry) => (
        <span key={entry.label}>
          <span class="dot" style={{ background: entry.colour }} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div class="spinner" role="status">
      <span class="spinner-dot" />
      {label && <span class="muted">{label}</span>}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const hint = error instanceof Error && 'hint' in error ? (error as { hint?: string }).hint : undefined;
  return (
    <div class="error-note">
      <strong>{error.message}</strong>
      {hint && <p class="muted small">{hint}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div class="tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          class={value === option.id ? 'tab active' : 'tab'}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** "3h 20m of 8h" style ratio text. */
export function ratioText(part: number, whole: number): string {
  return `${percent(part, whole, 0)}`;
}

export function DayPicker({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const shift = (days: number) => {
    const date = new Date(`${value}T12:00:00`);
    date.setDate(date.getDate() + days);
    onChange(toDayKey(date));
  };
  return (
    <div class="day-picker">
      <button type="button" aria-label="Previous day" onClick={() => shift(-1)}>
        ‹
      </button>
      <input
        type="date"
        value={value}
        max={toDayKey(new Date())}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
      />
      <button
        type="button"
        aria-label="Next day"
        disabled={value >= toDayKey(new Date())}
        onClick={() => shift(1)}
      >
        ›
      </button>
    </div>
  );
}

/**
 * Local calendar day key.
 *
 * Days are local calendar days, matching `dayBounds()` in the daemon. A 4am
 * boundary for late-night work is planned (see docs/ROADMAP.md) but must be
 * implemented in the daemon first: a client that shifts the date on its own just
 * asks for a day the engine never wrote.
 */
export function toDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
