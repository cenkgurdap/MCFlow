/**
 * What a new plot opens as — in one place, for every way of creating one.
 *
 * There are four routes to a new panel: the *Add plot* button, *Duplicate*,
 * dropping a sample on the worksheet and dropping a population on it. "The
 * default plot" has to mean the same thing down all four, and the way that
 * breaks is not a wrong constant — it is the same constant written out in three
 * files and then changed in two of them.
 *
 * Kept pure and store-free so `plotStore` and `openPanel` can both import it
 * without either importing the other.
 */

// Type-only, so this module stays a leaf: `plotStore` imports the values below,
// and a value import back would close the cycle at runtime.
import type { DensityScale, PlotType, RampName } from '@/state/plotStore';
import type { ColorScaling, ColorStyle } from '@/render/colorLevels';

/**
 * Named density resolutions.
 *
 * A bin count is a number the user has no intuition for; *ultra* is a choice they
 * can hold in their head and a default that can be asserted in a test without
 * anyone having to agree that 1024 "is" ultra. These are the tiers the picker
 * offers.
 */
export const DENSITY_RESOLUTION = { coarse: 64, medium: 256, fine: 512, ultra: 1024 } as const;

export type DensityResolution = keyof typeof DENSITY_RESOLUTION;

/** The tier a bin count sits in, or null for a value between tiers. */
export function resolutionName(bins: number): DensityResolution | null {
  const hit = (Object.entries(DENSITY_RESOLUTION) as [DensityResolution, number][])
    .find(([, n]) => n === bins);
  return hit ? hit[0] : null;
}

/**
 * How a new plot draws itself — the workspace's own defaults for every setting
 * a plot can override.
 *
 * **Density**, because at 170 000 events a dot plot is a solid blob and the
 * information is in where the events pile up. **Rank**, because it equalises the
 * distribution and shows the faint populations a log ramp still buries — the
 * scaling you want when first looking at a file, as against log when reading
 * quantities off it.
 *
 * **1024×1024**, up from 256×256, and it only works as a package with the two
 * settings beside it. A 1024 grid over a 170 000-event sample averages 0.17
 * events per cell — which is a scatter plot, not a density estimate — so the
 * resolution bump needs smoothing to turn it back into one, and it needs the
 * downscale to the panel's ~230 px to be filtered rather than point-sampled
 * (`DensityLayer`). With all three, the core of a population resolves structure
 * that 256 flattens; with only the first, it looks worse than what it replaced.
 *
 * **Smoothing is Auto**, with 3 kept as the manual value behind it. Auto is a
 * bandwidth in data units — σ is 0.1% of the axis at 15 000 events, 3.5 cells at
 * 1024×1024, narrowing as n^(−1/6) to 2.5 at 300 000 — continuous in the event
 * count, so two replicates are smoothed all but alike. See `autoSmoothing`.
 *
 * **Rainbow** and **percentile**. Flame held this slot twice, on the strength of
 * being FCS Express's default, and lost it twice, on the strength of its bottom
 * third sitting within a few units of the `#0a0c10` plot surface — which is
 * where the sparse periphery lands and where gating is done. As of 2026-08-03 it
 * is removed rather than merely not the default; Viridis is the alternative and
 * has not changed. See `ramps.ts`.
 *
 * **Outlier dot size 2.** The one outlier setting that came back, and it is a
 * size rather than a colour or a mode: an isolated cell is drawn larger, in the
 * colour the level table already gave it. Nothing bypasses that table — see
 * `renderDensity`.
 *
 * **Point size 1.5 and opacity 50%** for the dot plot. Both are down: 2 px at the
 * derived alpha put a solid disc under the cursor where a gate boundary has to be
 * judged, and the two together are the difference between seeing the edge of a
 * cloud and seeing its silhouette. The opacity is a stated number rather than the
 * old count-derived one, so what a dot plot looks like no longer depends on how
 * many events happen to be in the sample; `alphaForCount` survives for panels
 * restored from a workspace that saved `null`.
 *
 * Deliberately *not* inherited from whatever panel happens to be active: that is
 * how the same button starts producing different plots depending on what the
 * user last touched. Axes are inherited — which parameters to show is a
 * continuation of what someone is doing; how to draw them is a preference.
 */
export const PANEL_VIEW_DEFAULTS: {
  plotType: PlotType;
  densityScale: DensityScale;
  binCount: number;
  ramp: RampName;
  colorStyle: ColorStyle;
  colorScaling: ColorScaling;
  smoothing: number;
  smoothingAuto: boolean;
  outlierSize: number;
  pointSize: number;
  alpha: number | null;
} = {
  plotType: 'density',
  densityScale: 'rank',
  binCount: DENSITY_RESOLUTION.ultra,
  ramp: 'rainbow',
  colorStyle: 'percentile',
  colorScaling: 'linear',
  smoothing: 3,
  smoothingAuto: true,
  outlierSize: 2,
  pointSize: 1.5,
  alpha: 0.5,
};
