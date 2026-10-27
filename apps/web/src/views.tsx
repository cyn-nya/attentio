/**
 * Read-only views: Today, Timeline, Apps, Focus.
 *
 * The layout order is deliberate and the same on every screen size: what the day
 * actually was, then why, then the detail. A phone reading this at a glance
 * should get the honest number before it gets any charts.
 */

import { useMemo, useState } from 'preact/hooks';

import {
  categoryColor,
  categoryLabel,
  clockTime,
  humanBytes,
  humanDuration,
} from '@attentio/shared';
import type { ActivitySegment, DayResponse, FocusBlock, TrendResponse } from '@attentio/shared';

import {
  AccountBar,
  AppRows,
  Card,
  CategoryChip,
  DayPicker,
  Empty,
  FocusFactors,
  HourStrip,
  Legend,
  Meter,
  ScoreRing,
  Stat,
  toDayKey,
} from './ui.tsx';

export function TodayView({
  day,
  data,
  trend,
  locale,
  onDay,
  onOpenApp,
}: {
  day: string;
  data: DayResponse;
  trend: TrendResponse | null;
  locale: 'en' | 'zh';
  onDay: (day: string) => void;
  onOpenApp: (app: string) => void;
}) {
  const stats = data.stats;
  const zh = locale === 'zh';
  const accounted = stats.activeMs + stats.idleMs;
  const peak = Math.max(1, ...stats.apps.map((app) => app.foregroundMs + app.backgroundMs));

  return (
    <>
      <Card action={<DayPicker value={day} onChange={onDay} />} title={zh ? '这一天' : 'The day'}>
        {stats.apps.length === 0 && stats.idleMs === 0 ? (
          <Empty>
            {zh
              ? '这一天还没有记录。运行 `attentio start`，数据会自己长出来。'
              : 'Nothing recorded yet. Run `attentio start` and the data builds itself.'}
          </Empty>
        ) : (
          <>
            <div class="stat-row">
              <Stat
                label={zh ? '主动使用' : 'engaged'}
                value={humanDuration(stats.activeMs, { compact: true })}
                sub={`${Math.round((stats.activeMs / Math.max(accounted, 1)) * 100)}%`}
                tone="good"
              />
              <Stat
                label={zh ? '后台工作' : 'background'}
                value={humanDuration(stats.backgroundMs, { compact: true })}
                sub={`${Math.round((stats.backgroundMs / Math.max(accounted, 1)) * 100)}%`}
              />
              <Stat
                label={zh ? '离开' : 'away'}
                value={humanDuration(stats.idleMs, { compact: true })}
                sub={`${Math.round((stats.idleMs / Math.max(accounted, 1)) * 100)}%`}
                tone="muted"
              />
            </div>
            <AccountBar active={stats.activeMs} background={stats.backgroundMs} away={stats.idleMs} />
            <Legend
              entries={[
                { label: zh ? '主动使用' : 'engaged', colour: 'var(--good)' },
                { label: zh ? '后台工作' : 'background', colour: 'var(--accent)' },
                { label: zh ? '离开' : 'away', colour: 'var(--muted)' },
              ]}
            />
            <p class="muted small">
              {stats.firstSeen
                ? `${clockTime(stats.firstSeen)} – ${clockTime(stats.lastSeen)} · ${stats.switches} ${
                    zh ? '次切换' : 'switches'
                  } · ${zh ? '峰值内存' : 'peak memory'} ${humanBytes(stats.peakMemBytes)}`
                : ''}
            </p>
          </>
        )}
      </Card>

      {stats.apps.length > 0 && (
        <Card title={zh ? '专注度' : 'Focus'}>
          <div class="focus-layout">
            <ScoreRing
              score={stats.focus.score}
              grade={stats.focus.grade}
              confidence={stats.focus.confidence}
            />
            <div class="focus-body">
              {stats.focus.notes.length > 0 && (
                <ul class="notes">
                  {stats.focus.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <FocusFactors factors={stats.focus.factors} labels={zh} />
        </Card>
      )}

      <Card title={zh ? '时段分布' : 'When'}>
        <HourStrip hours={stats.hours} value={(hour) => hour.foregroundMs} />
        <Legend
          entries={[
            { label: zh ? '前台分钟数，0–23 时' : 'foreground minutes, 0h–23h', colour: 'var(--accent)' },
          ]}
        />
      </Card>

      {stats.apps.length > 0 && (
        <Card title={zh ? '时间去了哪里' : 'Where the time went'}>
          <Legend
            entries={[
              { label: zh ? '前台' : 'foreground', colour: 'var(--good)' },
              { label: zh ? '后台' : 'background', colour: 'var(--accent)' },
            ]}
          />
          <AppRows apps={stats.apps.slice(0, 10)} locale={locale} peak={peak} onSelect={onOpenApp} />
        </Card>
      )}

      {stats.categories.length > 0 && (
        <Card title={zh ? '分类占比' : 'By category'}>
          <ul class="cat-list">
            {stats.categories.slice(0, 8).map((entry) => (
              <li key={entry.category}>
                <Meter
                  value={entry.ms}
                  max={Math.max(...stats.categories.map((c) => c.ms))}
                  colour={categoryColor(entry.category)}
                  label={categoryLabel(entry.category, locale)}
                  right={`${humanDuration(entry.ms, { compact: true })} · ${Math.round(entry.share * 100)}%`}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {trend && trend.days.length > 1 && <TrendCard trend={trend} locale={locale} />}

      {data.perDevice.length > 1 && (
        <Card title={zh ? '各设备' : 'Per device'}>
          <ul class="rows">
            {data.perDevice.map((deviceStats) => {
              const device = data.devices.find((entry) => entry.id === deviceStats.deviceId);
              return (
                <li key={deviceStats.deviceId} class="row">
                  <div class="row-main">
                    <span class="row-name">{device?.name ?? deviceStats.deviceId.slice(0, 8)}</span>
                    <span class="muted small">
                      {humanDuration(deviceStats.activeMs, { compact: true })} engaged ·{' '}
                      {humanDuration(deviceStats.backgroundMs, { compact: true })} background
                    </span>
                  </div>
                  <div class="row-nums">
                    <span>{deviceStats.focus.score}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}

export function TrendCard({ trend, locale }: { trend: TrendResponse; locale: 'en' | 'zh' }) {
  const zh = locale === 'zh';
  const peak = Math.max(1, ...trend.days.map((point) => point.activeMs));
  return (
    <Card title={zh ? `最近 ${trend.days.length} 天` : `Last ${trend.days.length} days`}>
      <div class="trend">
        {trend.days.map((point) => (
          <div class="trend-col" key={point.day} title={`${point.day} — ${humanDuration(point.activeMs)}`}>
            <div class="trend-bar-wrap">
              <div
                class="trend-bar"
                style={{
                  height: `${(point.activeMs / peak) * 100}%`,
                  background: point.score > 0 ? scoreColour(point.score) : 'var(--muted)',
                }}
              />
            </div>
            <span class="trend-label">{point.day.slice(8)}</span>
          </div>
        ))}
      </div>
      <p class="muted small">
        {zh ? '柱高＝主动使用时间，颜色＝专注分' : 'bar height = engaged time, colour = focus score'}
      </p>
    </Card>
  );
}

function scoreColour(score: number): string {
  if (score >= 75) return 'var(--good)';
  if (score >= 55) return 'var(--accent)';
  if (score >= 40) return 'var(--warn)';
  return 'var(--bad)';
}

export function TimelineView({
  day,
  segments,
  truncated,
  locale,
  onDay,
}: {
  day: string;
  segments: ActivitySegment[];
  truncated: boolean;
  locale: 'en' | 'zh';
  onDay: (day: string) => void;
}) {
  const zh = locale === 'zh';
  const [filter, setFilter] = useState('');

  // The timeline is the one place where the honest thing is to show *every*
  // segment, including short ones; we group by hour so it stays readable.
  const grouped = useMemo(() => {
    const buckets = new Map<number, ActivitySegment[]>();
    for (const segment of segments) {
      const hour = new Date(segment.start).getHours();
      const list = buckets.get(hour);
      if (list) list.push(segment);
      else buckets.set(hour, [segment]);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([hour, list]) => ({
        hour,
        segments: list
          .filter(
            (segment) =>
              !filter ||
              segment.app.toLowerCase().includes(filter.toLowerCase()) ||
              segment.context.toLowerCase().includes(filter.toLowerCase()),
          )
          .sort((a, b) => b.start - a.start),
      }))
      .filter((group) => group.segments.length > 0);
  }, [segments, filter]);

  return (
    <Card
      action={<DayPicker value={day} onChange={onDay} />}
      title={zh ? '时间线' : 'Timeline'}
    >
      <input
        class="filter"
        type="search"
        placeholder={zh ? '筛选程序或窗口' : 'Filter by app or window'}
        value={filter}
        onInput={(event) => setFilter((event.currentTarget as HTMLInputElement).value)}
      />
      {truncated && (
        <p class="muted small">
          {zh ? '数据过多，只显示最新的一部分。' : 'Truncated — only the most recent segments are shown.'}
        </p>
      )}
      {grouped.length === 0 ? (
        <Empty>{zh ? '没有匹配的记录。' : 'No matching segments.'}</Empty>
      ) : (
        grouped.map((group) => (
          <div class="tl-hour" key={group.hour}>
            <h3>{String(group.hour).padStart(2, '0')}:00</h3>
            <ul class="tl-list">
              {group.segments.map((segment) => (
                <li key={`${segment.start}-${segment.app}-${segment.context}`}>
                  <span
                    class="tl-colour"
                    style={{ background: categoryColor(segment.category) }}
                    aria-hidden="true"
                  />
                  <div class="tl-main">
                    <div class="tl-head">
                      <span class="row-name">{segment.app}</span>
                      <span class="muted small">
                        {clockTime(segment.start)} ·{' '}
                        {humanDuration(segment.end - segment.start, { compact: true })}
                      </span>
                    </div>
                    {segment.context && <p class="tl-context">{segment.context}</p>}
                    <div class="tl-tags">
                      <CategoryChip category={segment.category} locale={locale} />
                      {segment.detail && <span class="muted small">{segment.detail}</span>}
                      {segment.idleEnd && <span class="muted small">{zh ? '以离开结束' : 'ended idle'}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Card>
  );
}

export function AppsView({
  data,
  locale,
  filter,
  onFilter,
}: {
  data: DayResponse;
  locale: 'en' | 'zh';
  filter: string;
  onFilter: (value: string) => void;
}) {
  const zh = locale === 'zh';
  const stats = data.stats;
  const apps = stats.apps.filter(
    (app) => !filter || app.app.toLowerCase().includes(filter.toLowerCase()),
  );
  const peak = Math.max(1, ...stats.apps.map((app) => app.foregroundMs + app.backgroundMs));

  return (
    <>
      <Card title={zh ? '程序' : 'Apps'}>
        <input
          class="filter"
          type="search"
          placeholder={zh ? '筛选' : 'Filter'}
          value={filter}
          onInput={(event) => onFilter((event.currentTarget as HTMLInputElement).value)}
        />
        {apps.length === 0 ? (
          <Empty>{zh ? '没有匹配的程序。' : 'No matching apps.'}</Empty>
        ) : (
          <AppRows apps={apps} locale={locale} peak={peak} />
        )}
      </Card>

      {apps.some((app) => app.contexts.length > 0) && (
        <Card title={zh ? '窗口与页面明细' : 'Windows and pages'}>
          <ul class="ctx-list">
            {apps
              .flatMap((app) => app.contexts.map((context) => ({ app: app.app, ...context })))
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 40)
              .map((entry) => (
                <li key={`${entry.app}-${entry.context}`}>
                  <span class="row-name">{entry.context || (zh ? '(无标题)' : '(untitled)')}</span>
                  <span class="muted small">
                    {entry.app} · {humanDuration(entry.ms, { compact: true })}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </>
  );
}

export function FocusView({
  day,
  blocks,
  minBlockMs,
  locale,
  onDay,
}: {
  day: string;
  blocks: FocusBlock[];
  minBlockMs: number;
  locale: 'en' | 'zh';
  onDay: (day: string) => void;
}) {
  const zh = locale === 'zh';
  const longest = Math.max(0, ...blocks.map((block) => block.activeMs));
  return (
    <Card
      action={<DayPicker value={day} onChange={onDay} />}
      title={zh ? '专注块' : 'Focus blocks'}
    >
      <p class="muted small">
        {zh
          ? `只显示连续专注超过 ${Math.round(minBlockMs / 60000)} 分钟的段落。短切换不算破坏专注。`
          : `Only stretches longer than ${Math.round(minBlockMs / 60000)} minutes are shown — brief switches do not break focus.`}
      </p>
      {blocks.length === 0 ? (
        <Empty>{zh ? '这一天没有形成明显的专注块。' : 'No sustained focus blocks on this day.'}</Empty>
      ) : (
        <ul class="block-list">
          {blocks.map((block) => (
            <li key={block.start}>
              <div class="block-head">
                <strong>
                  {clockTime(block.start)} – {clockTime(block.end)}
                </strong>
                <span>{humanDuration(block.activeMs, { compact: true })}</span>
              </div>
              <Meter
                value={block.activeMs}
                max={longest}
                colour={categoryColor(block.category)}
                label={block.label || categoryLabel(block.category, locale)}
              />
              <div class="tl-tags">
                <CategoryChip category={block.category} locale={locale} />
                {block.apps.slice(0, 4).map((app) => (
                  <span class="muted small" key={app}>
                    {app}
                  </span>
                ))}
              </div>
              {block.contexts.length > 0 && (
                <p class="tl-context">
                  {block.contexts
                    .slice(0, 3)
                    .map((context) => context.context)
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export { toDayKey };
