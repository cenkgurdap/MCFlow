/**
 * The two sets of choices the UMAP panel offers, and nothing else.
 *
 * ## Parameters: rules, not lists
 *
 * A preset here selects columns by the **shape of their name** — scatter height
 * and area, Time, a laser-and-number detector like `B2-A` — and never by what
 * marker they might carry. The panel is not told which channel holds CD4 and
 * will not deduce it from a header any more than anything else in this
 * application deduces a control from a filename. What it can say is that FSC-A
 * is an instrument channel, that `YG3-A` is a detector, and that anything left
 * over is a column this application computed and wrote out — an unmixed
 * abundance or a derived parameter.
 *
 * That last distinction is the one worth having. *Markers only* meant "not
 * scatter, not Time", which put a derived membrane-order index into the
 * projection beside the two detectors its equation divides — the same
 * measurement entered twice, weighted twice, and moving the map for it.
 *
 * ## Settings: three, deliberately
 *
 * UMAP has a dozen knobs and two of them matter to somebody who has not read the
 * paper: how much neighbourhood structure to preserve, and how long to spend.
 * Both move together — a run that considers more neighbours for more epochs is
 * slower and tighter — so they are offered as one axis with three stops rather
 * than as six fields. Anyone who wants the other ten has a tool for it.
 *
 * `maxPoints` is on the same axis and is the setting that decides whether the
 * application is still usable. UMAP is O(n log n) at best and the graph
 * construction allocates per point; 300 000 events is minutes and hundreds of
 * megabytes. Each preset caps the *total* across every loaded file, and
 * `allocatePoints` shares that cap out.
 */

export type ParameterPreset = 'all' | 'channels' | 'parameters' | 'none';

const PRESETS: Array<{ id: ParameterPreset; label: string; hint: string }> = [
  { id: 'channels', label: 'Channels only', hint: 'The detectors the cytometer recorded, without scatter or Time. The usual choice.' },
  { id: 'all', label: 'Select all', hint: 'Every column in the file, scatter and Time included.' },
  { id: 'none', label: 'Select none', hint: 'Start from nothing.' },
  { id: 'parameters', label: 'Parameters only', hint: 'The computed columns — unmixed abundances and derived parameters — and no detectors.' },
];

/**
 * Which quick choices this table can offer.
 *
 * *Parameters only* appears only when the file has some. A gate export of raw
 * events is 71 detector columns and nothing else, and a button that would select
 * nothing is a control whose only possible effect is to look broken.
 *
 * The reason the split exists at all: *Channels only* used to be *Markers only*
 * and meant "everything that is not scatter or Time", so the moment somebody
 * defined a derived parameter — a ratio, a membrane-order index — the projection
 * quietly included it beside the detectors it was computed from. That is one
 * quantity entered twice, and it moves the map.
 */
export function parameterPresetsFor(headers: readonly string[]): Array<{ id: ParameterPreset; label: string; hint: string }> {
  const any = headers.some((h) => isComputedColumn(h));
  return PRESETS.filter((p) => p.id !== 'parameters' || any);
}

/** Is this column an instrument channel rather than a measurement of a marker? */
export function isInstrumentChannel(header: string): boolean {
  const n = header.trim().toUpperCase();
  if (n === 'TIME' || n.startsWith('TIME ')) return true;
  return n.includes('FSC') || n.includes('SSC');
}

/**
 * Is this column a detector the cytometer wrote, by the shape of its name?
 *
 * A `$PnN` on any of the instruments this application reads is a laser prefix, a
 * detector number and the pulse statistic — `B2-A`, `UV16-A`, `YG10-H`, `R1-W`,
 * and `FL3-A` on an older machine. That is a rule about the *form* of a name and
 * nothing else: this panel is not told which column holds CD4 and does not
 * deduce it, exactly as no part of this application deduces a control from a
 * filename.
 *
 * Scatter and Time are detectors too, and are excluded here rather than in the
 * caller, because every caller wants the fluorescence block.
 */
export function isDetectorChannel(header: string): boolean {
  if (isInstrumentChannel(header)) return false;
  return /^[A-Z]{1,3}\d{1,2}-[AHW]$/i.test(header.trim());
}

/** Anything that is neither a detector nor scatter/Time — so, computed. */
export function isComputedColumn(header: string): boolean {
  return !isInstrumentChannel(header) && !isDetectorChannel(header);
}

export function columnsForPreset(preset: ParameterPreset, headers: readonly string[]): number[] {
  if (preset === 'none') return [];
  if (preset === 'all') return headers.map((_, i) => i);
  const rule = preset === 'channels' ? isDetectorChannel : isComputedColumn;
  return headers.map((_, i) => i).filter((i) => rule(headers[i]!));
}

/**
 * What a first load selects, so Step 3 opens on something rather than nothing.
 *
 * Channels, unless the file has none — a table assembled elsewhere, or an export
 * of unmixed abundances alone, has no detector-shaped column and would otherwise
 * open on an empty selection and a warning.
 */
export function defaultSelection(headers: readonly string[]): number[] {
  const channels = columnsForPreset('channels', headers);
  if (channels.length > 0) return channels;
  const computed = columnsForPreset('parameters', headers);
  return computed.length > 0 ? computed : columnsForPreset('all', headers);
}

export type UmapPresetId = 'quick' | 'balanced' | 'detailed';

export interface UmapSettings {
  id: UmapPresetId;
  label: string;
  hint: string;
  /** How many neighbours define the local structure. */
  nNeighbors: number;
  /** How tightly points may pack together. */
  minDist: number;
  /** Optimisation passes. */
  nEpochs: number;
  /** Cap on points across **every** loaded file. */
  maxPoints: number;
}

export const UMAP_PRESETS: UmapSettings[] = [
  {
    id: 'quick',
    label: 'Quick look',
    hint: 'A few seconds. Enough to see whether the groups separate at all.',
    nNeighbors: 10,
    minDist: 0.15,
    nEpochs: 150,
    maxPoints: 6000,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'Under a minute on most panels. The one to use.',
    nNeighbors: 15,
    minDist: 0.1,
    nEpochs: 300,
    maxPoints: 20000,
  },
  {
    id: 'detailed',
    label: 'Detailed',
    hint: 'Several minutes. Tighter structure, for a figure.',
    nNeighbors: 30,
    minDist: 0.05,
    nEpochs: 500,
    maxPoints: 50000,
  },
];

export function presetById(id: UmapPresetId): UmapSettings {
  return UMAP_PRESETS.find((p) => p.id === id) ?? UMAP_PRESETS[1]!;
}

/**
 * How many events to take from each file, given a total budget.
 *
 * **Proportional, with a floor.** Taking the same number from every file would
 * make a 200 000-event sample and a 3 000-event sample equally dense in the
 * projection, which is a statement about the experiment that nobody made. Taking
 * a strict proportion would reduce the small one to nine points and lose it.
 *
 * So: a floor of `minEach` for anything non-empty, and the remainder shared out
 * in proportion. A file with fewer events than its share contributes all of
 * them, and what it does not use is offered back to the others — otherwise a set
 * of one large and five tiny files would use a fraction of the budget and run
 * far faster and worse than the preset promised.
 */
export function allocatePoints(
  counts: readonly number[],
  budget: number,
  minEach = 500,
): number[] {
  const n = counts.length;
  if (n === 0 || budget <= 0) return counts.map(() => 0);

  const out = counts.map((c) => Math.min(c, Math.max(0, Math.min(minEach, Math.floor(budget / n)))));
  let used = out.reduce((a, b) => a + b, 0);

  // Share the remainder in proportion, repeatedly: a file that cannot take its
  // share hands the difference back, and the loop settles when nothing moves.
  for (let pass = 0; pass < 8 && used < budget; pass++) {
    const hungry = counts.map((c, i) => c - out[i]!);
    const totalHungry = hungry.reduce((a, b) => a + b, 0);
    if (totalHungry <= 0) break;

    const spare = budget - used;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (hungry[i]! <= 0) continue;
      const share = Math.floor((spare * hungry[i]!) / totalHungry);
      const take = Math.min(share, hungry[i]!);
      out[i]! += take;
      moved += take;
    }
    if (moved === 0) {
      // Rounding has stalled it. Hand out the last few one at a time so the
      // budget is actually spent rather than left a dozen points short.
      for (let i = 0; i < n && used + moved < budget; i++) {
        if (counts[i]! > out[i]!) { out[i]! += 1; moved += 1; }
      }
      if (moved === 0) break;
    }
    used += moved;
  }

  return out;
}

/**
 * Evenly spaced row indices — a subsample that is not the first N rows.
 *
 * An FCS file is in acquisition order, so the first 6 000 events of a 200 000
 * event tube are the first ninety seconds of the run. Taking a stride instead
 * samples the whole acquisition, which matters whenever anything drifted.
 * Deterministic, so the same file gives the same picture twice.
 */
export function strideIndices(total: number, want: number): Uint32Array {
  const take = Math.max(0, Math.min(want, total));
  const out = new Uint32Array(take);
  if (take === 0) return out;
  if (take === total) { for (let i = 0; i < take; i++) out[i] = i; return out; }
  const stride = total / take;
  for (let i = 0; i < take; i++) out[i] = Math.min(total - 1, Math.floor(i * stride));
  return out;
}
