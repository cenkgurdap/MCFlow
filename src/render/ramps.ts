/* ==========================================================================
   Density colour ramps that are *defined* rather than sampled.

   Viridis is a published 256-entry table and is embedded verbatim in
   `viridis.ts`, because its whole value is the exact path through CIELAB that
   Smith & van der Walt fitted and a hand-tuned approximation of it reproduces
   the hues while losing the uniformity.

   Rainbow is the opposite kind of object. It is not a fitted colormap; it is a
   small set of anchor colours with linear interpolation between them, which is
   precisely how matplotlib's `jet` is specified and how every cytometry package
   draws its equivalent. So it is written here as anchors plus one expansion
   function, not as 768 bytes of hex — the anchors are the specification, and a
   reader can check them against a swatch, which is not true of a table.

   ## Flame is gone, for the second and last time

   **Removed 2026-08-03. Rainbow is the default; Viridis is the alternative.**

   Flame's history in this file reads viridis → flame → rainbow → flame →
   *removed*, and the honest summary is that it was decided twice on two
   different grounds and the ground has now been chosen:

     - **For it**, and this was always true: it is what FCS Express opens with,
       and a density ramp is the one piece of visual design here that gets
       compared against something outside the application.
     - **Against it**, and this was also always true: this plot surface is
       `#0a0c10` and flame's bottom third sits within a few units of it. The
       bottom of a density ramp is where the sparse periphery lands, and the
       sparse periphery is what a gate is drawn against.

   Matching another product's screen is worth something; being able to see the
   events you are gating on is worth more, and it is the one of the two that no
   setting elsewhere can recover. Rainbow's floor is `#101f52` — 0.156 in sRGB
   distance from the plot background, against flame's 0.088 — and viridis's is
   `#440154`. `expandRamp` and the anchor form stay, because rainbow is specified
   the same way; what goes is the ramp, its tokens and its name.
   ========================================================================== */

export type Rgb = [number, number, number];

/** One anchor colour, at a position along the ramp. */
export interface RampAnchor {
  /** 0…1. Must be non-decreasing across the list. */
  at: number;
  rgb: Rgb;
}

/**
 * Expand anchors into an `n`-entry lookup table, interpolated in sRGB.
 *
 * sRGB and not linear light, deliberately. Interpolating these in linear light
 * is arguably more "correct" and produces a visibly different ramp — a lighter,
 * washed-out midpoint — which would mean our rainbow ramp did not match the
 * rainbow ramp anybody is comparing it against. matplotlib's
 * `LinearSegmentedColormap` interpolates the sRGB values, so matching the
 * reference means doing the same.
 */
export function expandRamp(anchors: RampAnchor[], n = 256): Rgb[] {
  const out: Rgb[] = new Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    while (seg < anchors.length - 2 && t > anchors[seg + 1]!.at) seg++;
    const a = anchors[seg]!;
    const b = anchors[seg + 1] ?? a;
    const span = b.at - a.at;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 0;
    out[i] = [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
    ];
  }
  return out;
}

/* `FLAME_ANCHORS` and `FLAME` are deleted — see the header note. The bottom
   third of that ramp sat within a few units of the plot surface, which is where
   the sparse periphery lands and where gating actually happens. */

/**
 * **Rainbow** — deep blue, blue, cyan, green, yellow, orange, red. The default.
 *
 * A spectral ramp, and the honest thing to say about it is that it is **not**
 * perceptually uniform and **not** monotonic in lightness: yellow at 0.72 is
 * lighter than red at 1.0, so the top of the ramp gets darker as the data gets
 * denser. That is the well-known criticism of every rainbow colormap and the
 * reason viridis exists at all, and it is why viridis stays one keystroke away.
 *
 * It is the default anyway, restored to that on 2026-08-03, for what a gating
 * session actually does: it is spent looking at where a cloud *ends*, and a
 * rainbow ramp puts more distinguishable hues across the middle of the range
 * than a uniform ramp can, so the shoulder of a population is a colour change
 * rather than a slightly-lighter grey. Where the reading is quantitative,
 * viridis is one click away and is the right answer. `render.test.ts` asserts
 * the non-monotonicity explicitly rather than exempting the ramp from the check,
 * because a property this ramp is known not to have should be recorded as a fact
 * about it and not as a gap in the tests.
 *
 * ## Why these are not the saturated primaries
 *
 * The obvious anchors are `#0000ff`, `#00ffff`, `#00ff00`, `#ffff00`, `#ff0000`
 * — which is what `jet` uses. They are too loud to work over. Two concrete
 * things go wrong at full saturation, both reported:
 * a gate outline drawn across a pure-yellow core has almost nothing to be dark
 * *against* in the channels that matter, and the crosshair readout sits on a
 * field that is at maximum intensity everywhere the data is. So every anchor is
 * pulled off the gamut corners — roughly 12–18% toward the neutral of its own
 * lightness, and the top end held under ~85% value.
 *
 * The hue *sequence* is untouched, which is what keeps it recognisable: this is
 * the same ramp with the shouting taken out, not a different one. The bottom
 * anchor is worth one more note — `#101f52` against the `#0a0c10` plot surface
 * is a small step, but it is the step that makes a single isolated event a
 * visible dark blue mark rather than background, and the whole periphery of
 * every plot is made of those cells.
 *
 * Green is an explicit anchor. Interpolating cyan straight to yellow — which is
 * what `jet` does — passes through a pale desaturated green that reads as "not
 * quite anything", and green is one of the five colours the ramp is named for.
 */
export const RAINBOW_ANCHORS: RampAnchor[] = [
  { at: 0.00, rgb: [16, 31, 82] },
  { at: 0.10, rgb: [44, 80, 207] },
  { at: 0.32, rgb: [62, 200, 210] },
  { at: 0.52, rgb: [79, 196, 95] },
  { at: 0.72, rgb: [226, 220, 92] },
  { at: 0.88, rgb: [231, 147, 64] },
  { at: 1.00, rgb: [217, 79, 67] },
];

/** 256 sRGB triples, deep blue through cyan, green and yellow to red. */
export const RAINBOW: Rgb[] = expandRamp(RAINBOW_ANCHORS);
