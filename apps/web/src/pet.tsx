/**
 * The desktop pet.
 *
 * A mascot is the cheapest way to make this data present without being
 * annoying: it lives in a corner, it never steals focus, and its face is the
 * summary. The mood is derived from real measurements — current category,
 * how long the current stretch has lasted, how fragmented the day has been —
 * rather than being decorative.
 *
 * The pet is also allowed to say nothing. A mascot that always has a tip to
 * offer gets muted within a day.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { humanDuration } from '@attentio/shared';
import type { DayStats, LiveStatus } from '@attentio/shared';

export type Skin = 'sprout' | 'cat' | 'blob' | 'robot';

export type Mood =
  | 'focused'
  | 'working'
  | 'drifting'
  | 'distracted'
  | 'away'
  | 'idle'
  | 'celebrating';

const CATEGORY_MOOD: Record<string, Mood> = {
  'deep-work': 'focused',
  learning: 'focused',
  creative: 'focused',
  reference: 'working',
  communication: 'working',
  admin: 'working',
  system: 'idle',
  social: 'drifting',
  shopping: 'drifting',
  entertainment: 'distracted',
  idle: 'away',
  unknown: 'working',
};

export interface PetInput {
  live: LiveStatus | null;
  stats: DayStats | null;
  locale: 'en' | 'zh';
  skin: Skin;
  size: number;
}

/**
 * Decide the mood from the measurements we actually have. Order matters: being
 * away beats everything, and a long undistracted stretch beats the app's
 * category, because that is the thing worth celebrating.
 */
export function deriveMood(input: PetInput): { mood: Mood; message: string } {
  const { live, stats, locale } = input;
  const zh = locale === 'zh';

  if (!live || !live.current) {
    const idleMs = stats?.idleMs ?? 0;
    if (idleMs > 30 * 60_000) {
      return { mood: 'away', message: zh ? '你不在，我也眯一会儿。' : 'Away. Waking me when you are back.' };
    }
    return { mood: 'idle', message: zh ? '在等你开始。' : 'Waiting for you to start.' };
  }

  if (live.away) {
    return { mood: 'away', message: zh ? '这段时间算离开。' : 'Counting this as away.' };
  }

  const category = live.current.category;
  const stretchMs = Date.now() - live.current.since;
  const mood = CATEGORY_MOOD[category] ?? 'working';

  const continuity = stats?.focus.factors.find((factor) => factor.id === 'continuity')?.value ?? 0;
  if (stretchMs > 45 * 60_000 && (category === 'deep-work' || category === 'creative')) {
    return {
      mood: 'celebrating',
      message: zh
        ? `${live.current.app} 连续 ${humanDuration(stretchMs, { compact: true })} 没被打断。`
        : `${humanDuration(stretchMs, { compact: true })} uninterrupted in ${live.current.app}.`,
    };
  }

  if (mood === 'focused') {
    return {
      mood: 'focused',
      message: zh
        ? `${live.current.app} · ${humanDuration(stretchMs, { compact: true })}`
        : `${live.current.app} · ${humanDuration(stretchMs, { compact: true })}`,
    };
  }

  if (mood === 'distracted') {
    const spent = stats?.apps.find((app) => app.app === live.current?.app)?.foregroundMs ?? 0;
    return {
      mood: 'distracted',
      message:
        spent > 30 * 60_000
          ? zh
            ? `今天已经在这里花了 ${humanDuration(spent, { compact: true })}。`
            : `${humanDuration(spent, { compact: true })} here today.`
          : zh
            ? '这是休息，还是逃避？你说了算。'
            : 'A break, or avoidance? Your call.',
    };
  }

  if (mood === 'drifting') {
    return {
      mood: 'drifting',
      message: zh ? '漫无目的地划。' : 'Scrolling without a destination.',
    };
  }

  if (continuity < 40 && (stats?.switches ?? 0) > 20) {
    return {
      mood: 'drifting',
      message: zh ? `今天切了 ${stats?.switches} 次窗口。` : `${stats?.switches} window switches today.`,
    };
  }

  return {
    mood: 'working',
    message: zh ? `${live.current.app}` : `${live.current.app}`,
  };
}

const FACES: Record<Skin, Record<Mood, { body: string; face: string }>> = {
  sprout: {
    focused: { body: '#2f9e6e', face: '(-_-)' },
    working: { body: '#3aa377', face: '(o_o)' },
    drifting: { body: '#4b8f7a', face: '(~_~)' },
    distracted: { body: '#8d7a3a', face: '(>_<)' },
    away: { body: '#4a5a63', face: '(-.-)zZ' },
    idle: { body: '#5a7a6a', face: '(._.)' },
    celebrating: { body: '#54c78a', face: '(^o^)' },
  },
  cat: {
    focused: { body: '#8a6ad1', face: '=^._.^=' },
    working: { body: '#9a7ae1', face: '=^o.o^=' },
    drifting: { body: '#7a6aa1', face: '=^~.~^=' },
    distracted: { body: '#a1863a', face: '=^>.<^=' },
    away: { body: '#5a5a6a', face: '=^-.-^=zZ' },
    idle: { body: '#6a6a8a', face: '=^._.^=' },
    celebrating: { body: '#b08aff', face: '=^◕‿◕^=' },
  },
  blob: {
    focused: { body: '#2f7f9e', face: '(•_•)' },
    working: { body: '#3a8fae', face: '(•_•)' },
    drifting: { body: '#4b8f9a', face: '(•~•)' },
    distracted: { body: '#9e8a3a', face: '(>_<)' },
    away: { body: '#4a5a63', face: '(–_–)zZ' },
    idle: { body: '#5a6a7a', face: '(•_•)' },
    celebrating: { body: '#54b8d8', face: '(★‿★)' },
  },
  robot: {
    focused: { body: '#6a7a8a', face: '[O_O]' },
    working: { body: '#7a8a9a', face: '[o_o]' },
    drifting: { body: '#7a8a7a', face: '[~_~]' },
    distracted: { body: '#9a8a4a', face: '[>_<]' },
    away: { body: '#4a5a63', face: '[-_-]zZ' },
    idle: { body: '#5a6a7a', face: '[._.]' },
    celebrating: { body: '#7ac8a8', face: '[^_^]' },
  },
};

const POSITION_KEY = 'attentio.pet.position';

export function Pet({
  live,
  stats,
  locale,
  skin,
  size,
  onOpenSettings,
}: PetInput & { onOpenSettings?: () => void }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('attentio.pet.hidden') === '1';
    } catch {
      return false;
    }
  });
  const [position, setPosition] = useState(() => readPosition());
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const { mood, message } = useMemo(
    () => deriveMood({ live, stats, locale, skin, size }),
    [live, stats, locale, skin, size],
  );

  // Only speak occasionally. A mascot that narrates every change is noise.
  useEffect(() => {
    setBubbleOpen(false);
    const timer = window.setTimeout(() => setBubbleOpen(true), 900);
    return () => window.clearTimeout(timer);
  }, [mood, message]);

  const persistHidden = (value: boolean) => {
    setHidden(value);
    try {
      localStorage.setItem('attentio.pet.hidden', value ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag.current) return;
    const next = {
      x: Math.max(4, Math.min(window.innerWidth - size - 4, event.clientX - drag.current.dx)),
      y: Math.max(4, Math.min(window.innerHeight - size - 4, event.clientY - drag.current.dy)),
    };
    setPosition(next);
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    writePosition(position);
  };

  if (hidden) {
    return (
      <button type="button" class="pet-restore" onClick={() => persistHidden(false)} title="Show the pet">
        🐣
      </button>
    );
  }

  const face = FACES[skin][mood];
  const scale = size / 96;

  return (
    <div
      class={`pet mood-${mood}`}
      style={{ left: `${position.x}px`, top: `${position.y}px`, width: `${size}px` }}
    >
      {bubbleOpen && message && (
        <div class="pet-bubble" role="status">
          {message}
        </div>
      )}
      <svg
        viewBox="0 0 96 96"
        width={size}
        height={size}
        class="pet-body"
        role="img"
        aria-label={`Desktop pet, mood ${mood}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Antenna / sprout */}
        {skin === 'sprout' && (
          <path d="M48 20 C48 10 56 6 62 8 C58 16 54 20 48 20 Z" fill="#6ed49a" opacity="0.9" />
        )}
        {skin === 'robot' && (
          <>
            <line x1="48" y1="18" x2="48" y2="28" stroke="#8a9aa8" stroke-width="3" />
            <circle cx="48" cy="15" r="5" fill="#7ac8a8" class="pet-antenna" />
          </>
        )}
        {skin === 'cat' && (
          <>
            <path d="M24 32 L22 14 L40 26 Z" fill={face.body} />
            <path d="M72 32 L74 14 L56 26 Z" fill={face.body} />
          </>
        )}

        <rect x="16" y="26" width="64" height="56" rx={skin === 'robot' ? 12 : 26} fill={face.body} />
        {skin === 'blob' && <ellipse cx="34" cy="40" rx="9" ry="6" fill="#ffffff" opacity="0.16" />}

        {/* Eyes: the mood's real tell. */}
        <g class="pet-eyes">
          {mood === 'away' ? (
            <>
              <line x1="32" y1="52" x2="42" y2="52" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
              <line x1="54" y1="52" x2="64" y2="52" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
            </>
          ) : mood === 'celebrating' ? (
            <>
              <path d="M31 53 q5 -8 10 0" fill="none" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
              <path d="M55 53 q5 -8 10 0" fill="none" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
            </>
          ) : mood === 'distracted' ? (
            <>
              <line x1="30" y1="48" x2="40" y2="58" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
              <line x1="40" y1="48" x2="30" y2="58" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
              <line x1="56" y1="48" x2="66" y2="58" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
              <line x1="66" y1="48" x2="56" y2="58" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
            </>
          ) : (
            <>
              <circle cx={mood === 'focused' ? 37 : 36} cy="53" r={mood === 'focused' ? 4.5 : 5.5} fill="#0b0f14" class="pet-pupil" />
              <circle cx={mood === 'focused' ? 59 : 60} cy="53" r={mood === 'focused' ? 4.5 : 5.5} fill="#0b0f14" class="pet-pupil" />
            </>
          )}
        </g>

        {/* Mouth: a flat line when focused, a small arc otherwise. */}
        {mood === 'focused' ? (
          <line x1="42" y1="68" x2="54" y2="68" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
        ) : mood === 'away' || mood === 'idle' ? (
          <circle cx="48" cy="68" r="3" fill="#0b0f14" opacity="0.7" />
        ) : (
          <path d="M41 66 q7 8 14 0" fill="none" stroke="#0b0f14" stroke-width="3" stroke-linecap="round" />
        )}
      </svg>

      <div class="pet-actions">
        <button type="button" onClick={() => setBubbleOpen((open) => !open)} title="Say something">
          💬
        </button>
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} title="Pet settings">
            ⚙
          </button>
        )}
        <button type="button" onClick={() => persistHidden(true)} title="Hide">
          ×
        </button>
      </div>
      <span class="pet-scale" style={{ opacity: scale > 1.2 ? 1 : 0 }}>
        {skin}
      </span>
    </div>
  );
}

function readPosition(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        // Clamp: a saved position from a wider window must not strand the pet.
        return {
          x: Math.max(4, Math.min(window.innerWidth - 120, parsed.x)),
          y: Math.max(4, Math.min(window.innerHeight - 140, parsed.y)),
        };
      }
    }
  } catch {
    /* fall through to the default corner */
  }
  return {
    x: Math.max(8, window.innerWidth - 132),
    y: Math.max(8, window.innerHeight - 168),
  };
}

function writePosition(position: { x: number; y: number }): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    /* ignore */
  }
}
