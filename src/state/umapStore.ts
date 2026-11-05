import { create } from 'zustand';
import { withBlock } from '@/core/rangeSelect';
import { headersMatch, parseCsvTable, type CsvTable } from '@/core/umap/csv';
import {
  allocatePoints, columnsForPreset, defaultSelection, presetById, strideIndices,
  type ParameterPreset, type UmapPresetId,
} from '@/core/umap/presets';
import {
  buildMatrix, embeddingExtent, UMAP_COFACTOR, type UmapScaling,
} from '@/core/umap/matrix';
import { DEFAULT_UMAP_SEED } from '@/core/umap/random';
import type { UmapRunMessage, UmapWorkerOut } from '@/core/umap/worker';
import { orderedGroups } from '@/core/umap/groups';
import { moveCategory } from '@/core/statisticsOrder';
import { onWorkspaceCleared } from './workspaceCleared';

/* ==========================================================================
   UMAP — dimensional reduction over exported data.

   ## Why this reads files rather than the loaded samples

   Every other panel works on the workspace's own `ParsedFcs` records. This one
   loads CSV, and that is the requested design rather than an oversight: a UMAP
   is usually run across an experiment that has already been gated, exported and
   possibly assembled from more than one workspace, and the export is the point
   at which those decisions have been made. Reading the export means the
   projection is over exactly the events and columns somebody chose to write out,
   with the gating already applied.

   It also keeps this panel out of the parameter-index question entirely. There
   are no derived parameters here, no unmixed block, no `parametersFor` — a
   column is a column in a file, identified by its header. `headersMatch` is the
   only compatibility rule, and it is by name and order like every other one in
   this application.

   ## Nothing here is workspace state

   A projection is not analysis in the sense `workspaceIO` means: it is a view
   computed from files outside the workspace, it takes a minute to produce and it
   would be tens of megabytes to store. So this store is **not** in the workspace
   format, not in the window-sync snapshot and not on the undo stack. It is
   cleared with the workspace, because leaving a projection of an experiment
   nobody has open any more on screen is worse than losing it.

   ## The groups are the user's

   Files are loaded ungrouped, and an ungrouped file is **its own group** — the
   same rule the Compare chart follows, where a sample with no group is its own
   bar. Nothing is inferred from a filename, which is a rule this project has
   re-learned twice and is not re-learning here, and nothing is merged either:
   pooling every ungrouped file into one colour is a claim that those files are
   one condition, which is exactly the claim the user has not yet made.
   ========================================================================== */

export type UmapStep = 1 | 2 | 3 | 4;

export const UMAP_STEPS = [
  { step: 1, label: 'Load data' },
  { step: 2, label: 'Groups' },
  { step: 3, label: 'Parameters' },
  { step: 4, label: 'Projection' },
] as const;

/** One loaded file. */
export interface UmapDataset {
  id: string;
  /** The file's name. Also the category it is drawn as while it has no group. */
  name: string;
  table: CsvTable;
  /** The group this file belongs to. Empty until somebody says, and then it is its own. */
  group: string;
  /** Excluded from the projection without being unloaded. */
  included: boolean;
}

/** A projected point, carrying enough to colour and identify it. */
export interface UmapPoint {
  x: number;
  y: number;
  /** Index into `datasets`. */
  dataset: number;
}

export interface UmapResult {
  points: UmapPoint[];
  extent: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** Headers actually projected, for the caption. */
  columns: string[];
  /** How many events each dataset contributed. */
  contributed: number[];
  preset: UmapPresetId;
  /**
   * How the values were scaled, and with what cofactor.
   *
   * On the result for the same reason as `seed`: it is a fact about how this
   * picture was made, and two maps of one experiment that disagree have to be
   * separable into *the data changed*, *the seed changed* and *the scale
   * changed* without guessing. It is quoted in the exported figure's caption.
   */
  scaling: UmapScaling;
  cofactor: number;
  /**
   * The random state this map was produced from.
   *
   * On the result and not only in the settings, because it is the one number
   * that makes a picture reproducible: a figure captioned with its seed can be
   * regenerated, and two maps that differ can be told apart into *the data
   * changed* and *the seed changed* without guessing.
   */
  seed: number;
  /** Wall time, ms. */
  elapsed: number;
}

interface UmapState {
  step: UmapStep;
  datasets: UmapDataset[];
  /**
   * Which group is first, second, … and therefore which colour each is drawn in.
   *
   * Empty until somebody arranges it, and merged against the groups that
   * actually exist every time it is read (`orderedGroups`) — so loading another
   * file adds a group at the end rather than renumbering the colours of the ones
   * already placed.
   *
   * It exists because the map has to be able to agree with the Compare chart of
   * the same experiment: both colour a category by its position, and this is the
   * half of that the projection was missing. Not saved, like everything else
   * here.
   */
  groupOrder: string[];
  /** Column indices into the shared header list. */
  selected: number[];
  preset: UmapPresetId;
  /**
   * What is done to a value before the distance between two events is measured.
   *
   * A setting rather than a constant because the three answers are for three
   * different kinds of table and the panel cannot tell them apart: a column is
   * a column in a file here, with no parameter identity to ask about.
   * `UMAP_SCALINGS` carries the three, the default, and the measurement over
   * two real panels that chose it.
   */
  scaling: UmapScaling;
  /** Arcsinh cofactor. Read only when `scaling` is `asinh`. */
  cofactor: number;
  /**
   * The random state every run starts from. See `seededRandom`.
   *
   * A setting rather than a hidden constant: fixed is what makes a projection
   * reproducible, and being able to change it is what lets somebody check that a
   * structure they are about to report is not an artefact of one particular
   * initialisation. Both halves matter, which is why this is a field and a
   * re-roll button rather than a checkbox.
   */
  seed: number;

  running: boolean;
  progress: { epoch: number; total: number } | null;
  error: string | null;
  result: UmapResult | null;

  setStep(step: UmapStep): void;
  next(): void;
  back(): void;

  /* Step 1 */
  addFiles(files: Array<{ name: string; text: string }>): { added: number; message?: string };
  removeDataset(id: string): void;
  clearAll(): void;

  /* Step 2 */
  setGroup(id: string, group: string): void;
  toggleIncluded(id: string): void;
  /**
   * Move one group one place along the order, and so one place along the palette.
   *
   * Takes the *resolved* order rather than the stored one, so the first press on
   * a projection nobody has arranged stores a complete list instead of a
   * fragment. Through `moveCategory`, which is what the chart's own reordering
   * goes through — a second convention is how an arrow in one panel comes to
   * mean something different from the same arrow in the other.
   */
  moveGroup(label: string, delta: -1 | 1): void;
  /** Back to the order the files were loaded in. */
  resetGroupOrder(): void;

  /* Step 3 */
  headers(): string[];
  applyParameterPreset(preset: ParameterPreset): void;
  toggleColumn(index: number): void;
  /**
   * Put a whole block of columns into one state, for a Shift-click.
   *
   * One action rather than a loop of `toggleColumn` at the call site: sixteen
   * detectors would be sixteen renders and sixteen half-selections, and a loop
   * of toggles inverts a mixed range instead of settling it.
   */
  setColumns(indices: number[], on: boolean): void;
  setScaling(scaling: UmapScaling): void;
  setCofactor(cofactor: number): void;

  /* Step 4 */
  setPreset(preset: UmapPresetId): void;
  /** Set the random state. Clears the result: it was produced from another one. */
  setSeed(seed: number): void;
  run(): void;
  cancel(): void;

  /** Whether the step can be left, and what is missing if not. */
  stepCheck(): { ok: boolean; reason: string };
}

let nextId = 1;

/**
 * The live worker, outside the store.
 *
 * A `Worker` is not state — it is not rendered, not compared and not restored —
 * and putting it in the store would make every subscriber re-run whenever a run
 * starts. It is module-scoped for the same reason the layout id counter is.
 */
let worker: Worker | null = null;

function stopWorker() {
  if (worker) { worker.terminate(); worker = null; }
}

export const useUmap = create<UmapState>((set, get) => ({
  step: 1,
  datasets: [],
  groupOrder: [],
  selected: [],
  preset: 'balanced',
  scaling: 'unit',
  cofactor: UMAP_COFACTOR,
  seed: DEFAULT_UMAP_SEED,
  running: false,
  progress: null,
  error: null,
  result: null,

  setStep(step) { set({ step }); },
  next() { const s = get(); if (s.step < 4 && s.stepCheck().ok) set({ step: (s.step + 1) as UmapStep }); },
  back() { const s = get(); if (s.step > 1) set({ step: (s.step - 1) as UmapStep }); },

  /* ---------------------------------------------------------------- Step 1 */

  addFiles(files) {
    const parsed = files.map((f) => ({ name: f.name, table: parseCsvTable(f.text) }));
    const usable = parsed.filter((p) => p.table.headers.length > 0 && p.table.count > 0);
    if (usable.length === 0) {
      return { added: 0, message: 'Nothing in those files could be read as a table of numbers.' };
    }

    /*
       Every file must describe the same measurements.

       By name and order — see `headersMatch`. Two exports with different
       columns are two experiments, and projecting them together would line
       column 4 of one up against column 4 of the other and produce a picture
       that is plausible and wrong. Refused per file, with the name, rather than
       refusing the whole drop: dragging in one stray file should not discard
       the eleven that were right.
    */
    const existing = get().datasets;
    const reference = existing[0]?.table.headers ?? usable[0]!.table.headers;
    const ok = usable.filter((p) => headersMatch(reference, p.table.headers));
    const rejected = usable.filter((p) => !headersMatch(reference, p.table.headers));

    const added: UmapDataset[] = ok.map((p) => ({
      id: `u${nextId++}`,
      name: p.name,
      table: p.table,
      group: '',
      included: true,
    }));

    const datasets = [...existing, ...added];
    set({
      datasets,
      // A first load picks the sensible column set so Step 3 opens on something
      // rather than on nothing; a later load leaves the choice alone.
      selected: existing.length === 0
        ? defaultSelection(reference)
        : get().selected,
      result: null,
      error: null,
    });

    const skipped = parsed.length - usable.length;
    const parts: string[] = [];
    if (rejected.length > 0) {
      parts.push(
        `${rejected.map((r) => r.name).join(', ')} ${rejected.length === 1 ? 'has' : 'have'} different columns `
        + 'from the files already loaded, so nothing was added from '
        + `${rejected.length === 1 ? 'it' : 'them'}.`,
      );
    }
    if (skipped > 0) parts.push(`${skipped} file${skipped === 1 ? '' : 's'} held no readable rows.`);
    const dropped = ok.reduce((a, p) => a + p.table.dropped, 0);
    if (dropped > 0) parts.push(`${dropped.toLocaleString()} rows were skipped for holding non-numeric values.`);

    return { added: added.length, message: parts.length > 0 ? parts.join(' ') : undefined };
  },

  removeDataset(id) {
    const datasets = get().datasets.filter((d) => d.id !== id);
    // The last file out takes the column selection with it: the next load is a
    // different table and a selection of indices into the old headers would
    // silently name different columns.
    set({ datasets, result: null, selected: datasets.length === 0 ? [] : get().selected });
  },

  clearAll() {
    stopWorker();
    set({ datasets: [], groupOrder: [], selected: [], result: null, error: null, running: false, progress: null, step: 1 });
  },

  /* ---------------------------------------------------------------- Step 2 */

  setGroup(id, group) {
    set({ datasets: get().datasets.map((d) => (d.id === id ? { ...d, group } : d)) });
  },

  moveGroup(label, delta) {
    const st = get();
    set({ groupOrder: moveCategory(orderedGroups(st.datasets, st.groupOrder), label, delta) });
  },

  resetGroupOrder() {
    set({ groupOrder: [] });
  },

  toggleIncluded(id) {
    set({
      datasets: get().datasets.map((d) => (d.id === id ? { ...d, included: !d.included } : d)),
      result: null,
    });
  },

  /* ---------------------------------------------------------------- Step 3 */

  headers() { return get().datasets[0]?.table.headers ?? []; },

  applyParameterPreset(preset) {
    set({ selected: columnsForPreset(preset, get().headers()), result: null });
  },

  toggleColumn(index) {
    const selected = get().selected;
    set({
      selected: selected.includes(index)
        ? selected.filter((i) => i !== index)
        : [...selected, index].sort((a, b) => a - b),
      result: null,
    });
  },

  setColumns(indices, on) {
    // Sorted, unlike the sample lists `withBlock` also serves: these are column
    // indices and the order they are projected in is the order of the table.
    set({ selected: withBlock(get().selected, indices, on).sort((a, b) => a - b), result: null });
  },

  setScaling(scaling) { set({ scaling, result: null }); },

  // A cofactor of zero or less is not a scale, and an emptied field reads as
  // NaN — both leave the setting alone rather than making every value infinite.
  setCofactor(cofactor) {
    if (!Number.isFinite(cofactor) || cofactor <= 0) return;
    set({ cofactor: Math.min(1_000_000, cofactor), result: null });
  },

  /* ---------------------------------------------------------------- Step 4 */

  setPreset(preset) { set({ preset, result: null }); },

  // Clamped to what mulberry32 can be seeded with and to what the field can
  // show. A non-number — an emptied input — leaves the seed alone rather than
  // setting it to NaN, which would silently make every run random again.
  setSeed(seed) {
    if (!Number.isFinite(seed)) return;
    set({ seed: Math.max(1, Math.min(999_999, Math.floor(seed))), result: null });
  },

  cancel() {
    stopWorker();
    set({ running: false, progress: null });
  },

  run() {
    const s = get();
    if (s.running) return;

    const active = s.datasets.filter((d) => d.included);
    if (active.length === 0 || s.selected.length === 0) return;

    const settings = presetById(s.preset);
    const counts = active.map((d) => d.table.count);
    const budget = allocatePoints(counts, settings.maxPoints);
    const sources = active.map((d, i) => ({
      columns: d.table.columns,
      indices: strideIndices(d.table.count, budget[i]!),
    }));

    const { rows } = buildMatrix(sources, s.selected, { scaling: s.scaling, cofactor: s.cofactor });
    if (rows.length < 3) {
      set({ error: 'There are too few events to project. Load more, or include more files.' });
      return;
    }

    // Which dataset each row came from, in the order `buildMatrix` gathered
    // them. Recorded here rather than derived later: it is the only thing that
    // colours the plot, and re-deriving it from the budget would be the same
    // arithmetic written twice.
    const owner: number[] = [];
    active.forEach((d, i) => {
      const all = s.datasets.indexOf(d);
      for (let k = 0; k < sources[i]!.indices.length; k++) owner.push(all);
    });

    const started = Date.now();
    stopWorker();
    worker = new Worker(new URL('../core/umap/worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<UmapWorkerOut>) => {
      const m = event.data;
      if (m.type === 'progress') { set({ progress: { epoch: m.epoch, total: m.total } }); return; }
      if (m.type === 'error') {
        stopWorker();
        set({ running: false, progress: null, error: m.message });
        return;
      }
      const headers = get().headers();
      const points: UmapPoint[] = m.embedding.map((p, i) => ({
        x: p[0] ?? 0, y: p[1] ?? 0, dataset: owner[i] ?? 0,
      }));
      stopWorker();
      set({
        running: false,
        progress: null,
        error: null,
        result: {
          points,
          extent: embeddingExtent(m.embedding),
          columns: s.selected.map((i) => headers[i] ?? `Column ${i + 1}`),
          contributed: s.datasets.map((d) => {
            const at = active.indexOf(d);
            return at >= 0 ? sources[at]!.indices.length : 0;
          }),
          preset: s.preset,
          scaling: s.scaling,
          cofactor: s.cofactor,
          seed: s.seed,
          elapsed: Date.now() - started,
        },
      });
    };

    worker.onerror = (e) => {
      stopWorker();
      set({ running: false, progress: null, error: e.message || 'The projection failed to start.' });
    };

    const message: UmapRunMessage = {
      type: 'run',
      rows,
      nNeighbors: settings.nNeighbors,
      minDist: settings.minDist,
      nEpochs: settings.nEpochs,
      seed: s.seed,
    };
    set({ running: true, progress: { epoch: 0, total: settings.nEpochs }, error: null, result: null });
    worker.postMessage(message);
  },

  stepCheck() {
    const s = get();
    if (s.step === 1) {
      return s.datasets.length === 0
        ? { ok: false, reason: 'Load at least one exported CSV file.' }
        : { ok: true, reason: '' };
    }
    if (s.step === 2) {
      return s.datasets.some((d) => d.included)
        ? { ok: true, reason: '' }
        : { ok: false, reason: 'Every file is excluded — include at least one.' };
    }
    if (s.step === 3) {
      if (s.selected.length < 2) {
        return { ok: false, reason: 'Choose at least two parameters to project.' };
      }
      return { ok: true, reason: '' };
    }
    return { ok: true, reason: '' };
  },
}));

// A projection of an experiment nobody has open any more is worse than no
// projection. The worker goes with it — a run outliving its data would spend a
// minute of CPU on an answer with nowhere to go.
onWorkspaceCleared(() => {
  stopWorker();
  useUmap.setState({
    step: 1, datasets: [], groupOrder: [], selected: [], result: null,
    running: false, progress: null, error: null,
  });
});
