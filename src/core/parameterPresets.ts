/**
 * Ready-made derived-parameter definitions.
 *
 * Lifted out of `panels/ParametersView.tsx` on 2026-08-14, unchanged, because a
 * second surface now needs the same objects: the Biophysics pipeline creates the
 * membrane-order parameter for the user rather than sending them off to the
 * Parameters panel to type it, and the two must produce **the same parameter**.
 * A preset copied into the second caller would be identical on the day it was
 * copied and is one edit away from two parameters called *Membrane order* with
 * different equations sitting in one workspace — which does not fail, it gives
 * different numbers.
 *
 * The original note is kept below because the reasoning behind the three has not
 * changed and is the sort of thing that gets re-litigated once it is separated
 * from the values it explains.
 *
 * ---
 *
 * Three, and they are the three this feature exists for on a spectral
 * instrument: a normalised ratio between two detectors is how membrane order,
 * mitochondrial potential and lysosomal order are all read, and each one is the
 * same shape with a different pair of channels. Somebody who has done it once
 * knows the form; somebody who has not is looking at seventy-one detector names
 * with no indication that `(a − b)/(a + b)` is the thing they are supposed to
 * write.
 *
 * **The channel names are the instrument's, not the dye's**, and that is
 * deliberate rather than an oversight: `$PnS` is empty in every file this
 * project has, so a detector is addressable only by its `$PnN`, and a preset
 * naming a fluorophore would not resolve. A pair that does not exist on the
 * loaded file fails validation visibly, in the sentence under the field, which
 * is the same feedback a hand-typed name gets.
 *
 * **A preset is a channel *pair*; the equation is derived from it** (2026-08-24).
 * It was a literal string, which was honest while these three were the only
 * ratios anybody could have and the detector names were this instrument's. They
 * are not: the same measurement on another spectral platform is the same
 * arithmetic over two differently-named detectors, so Biophysics lets the pair
 * be re-pointed and needs an equation built from whatever pair it ends up with.
 * `ratioExpression` is the one place that spells the arithmetic, which is what
 * stops a re-pointed preset and a hand-typed one from differing by a bracket.
 */
import { describeDetector } from '@/core/detectors';

export interface ParameterPreset {
  name: string;
  /**
   * The two detectors, in the order the equation reads them.
   *
   * First is the band that *rises* with the property — the ordered emission for
   * membrane order, the aggregate for mitochondrial potential — so a positive
   * value means more of the thing the parameter is named after. Swapping them
   * negates every number and no error appears anywhere, which is why the order
   * is stated here rather than left to whoever writes the next preset.
   */
  channels: readonly [string, string];
  expression: string;
  hint: string;
}

/**
 * The normalised difference of two channels, as the parser accepts it.
 *
 * Spaces around the operators are not cosmetic: every detector name on this
 * instrument contains a hyphen, so `(V1-A-V7-A)` is four tokens the lexer has to
 * disambiguate by longest match and a human has to disambiguate by counting.
 * The Parameters panel's operator buttons insert the same spacing for the same
 * reason.
 */
export function ratioExpression(a: string, b: string): string {
  return `(${a} - ${b})/(${a} + ${b})`;
}

const ratio = (
  name: string,
  channels: readonly [string, string],
  hint: string,
): ParameterPreset => ({ name, channels, expression: ratioExpression(channels[0], channels[1]), hint });

export const PARAMETER_PRESETS: ParameterPreset[] = [
  ratio(
    'Membrane order', ['V1-A', 'V7-A'],
    'Generalised polarisation of a solvatochromic membrane probe — the ordered and disordered emission bands, normalised.',
  ),
  ratio(
    'Mitochondrial potential', ['B5-A', 'B3-A'],
    'The aggregate and monomer emission of a potential-sensitive mitochondrial dye, normalised.',
  ),
  ratio(
    'Lysosome order', ['YG2-A', 'YG8-A'],
    'The two emission bands of a ratiometric lysosomal probe, normalised.',
  ),
];

/**
 * A preset's channels annotated with what they collect, or `null`.
 *
 * `null` when either detector is not one this build knows a band for, which is
 * the case on any instrument that is not a Cytek Aurora — and the caller then
 * shows the equation alone rather than half an annotation. See
 * `core/detectors.ts` for why there is no fallback.
 */
export function describePresetChannels(preset: ParameterPreset): Array<{ name: string; band: string }> | null {
  const bands = preset.channels.map((c) => describeDetector(c));
  if (bands.some((b) => b === null)) return null;
  return preset.channels.map((name, i) => ({ name, band: bands[i]! }));
}

/**
 * A preset by name, for a caller that knows which one it wants.
 *
 * The Biophysics registry names its parameter this way rather than holding an
 * expression of its own, so "which equation is membrane order" has exactly one
 * answer in the codebase. Returns `undefined` for an unknown name rather than
 * throwing: a property naming a preset that has been renamed is a bug worth
 * surfacing as a disabled step with a stated reason, not a crash on a panel.
 */
export function presetNamed(name: string): ParameterPreset | undefined {
  return PARAMETER_PRESETS.find((p) => p.name === name);
}
