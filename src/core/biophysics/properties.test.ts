import { describe, expect, it } from 'vitest';
import {
  BIOPHYSICAL_PROPERTIES, channelsForDetectors, probeById, propertyById, resolvedPreset,
} from './properties';

/* ==========================================================================
   Which two detectors a probe is read on, on an instrument that is not an
   Aurora — 2026-09-07.

   Reported against a FACSCanto II panel: nine parameters, no V1-A and no V7-A,
   and both of the bands Pro12A is actually read on present under the names BD
   gives its violet filter blocks. Step 2 said the property could not be
   computed and offered two dropdowns to resolve out of nine channels by knowing
   what the Aurora names meant.

   Asserted here rather than through the panel because the whole rule is a lookup
   of one written-down name against another: no wavelength arithmetic, no prefix
   matching, and nothing read off a filename. What a test can pin is exactly that
   — that it fires on the panel it was written for, and on nothing else.
   ========================================================================== */

const pro12a = probeById(propertyById('membrane-order'), 'pro12a')!;

/** The nine parameters of a Canto II Pro12A tube, in the file's own spelling. */
const CANTO = [
  'FSC-A', 'SSC-A', 'PE-A', 'PerCP-Cy5-5-A', 'PE-Cy7-A', 'APC-A',
  'Pacific Blue-A', 'AmCyan-A', 'Time',
];

/** The Aurora's violet block, enough of it to answer the question. */
const AURORA = ['Time', 'V1-A', 'V2-A', 'V7-A', 'FSC-A', 'SSC-A'];

describe('channelsForDetectors', () => {
  it('suggests nothing when the probe’s own bands are on the file', () => {
    // The spectral case, which is every dataset this project shipped with. A
    // suggestion here would be an alternative offered over a detector the probe
    // actually names.
    expect(channelsForDetectors(pro12a, AURORA)).toBeUndefined();
  });

  it('names the conventional instrument’s two bands, ordered first', () => {
    expect(channelsForDetectors(pro12a, CANTO)).toEqual(['Pacific Blue-A', 'AmCyan-A']);
  });

  it('hands back the file’s spelling, not the registry’s', () => {
    // A `<select>` set to a value none of its options carry shows blank, so a
    // case-insensitive match that returned its own casing would fill the
    // dropdowns with nothing on a file spelling it `Amcyan-A`.
    const odd = ['FSC-A', 'pacific blue-A', 'Amcyan-A', 'Time'];
    expect(channelsForDetectors(pro12a, odd)).toEqual(['pacific blue-A', 'Amcyan-A']);
  });

  it('says nothing when only half of a pair is present', () => {
    expect(channelsForDetectors(pro12a, ['FSC-A', 'Pacific Blue-A', 'APC-A'])).toBeUndefined();
  });

  it('says nothing for a probe that carries no equivalents', () => {
    expect(channelsForDetectors({ ...pro12a, alternatives: undefined }, CANTO)).toBeUndefined();
    expect(channelsForDetectors(undefined, CANTO)).toBeUndefined();
  });
});

describe('the suggestion is an ordinary override', () => {
  it('rebuilds the equation through the preset’s own function', () => {
    const property = BIOPHYSICAL_PROPERTIES[0]!;
    const base = resolvedPreset(property, pro12a, null)!;
    const pair = channelsForDetectors(pro12a, CANTO)!;
    const preset = resolvedPreset(property, pro12a, pair)!;

    // Same parameter, same name — a re-pointed membrane order is membrane order.
    expect(preset.name).toBe(base.name);
    expect(preset.channels).toEqual(['Pacific Blue-A', 'AmCyan-A']);
    // The arithmetic is the published one with the two names substituted, which
    // is what makes this one definition of the property rather than a second.
    expect(preset.expression).toBe(
      base.expression.replace(/V1-A/g, 'Pacific Blue-A').replace(/V7-A/g, 'AmCyan-A'),
    );
  });
});
