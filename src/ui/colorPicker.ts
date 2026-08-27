/**
 * The colour control shared by every place MindFlow picks a colour: element
 * stroke and fill, text colour, a table's header row, and the board background.
 *
 * There is one of these rather than a control per call site because "pick a
 * colour" carries three pieces of behaviour that are tedious to get right and
 * embarrassing to get inconsistent — a curated palette, an arbitrary-colour
 * escape hatch, and a memory of what you last used. The escape hatch in
 * particular has a subtlety that a plain `<input type="color">` gets wrong; see
 * the note on preview-versus-commit below.
 *
 * The popover itself is `Popover` from `popover.ts`, which already owns outside
 * click, Escape, window blur, one-at-a-time and viewport clamping.
 */

import { el } from './dom.ts';
import { Popover } from './popover.ts';

/** The literal MindFlow writes for "no colour", as specified in `docs/02-document-format.md`. */
export const TRANSPARENT = 'transparent';

const RECENT_STORAGE_KEY = 'mindflow.recentColors';

/**
 * How many recent colours are remembered.
 *
 * Eight is one row in the popover at the width the panel already uses. A longer
 * memory sounds more helpful and is not: the value of the strip is that the
 * colour you want is findable without reading, and that stops being true once it
 * wraps onto a second line.
 */
const RECENT_LIMIT = 8;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Canonicalises user-typed colour text, or returns `null` if it is not a colour.
 *
 * Accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, with or without the `#`,
 * in either case, plus the keyword `transparent`. Always returns lower-case
 * six- or eight-digit hex, because that is what the format says MindFlow writes
 * (readers are lenient, writers are strict — the asymmetry described in
 * `CLAUDE.md`).
 *
 * Shorthand is expanded rather than stored: `#f00` is a perfectly valid CSS
 * colour, but writing it into a document would make two boards that are the same
 * colour compare unequal as strings, which breaks the `is-active` check on the
 * swatches and would make diffs noisier than they need to be.
 */
export function normalizeColor(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === TRANSPARENT) return TRANSPARENT;
  if (!HEX_PATTERN.test(trimmed)) return null;

  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  // Expand shorthand by doubling each digit: `f0a` -> `ff00aa`.
  const expanded = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
  return `#${expanded}`;
}

/** The `#rrggbb` prefix of a colour, for seeding a native `<input type="color">`. */
function toInputValue(color: string): string {
  const normalized = normalizeColor(color);
  if (!normalized || normalized === TRANSPARENT) return '#000000';
  return normalized.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Recent colours
// ---------------------------------------------------------------------------

/**
 * Reads the remembered colours, most-recent first.
 *
 * Every access to `localStorage` here is guarded. Reading it can *throw*, not
 * merely return null, in a browser configured to block site data — and a colour
 * picker that takes the application down with it because it could not remember a
 * shade of blue would be an absurd failure mode. Storage is a convenience; the
 * picker works without it.
 */
export function recentColors(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const color = normalizeColor(entry);
      // `transparent` is in every palette that offers it, so remembering it
      // would spend a slot on a colour that is already one click away.
      if (!color || color === TRANSPARENT || seen.has(color)) continue;
      seen.add(color);
      out.push(color);
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Moves `color` to the front of the remembered list. */
export function rememberColor(color: string): void {
  const normalized = normalizeColor(color);
  if (!normalized || normalized === TRANSPARENT) return;

  const next = [normalized, ...recentColors().filter((c) => c !== normalized)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Full, or blocked. Nothing to do and nothing worth telling the user.
  }
}

/** Test seam: forgets every remembered colour. */
export function clearRecentColors(): void {
  try {
    localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    /* see above */
  }
}

// ---------------------------------------------------------------------------
// Swatches
// ---------------------------------------------------------------------------

export interface SwatchOptions {
  /** Used for the accessible name, e.g. `"Fill"`. */
  label: string;
  /** The colour currently in effect, so exactly one swatch reads as active. */
  current: string;
  onSelect: (color: string) => void;
}

/** One colour button. Shared so the panel row and the popover grid stay identical. */
export function swatch(color: string, options: SwatchOptions): HTMLButtonElement {
  const active = normalizeColor(color) === normalizeColor(options.current);
  return el('button', {
    class: `mf-swatch${active ? ' is-active' : ''}${color === TRANSPARENT ? ' is-transparent' : ''}`,
    type: 'button',
    title: color,
    'aria-label': `${options.label} ${color}`,
    'aria-pressed': String(active),
    style: color === TRANSPARENT ? '' : `background:${color}`,
    onclick: () => options.onSelect(color),
  });
}

// ---------------------------------------------------------------------------
// The popover
// ---------------------------------------------------------------------------

export interface ColorPopoverOptions {
  /** Anchor, in viewport coordinates — usually the trigger button's rect. */
  at: { x: number; y: number };
  label: string;
  palette: readonly string[];
  current: string;
  /**
   * Called for every frame of a drag inside the system picker, INCLUDING the
   * last one.
   *
   * Split from {@link onCommit} for one reason: a native colour input fires
   * `input` on every frame of a drag, and MindFlow turns each call into an undo
   * entry. Without the split, choosing a colour by dragging leaves dozens of
   * history steps and `Cmd`+`Z` appears to do nothing. Preview calls are
   * expected to pass `coalesce: true` down to the command layer so the whole
   * drag merges into one step.
   *
   * Note that the *final* value of a drag arrives here too, not through
   * `onCommit`. That is deliberate and it is the part that is easy to get
   * wrong: routing the last frame through `onCommit` would push a second,
   * non-coalescing command and leave the gesture costing two undos — the first
   * of which rewinds only the final nudge. Treating the whole picker
   * interaction as one gesture matches how canvas drags already behave.
   */
  onPreview?: (color: string) => void;
  /** A discrete choice — a swatch, a recent colour, a typed hex value. Its own undo step. */
  onCommit: (color: string) => void;
}

export function openColorPopover(options: ColorPopoverOptions): Popover {
  const popover = new Popover({
    at: options.at,
    align: 'start',
    className: 'mf-color-popover',
    label: `${options.label} colour`,
  });

  // Read once at open: the strip should stay put while the popover is on screen
  // rather than reshuffling under the pointer as choices are made.
  const recents = recentColors();

  const choose = (color: string) => {
    const normalized = normalizeColor(color) ?? color;
    rememberColor(normalized);
    options.onCommit(normalized);
    popover.close();
  };

  const swatchOptions: SwatchOptions = {
    label: options.label,
    current: options.current,
    onSelect: choose,
  };

  const hex = el('input', {
    class: 'mf-input mf-hex-input',
    type: 'text',
    value: options.current === TRANSPARENT ? TRANSPARENT : (normalizeColor(options.current) ?? ''),
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': `${options.label} colour hex value`,
    placeholder: '#rrggbb',
  }) as HTMLInputElement;

  const commitHex = () => {
    const normalized = normalizeColor(hex.value);
    if (!normalized) {
      // Reject rather than guess. The field keeps what was typed so the typo is
      // visible and correctable; silently reverting would look like the
      // keystrokes were lost.
      hex.classList.add('is-invalid');
      return;
    }
    hex.classList.remove('is-invalid');
    choose(normalized);
  };

  hex.addEventListener('input', () => hex.classList.remove('is-invalid'));
  hex.addEventListener('change', commitHex);
  hex.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    event.preventDefault();
    commitHex();
  });

  const system = el('input', {
    class: 'mf-color-input',
    type: 'color',
    value: toInputValue(options.current),
    'aria-label': `${options.label} colour picker`,
    // Live while dragging, coalesced into a single undo step by the consumer.
    oninput: (event: Event) => options.onPreview?.((event.target as HTMLInputElement).value),
    onchange: (event: Event) => {
      const color = (event.target as HTMLInputElement).value;
      rememberColor(color);
      // The tail of the drag, applied the same coalescing way every frame
      // before it was — see the note on `onPreview`. Falls back to `onCommit`
      // only for a consumer that opted out of previewing entirely.
      (options.onPreview ?? options.onCommit)(color);
    },
  });

  popover.element.append(
    section('Palette', ...options.palette.map((color) => swatch(color, swatchOptions))),
    ...(recents.length > 0
      ? [section('Recent', ...recents.map((color) => swatch(color, swatchOptions)))]
      : []),
    section('Custom', hex, system),
  );

  hex.focus();
  hex.select();
  return popover;
}

function section(label: string, ...children: (HTMLElement | SVGElement)[]): HTMLElement {
  return el(
    'div',
    { class: 'mf-style-section' },
    el('span', { class: 'mf-style-label', text: label }),
    el('div', { class: 'mf-style-controls' }, ...children),
  );
}

/**
 * The button that opens the popover, showing the colour currently in effect.
 *
 * It replaces the bare `<input type="color">` that used to sit at the end of each
 * swatch row. A raw colour input jumps straight to the operating system's picker,
 * which is a fine escape hatch but a poor front door: it hides the recent
 * colours, offers no way to paste a hex value from a brand guide, and on most
 * platforms opens a modal window that covers the board you are trying to match.
 */
export function colorTrigger(options: {
  label: string;
  current: string;
  palette: readonly string[];
  onPreview?: (color: string) => void;
  onCommit: (color: string) => void;
}): HTMLButtonElement {
  const button = el(
    'button',
    {
      class: `mf-color-trigger${options.current === TRANSPARENT ? ' is-transparent' : ''}`,
      type: 'button',
      title: `More ${options.label.toLowerCase()} colours`,
      'aria-label': `More ${options.label.toLowerCase()} colours`,
      'aria-haspopup': 'dialog',
      style: options.current === TRANSPARENT ? '' : `--mf-trigger-color:${options.current}`,
      onclick: () => {
        const rect = button.getBoundingClientRect();
        openColorPopover({
          // Below the trigger, left edges aligned. `Popover` flips it above when
          // there is no room, which matters because the style panel runs to the
          // bottom of the window.
          at: { x: rect.left, y: rect.bottom + 6 },
          label: options.label,
          palette: options.palette,
          current: options.current,
          ...(options.onPreview ? { onPreview: options.onPreview } : {}),
          onCommit: options.onCommit,
        });
      },
    },
  ) as HTMLButtonElement;
  return button;
}
