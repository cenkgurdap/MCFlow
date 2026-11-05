/**
 * What a detector name means in nanometres.
 *
 * `$PnS` is empty in every file this project has and `$PnF`, `$PnL` and `$PnO`
 * are absent as well — the instrument records a detector's *name* and nothing
 * about the light it collects. So a reader looking at `(V1-A - V7-A)/(V1-A +
 * V7-A)` is being asked to know from memory that V1 sits at 428 nm and V7 at
 * 542 nm, which is the whole content of the claim that the ratio measures
 * membrane order. This table supplies that, and it is the only reason the
 * detector pickers in Biophysics and the presets in the Parameters panel can
 * be read by somebody who has not memorised a Cytek filter chart.
 *
 * **It is one instrument's configuration, and it is labelled as such wherever
 * it is shown.** A detector called `V1` on some other spectral platform is not
 * promised to be this band, so the panels name the Cytek Aurora next to the
 * numbers rather than presenting them as a property of the file. That is also
 * why nothing here ever *decides* anything: no parameter is selected, no
 * channel is matched and no default is chosen from this table. It annotates a
 * name the user already picked, which is the difference between a hint and the
 * filename-inference this project has deleted twice.
 *
 * Values are the 5-laser Aurora configuration published by the UNC Flow
 * Cytometry Core, cross-checked against the Cytek configuration sheets several
 * other core facilities publish. Where two sheets disagree they disagree by a
 * nanometre of rounding on the centre — the band edges agree — so the ranges
 * are the load-bearing half and the centre is stated as the median it is.
 *
 * The 64 entries are exactly the 64 fluorescence detectors an Aurora declares,
 * which `detectors.test.ts` holds this file to: a table that has drifted from
 * the instrument shows up as a count, not as a wrong tooltip nobody reads.
 */

/** One detector's band. `min`/`max` are the filter edges; `centre` their median. */
export interface DetectorBand {
  /** The `$PnN` stem, with no `-A`/`-H`/`-W` suffix. */
  name: string;
  laser: LaserName;
  centre: number;
  min: number;
  max: number;
}

export type LaserName = 'UV' | 'Violet' | 'Blue' | 'Yellow-Green' | 'Red';

/** The excitation line each detector array sits behind, for the hint's first word. */
export const LASER_LINES: Record<LaserName, number> = {
  UV: 355,
  Violet: 405,
  Blue: 488,
  'Yellow-Green': 561,
  Red: 640,
};

/* Written as `[name, centre, min, max]` per laser rather than as 64 object
   literals: the table is read as a table when it is being checked against a
   filter chart, and 64 copies of four keys is not. */
const TABLE: Record<LaserName, Array<[string, number, number, number]>> = {
  UV: [
    ['UV1', 372, 365, 380], ['UV2', 387, 380, 395], ['UV3', 427, 420, 435],
    ['UV4', 443, 435, 450], ['UV5', 458, 450, 465], ['UV6', 473, 465, 480],
    ['UV7', 514, 500, 528], ['UV8', 542, 528, 556], ['UV9', 581, 566, 597],
    ['UV10', 612, 597, 628], ['UV11', 664, 650, 677], ['UV12', 691, 677, 705],
    ['UV13', 720, 705, 734], ['UV14', 750, 735, 765], ['UV15', 780, 765, 795],
    ['UV16', 812, 795, 829],
  ],
  Violet: [
    ['V1', 428, 420, 435], ['V2', 443, 436, 451], ['V3', 458, 451, 466],
    ['V4', 473, 466, 481], ['V5', 508, 498, 518], ['V6', 525, 516, 533],
    ['V7', 542, 533, 550], ['V8', 581, 571, 590], ['V9', 598, 588, 608],
    ['V10', 615, 605, 625], ['V11', 664, 651, 678], ['V12', 692, 678, 706],
    ['V13', 720, 706, 735], ['V14', 750, 735, 765], ['V15', 780, 765, 795],
    ['V16', 812, 795, 829],
  ],
  Blue: [
    ['B1', 508, 498, 518], ['B2', 525, 516, 533], ['B3', 542, 533, 550],
    ['B4', 581, 571, 590], ['B5', 598, 588, 608], ['B6', 615, 605, 625],
    ['B7', 660, 652, 669], ['B8', 678, 669, 687], ['B9', 697, 688, 707],
    ['B10', 717, 707, 727], ['B11', 738, 728, 749], ['B12', 760, 749, 772],
    ['B13', 783, 772, 795], ['B14', 812, 795, 829],
  ],
  'Yellow-Green': [
    ['YG1', 577, 567, 587], ['YG2', 598, 588, 608], ['YG3', 615, 605, 625],
    ['YG4', 660, 652, 669], ['YG5', 678, 669, 687], ['YG6', 697, 688, 707],
    ['YG7', 720, 706, 735], ['YG8', 750, 735, 765], ['YG9', 780, 765, 795],
    ['YG10', 812, 795, 829],
  ],
  Red: [
    ['R1', 660, 652, 669], ['R2', 678, 669, 687], ['R3', 697, 688, 707],
    ['R4', 717, 707, 727], ['R5', 738, 728, 749], ['R6', 760, 749, 772],
    ['R7', 783, 772, 795], ['R8', 812, 795, 829],
  ],
};

/** Every band, in instrument order. */
export const DETECTOR_BANDS: DetectorBand[] = (Object.keys(TABLE) as LaserName[])
  .flatMap((laser) => TABLE[laser].map(([name, centre, min, max]) => ({ name, laser, centre, min, max })));

const BY_NAME = new Map(DETECTOR_BANDS.map((b) => [b.name, b]));

/**
 * The `$PnN` stem — `V1-A` and `V1-H` are one detector read two ways.
 *
 * Only the three suffixes FCS defines for a pulse measurement are stripped, and
 * only from the end. Trimming at the last hyphen instead would turn a detector
 * genuinely called `Green-2` into `Green`, and matching it against this table
 * would then be a guess rather than a lookup.
 */
export function detectorStem(name: string): string {
  return name.trim().toUpperCase().replace(/-[AHW]$/, '');
}

/**
 * The band a parameter name sits in, or `undefined`.
 *
 * `undefined` for everything that is not one of the 64 — scatter, Time, a
 * derived parameter, an unmixed abundance, and every detector name belonging to
 * an instrument that is not this one. Callers render nothing in that case
 * rather than a fallback, because there is no honest fallback: the alternative
 * to "we do not know this detector" is inventing a wavelength for it.
 */
export function detectorBand(name: string | null | undefined): DetectorBand | undefined {
  if (!name) return undefined;
  return BY_NAME.get(detectorStem(name));
}

/** `"428 nm (420–435)"`, or `null` for a name this table does not carry. */
export function describeDetector(name: string | null | undefined): string | null {
  const b = detectorBand(name);
  return b ? `${b.centre} nm (${b.min}–${b.max})` : null;
}

/**
 * The laser and the detector band as two labelled lines —
 * `"Laser: Violet 405 nm
V7 detector: 542 nm (range 533–550 nm)"`.
 *
 * Labelled, not joined by a dot: "Violet 405 · 542" read as two wavelengths of
 * one thing, when the first is the excitation line and the second the band the
 * detector collects.
 */
export function describeDetectorFull(name: string | null | undefined): string | null {
  const b = detectorBand(name);
  if (!b || !name) return null;
  return `Laser: ${b.laser} ${LASER_LINES[b.laser]} nm
${detectorStem(name)} detector: ${b.centre} nm (range ${b.min}–${b.max} nm)`;
}
