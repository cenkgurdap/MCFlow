import type { AxisTick } from './types';

/**
 * Superscript decade label — 10⁴ rather than 1e4.
 *
 * Defined here rather than in index.ts because index.ts imports the transform
 * classes, which import this module; pulling the helper the other way makes the
 * cycle resolve to `undefined` at call time.
 */
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

export function decadeLabel(exponent: number): string {
  return `10${String(exponent).split('').map((c) => SUPERSCRIPT[c] ?? c).join('')}`;
}

/** Superscript glyph back to the digit it stands for. */
const FROM_SUPERSCRIPT: Record<string, string> = Object.fromEntries(
  Object.entries(SUPERSCRIPT).map(([k, v]) => [v, k]),
);

/**
 * Split a tick label into its mantissa and its exponent, for a renderer that
 * can set the exponent's size itself.
 *
 * The label is a plain string everywhere it is stored, compared and exported,
 * and that stays true — this only tells a *drawing* surface where the two parts
 * are. It exists because Unicode superscripts are the wrong tool at plot-label
 * size: `⁴` is around 58% of the digit height *and* drawn with thinner strokes,
 * so on a 9.5 px axis the exponent — the only part of `10⁴` that distinguishes
 * one tick from the next — was reported as unreadable. An SVG `tspan` at 7.5 px
 * with a raised baseline is legibly a small digit rather than a smudge.
 *
 * Returns `exponent: ''` for anything with no trailing superscript run, which
 * is every linear label, `0`, and the abbreviated Time ticks — so a caller can
 * branch on it and draw a single string in the ordinary case.
 */
export function splitDecadeLabel(label: string): { base: string; exponent: string } {
  let cut = label.length;
  while (cut > 0 && FROM_SUPERSCRIPT[label[cut - 1]!] !== undefined) cut--;
  if (cut === label.length) return { base: label, exponent: '' };
  // A label that is *only* superscript has no mantissa to raise it above, so it
  // is left alone rather than being rendered as a floating exponent.
  if (cut === 0) return { base: label, exponent: '' };
  return {
    base: label.slice(0, cut),
    exponent: label.slice(cut).split('').map((c) => FROM_SUPERSCRIPT[c] ?? c).join(''),
  };
}

/**
 * Decade ticks for a log-like axis that also represents zero and negatives.
 *
 * Logicle, hyperlog, biexponential and arcsinh all compress a signed range onto
 * a monotonic display axis, so their axes read
 * `-10³ -10² 0 10² 10³ 10⁴ 10⁵` rather than the plain decade ladder a pure log
 * axis uses. Ticks are generated in *value* space and pushed through `forward`,
 * because the display spacing is exactly what the transform is choosing.
 */
export function signedDecadeTicks(
  forward: (value: number) => number,
  displayDomain: [number, number],
  /** Largest representable value — usually `$PnR`. */
  top: number,
  opts: { minor?: boolean } = {},
): AxisTick[] {
  const [lo, hi] = displayDomain;
  const out: AxisTick[] = [];
  const seen = new Set<number>();

  const push = (value: number, label: string, minor = false) => {
    const display = forward(value);
    if (!Number.isFinite(display) || display < lo || display > hi) return;
    // Two decades can collapse onto the same display position in the linear
    // region near zero; keep the first (the labelled one).
    const key = Math.round(display * 1e6);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ display, value, label, minor });
  };

  const maxExp = Math.floor(Math.log10(Math.max(top, 10)));
  // Below 10^-1 the ticks are visually indistinguishable from zero on any
  // realistic width, so there is no point emitting them.
  const minExp = -1;

  push(0, '0');
  for (let e = minExp; e <= maxExp; e++) {
    const v = Math.pow(10, e);
    push(v, decadeLabel(e));
    push(-v, `-${decadeLabel(e)}`);
    if (opts.minor) {
      for (let m = 2; m <= 9; m++) {
        push(m * v, '', true);
        push(-m * v, '', true);
      }
    }
  }

  out.sort((a, b) => a.display - b.display);
  return out;
}

/**
 * Drop labels from ticks that would collide, keeping them as minor ticks.
 *
 * Near zero a signed decade axis crowds several labels into a few pixels. The
 * axis still wants the tick marks — they show the compression — but not the
 * overlapping text.
 */
export function thinLabels(ticks: AxisTick[], minDisplayGap: number): AxisTick[] {
  const labelled = ticks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.minor && t.label);
  if (labelled.length === 0) return ticks;

  // Anchor on zero and thin outward from it. A plain left-to-right sweep drops
  // whichever labels happen to fall after a kept one — and on a signed axis the
  // crowding is centred on zero, so the sweep reliably deletes the single most
  // important label on the axis.
  let anchor = labelled.findIndex(({ t }) => t.value === 0);
  if (anchor < 0) anchor = 0;

  const keep = new Set<number>([labelled[anchor]!.i]);

  let last = labelled[anchor]!.t.display;
  for (let k = anchor + 1; k < labelled.length; k++) {
    const { t, i } = labelled[k]!;
    if (t.display - last >= minDisplayGap) {
      keep.add(i);
      last = t.display;
    }
  }
  last = labelled[anchor]!.t.display;
  for (let k = anchor - 1; k >= 0; k--) {
    const { t, i } = labelled[k]!;
    if (last - t.display >= minDisplayGap) {
      keep.add(i);
      last = t.display;
    }
  }

  return ticks.map((t, i) => {
    if (t.minor || !t.label) return t;
    return keep.has(i) ? t : { ...t, label: '', minor: true };
  });
}
