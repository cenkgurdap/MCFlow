import type { Viewport } from '@/state/plotStore';

/* ==========================================================================
   Explicit axis limits.

   There is no zoom and no pan, and that is not being reversed: a *gesture* that
   changes what range a plot shows is what made two panels of the same
   parameters incomparable, because the range then depended on where somebody
   happened to release the mouse and was invisible afterwards.

   A typed number is the opposite of that. It is stated rather than gestured, it
   is part of the panel's saved configuration, it is legible in the inspector
   next to the parameter it applies to, and a second panel can be given the
   identical number. So the capability the zoom removal took away — showing a
   sub-range on purpose — comes back as axis configuration, which is where it
   belonged in the first place.

   `null` means auto: the full extent of the data, which stays the default and
   is what every panel opens with.
   ========================================================================== */

export interface AxisLimits {
  xMin: number | null;
  xMax: number | null;
  yMin: number | null;
  yMax: number | null;
}

export const AUTO_LIMITS: AxisLimits = { xMin: null, xMax: null, yMin: null, yMax: null };

/**
 * Fold explicit limits onto the auto-fitted extent.
 *
 * Each bound is independent — setting only a maximum is a real thing to want,
 * "everything below 10⁴" — so a `null` takes the fitted value rather than
 * invalidating the pair.
 *
 * A pair that would leave the axis empty or inverted is *discarded together*
 * and the axis reverts to auto for that axis alone. Half-applying it would
 * produce a plot whose axis silently disagrees with the numbers typed into the
 * fields that produced it, and clamping to some minimum span would draw a
 * sliver nobody asked for. The fields are still showing what the user typed, so
 * the disagreement is visible rather than mysterious.
 */
export function applyAxisLimits(fitted: Viewport, limits: AxisLimits, oneDimensional = false): Viewport {
  const x = resolve(fitted.xMin, fitted.xMax, limits.xMin, limits.xMax);
  // A histogram's y axis is normalised density, not a data parameter. Nothing
  // the user could type about it would mean anything, so the limits are not
  // consulted rather than being applied to an axis that is always [0,1].
  const y = oneDimensional
    ? { min: 0, max: 1 }
    : resolve(fitted.yMin, fitted.yMax, limits.yMin, limits.yMax);

  return { xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max };
}

/** True when this axis is showing something other than the whole of its data. */
export function isAxisLimited(limits: AxisLimits, axis: 'x' | 'y'): boolean {
  return axis === 'x'
    ? limits.xMin !== null || limits.xMax !== null
    : limits.yMin !== null || limits.yMax !== null;
}

function resolve(
  fitMin: number,
  fitMax: number,
  min: number | null,
  max: number | null,
): { min: number; max: number } {
  if (min === null && max === null) return { min: fitMin, max: fitMax };
  const lo = min ?? fitMin;
  const hi = max ?? fitMax;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { min: fitMin, max: fitMax };
  return { min: lo, max: hi };
}
