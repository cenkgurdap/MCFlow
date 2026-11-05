import { describe, expect, it } from 'vitest';
import {
  DETECTOR_BANDS, describeDetector, describeDetectorFull, detectorBand, detectorStem,
} from './detectors';

describe('detector table', () => {
  it('carries the 64 fluorescence detectors of a 5-laser Aurora', () => {
    expect(DETECTOR_BANDS).toHaveLength(64);
    const perLaser = DETECTOR_BANDS.reduce<Record<string, number>>((acc, b) => {
      acc[b.laser] = (acc[b.laser] ?? 0) + 1;
      return acc;
    }, {});
    expect(perLaser).toEqual({ UV: 16, Violet: 16, Blue: 14, 'Yellow-Green': 10, Red: 8 });
  });

  it('names every detector exactly once', () => {
    const names = DETECTOR_BANDS.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('states a centre inside its own band', () => {
    for (const b of DETECTOR_BANDS) {
      expect(b.min).toBeLessThan(b.max);
      expect(b.centre).toBeGreaterThanOrEqual(b.min);
      expect(b.centre).toBeLessThanOrEqual(b.max);
      // The centre is the median of the edges, to within the rounding the
      // published sheets do on an odd-width band.
      expect(Math.abs((b.min + b.max) / 2 - b.centre)).toBeLessThanOrEqual(1);
    }
  });

  it('ascends in wavelength within each laser', () => {
    const byLaser = new Map<string, number[]>();
    for (const b of DETECTOR_BANDS) byLaser.set(b.laser, [...(byLaser.get(b.laser) ?? []), b.centre]);
    for (const [, centres] of byLaser) {
      expect(centres).toEqual([...centres].sort((a, b) => a - b));
    }
  });
});

describe('detectorStem', () => {
  it('drops the pulse-measurement suffix only', () => {
    expect(detectorStem('V1-A')).toBe('V1');
    expect(detectorStem('SSC-H')).toBe('SSC');
    expect(detectorStem('B2-W')).toBe('B2');
    expect(detectorStem(' yg10-a ')).toBe('YG10');
  });

  it('leaves a hyphen that is part of the name', () => {
    // The reason it anchors on the three FCS suffixes rather than trimming at
    // the last hyphen: `SSC-B-A` is one detector, not `SSC` read with `B-A`.
    expect(detectorStem('SSC-B-A')).toBe('SSC-B');
    expect(detectorStem('Green-2')).toBe('GREEN-2');
  });
});

describe('detectorBand', () => {
  it('resolves the membrane-order pair', () => {
    expect(detectorBand('V1-A')).toMatchObject({ laser: 'Violet', centre: 428, min: 420, max: 435 });
    expect(detectorBand('V7-A')).toMatchObject({ laser: 'Violet', centre: 542, min: 533, max: 550 });
  });

  it('does not confuse UV with Violet', () => {
    expect(detectorBand('UV1-A')?.laser).toBe('UV');
    expect(detectorBand('V1-A')?.laser).toBe('Violet');
    expect(detectorBand('UV1-A')?.centre).not.toBe(detectorBand('V1-A')?.centre);
  });

  it('answers nothing for what it does not know', () => {
    // Scatter, time, a derived parameter, and a detector belonging to some other
    // instrument. There is no honest fallback for these — see the file comment.
    for (const n of ['FSC-A', 'SSC-A', 'Time', 'Membrane order', 'FITC-A', 'V17-A', '', null, undefined]) {
      expect(detectorBand(n)).toBeUndefined();
      expect(describeDetector(n)).toBeNull();
    }
  });
});

describe('describeDetector', () => {
  it('reads as a median and a range', () => {
    expect(describeDetector('V1-A')).toBe('428 nm (420–435)');
    expect(describeDetectorFull('V7-A')).toBe('Laser: Violet 405 nm\nV7 detector: 542 nm (range 533–550 nm)');
    expect(describeDetectorFull('B5-A')).toBe('Laser: Blue 488 nm\nB5 detector: 598 nm (range 588–608 nm)');
    expect(describeDetectorFull('YG2-A')).toBe('Laser: Yellow-Green 561 nm\nYG2 detector: 598 nm (range 588–608 nm)');
  });
});
