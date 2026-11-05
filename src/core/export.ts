import { maskToIndices, populationPath } from './gating/tree';
import { ROOT_ID, type Gate } from './gating/types';
import type { FcsMetadata, ParsedFcs } from './fcs/types';
import { timeParameterIndex, timePrecision, timeScaleFor } from './timeUnits';

/* ==========================================================================
   CSV export.

   Three shapes, all built on the same walk:
     - one population, one sample          (§3.8.1)
     - one population, every sample        (§3.8.2)
     - every population, every sample      (§3.8.3, "Full Gate Export")

   ## No manifest, and no folder per sample

   Both are gone as of 2026-08-02, and they went together because they were one
   idea. A per-sample folder tree makes `Lymphocytes.csv` appear eighty-four
   times under eighty-four different parents, so *which* Lymphocytes a file holds
   is a property of its directory rather than of the file — and a manifest is
   what you then need to read the folder. Naming the file
   `Sample_Population.csv` puts the same two facts in the name, where a file
   manager sorts on them, a glob matches them and a spreadsheet's title bar shows
   them. The run's own results table still reports every skip and failure on
   screen; what is removed is writing that table to disk as a file nobody opened.

   `ManifestEntry` survives under that name because it is still exactly what it
   was — one row per sample × population attempted, with a status — it is simply
   rendered rather than serialised.
   ========================================================================== */

export type ValueMode = 'raw' | 'transformed';
export type ColumnNaming = 'name' | 'stain' | 'both';

/**
 * How the exported populations are distributed across files.
 *
 * - `per-population` — the default and the original shape: a flat list of
 *   `Sample_Population.csv` (or `.xlsx`) in the chosen folder.
 * - `workbook-per-sample` — one file per sample, with every population of that
 *   sample as a **tab inside it**. Excel only, and not because of an arbitrary
 *   restriction: a CSV file is one table of text and has no concept of a sheet,
 *   so the shape is not expressible. `ExportView` disables it while CSV is
 *   selected and coerces it here if it somehow arrives anyway.
 *
 * The third shape, `combined` — one long-format CSV with `sample_id`,
 * `population`, `parent` and `population_path` columns in front of the event
 * data — is **removed** (2026-08-04, Item 11). It was added on 2026-07-31 for
 * tidy-data consumers, and `workbook-per-sample` answers the same request
 * better: a tab per population keeps the populations addressable without
 * repeating five identifying strings on every one of 286 583 rows, which is
 * what the long format spent most of its bytes on.
 *
 * `per-population` was called `per-sample` until Item 11. The old name was
 * shorthand for "one file per sample × population", which only read as the
 * opposite of `combined`; with `combined` gone and a shape called
 * `workbook-per-sample` beside it, two ids beginning with the same word meant
 * opposite things.
 */
export type ExportShape = 'per-population' | 'workbook-per-sample';

/**
 * CSV for anything; Excel when the destination is a spreadsheet, or when the
 * export wants tabs.
 *
 * **FCS 3.1 is removed** (2026-08-04, Item 11). The original brief asked for
 * gated subpopulations to be written back out as new `.fcs` files and that was
 * built, tested and shipped — `writeFcsSubset`, a real writer that round-tripped
 * a 71-parameter Aurora file with its instrument keywords, its `$SPILLOVER` and
 * a record of which population it held. It was removed by request, and the
 * writer went with the option rather than being left as unreachable code; the
 * project's own precedent for that is the compensation editor, deleted in full
 * on 2026-07-28 rather than hidden.
 *
 * The consequence is worth stating plainly rather than being discovered: a CSV
 * or an .xlsx carries the numbers and nothing else. No cytometer, no laser
 * settings, no acquisition keywords, no spillover matrix. Handing a population
 * to FlowJo or flowCore now means handing over a table.
 */
export type ExportFormat = 'csv' | 'xlsx';

export interface ColumnSelection {
  /** Parameter indices to include, in output order. */
  indices: number[];
  naming: ColumnNaming;
}

/** CSV field escaping: quote anything containing a delimiter, quote or newline. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvRow(fields: Array<string | number>): string {
  return fields.map((f) => (typeof f === 'number' ? String(f) : csvField(f))).join(',');
}

/* -------------------------------------------------------------------------
   Time, in seconds rather than ticks
   ------------------------------------------------------------------------- */

/*
   `timeParameterIndex`, `timeScaleFor` and `timePrecision` moved to
   `core/timeUnits.ts` on 2026-08-10 and are re-exported here unchanged, so every
   existing import and every existing test keeps working.

   They moved because the plot needed them too — a Time axis was drawing raw
   ticks under M/K abbreviation — and the alternative was `derivedStore`
   importing the whole export planner to ask what a tick is worth. Which module
   owns the answer matters here more than usual: the entire class of defect is
   two surfaces disagreeing about a unit, so there is one function and both read
   it. The export still applies the scale itself; see the note in `timeUnits`.
*/
export { timeParameterIndex, timePrecision, timeScaleFor } from './timeUnits';

/**
 * Column header for a parameter under the chosen naming scheme.
 *
 * **`name` — the detector short name, `$PnN` — is the default**, changed from
 * `both` on 2026-08-02. The original reasoning for `both` was that a reader
 * thinks in markers, so carrying `B2-A (CD4 FITC)` loses nothing; what it does
 * lose is the ability to address a column programmatically. `$PnN` is unique
 * within a file by the standard's own rules, it is what `$SPILLOVER`, `$TR` and
 * every gating definition reference, and it is what the same channel is called
 * in the FCS the export sits beside — so a script that reads both formats reads
 * one set of names. `$PnS` is empty in every file in this workspace anyway,
 * which made `both` render as the detector name with brackets nobody asked for.
 * The other two remain selectable.
 *
 * **Time carries its unit**, and only when the values are actually in it: `Time
 * (s)` when `$TIMESTEP` is present and the conversion is applied, plain `Time`
 * when it is absent and the column is still raw ticks. The header is the only
 * place a CSV can state a unit, so it has to track what was written rather than
 * what was intended.
 */
export function columnHeader(md: FcsMetadata, index: number, naming: ColumnNaming): string {
  const p = md.parameters[index];
  if (!p) return `P${index + 1}`;
  const stain = p.stain.trim();
  const base = naming === 'stain'
    ? stain || p.name
    : naming === 'both'
      ? (stain ? `${p.name} (${stain})` : p.name)
      : p.name;
  return p.type === 'Time' && timeScaleFor(md) !== null ? `${base} (s)` : base;
}

/**
 * Every parameter in the file, in file order, **Time included**.
 *
 * There is no column selection any more — no checklist, no per-export step, and
 * no Time toggle. An exported population is the events of that population, and
 * choosing which of a 71-parameter panel to keep is a decision that belongs in
 * whatever reads the file, where it can be revisited. The old default dropped
 * Time behind a checkbox, which is the worst of both: `$TIMESTEP` acquisition-
 * stability QC is the one thing every downstream package expects to find and the
 * one thing a re-export cannot reconstruct.
 *
 * Kept as a function, and kept returning indices, because `eventsToCsv` and the
 * FCS writer both take a list and the *order* is the file's own.
 */
export function defaultColumns(md: FcsMetadata): number[] {
  return md.parameters.map((_p, i) => i);
}

/**
 * A per-event column that is not in the file.
 *
 * Two kinds reach here, both of them things the application computed rather than
 * read: an **unmixed abundance** — what the solve attributed to one dye across
 * every detector — and a **derived parameter**, a user's own expression over the
 * channels. Both have been plottable and gateable for some time and neither
 * could be exported, which for the unmixed ones meant the four-step wizard
 * produced a result that could not leave the application: UMAP, clustering and
 * every downstream tool take a table.
 *
 * Values rather than indices, because the two live behind different resolvers in
 * `state/` and `core/export.ts` is deliberately free of store imports. The
 * caller — which already holds a `ParsedFcs` and the two functions that resolve
 * a virtual index — does the lookup and hands over columns.
 */
export interface ExtraColumn {
  header: string;
  /** One value per event, in file order. Length must be the event count. */
  values: Float32Array;
}

export interface EventCsvOptions {
  columns: ColumnSelection;
  valueMode: ValueMode;
  /** Display-space columns, required when `valueMode` is 'transformed'. */
  transformed?: (parameterIndex: number) => Float32Array;
  /**
   * Computed columns, written after the file's own.
   *
   * After, and never interleaved: the file's parameters go out in `$PnN` order
   * because that order is a property of the acquisition, and anything that
   * matches a CSV against the `.fcs` beside it matches on the leading block.
   */
  extraColumns?: ExtraColumn[];
  /** Extra leading columns, e.g. sample_id / population for combined exports. */
  leadingColumns?: { headers: string[]; values: string[] };
  /** Number of decimal places. */
  precision?: number;
  /** Emit only the header row — used by the live preview. */
  headerOnly?: boolean;
  /** Cap the number of event rows — used by the live preview. */
  maxRows?: number;
}

/**
 * Serialise the events of one population to CSV.
 *
 * Built as an array join rather than string concatenation: a 170 000-event ×
 * 70-column export is ~12M fields, and repeated `+=` on a string of that size
 * is quadratic in V8's rope representation once it flattens.
 */
export function eventsToCsv(
  parsed: ParsedFcs,
  eventIndices: Uint32Array,
  opts: EventCsvOptions,
): string {
  const { headers, source, scaleOf, precisionOf, count } = eventColumns(parsed, opts);

  const lines: string[] = [csvRow(headers)];
  if (opts.headerOnly) return lines[0]!;

  const lead = opts.leadingColumns?.values ?? [];
  const leadStr = lead.length ? `${lead.map(csvField).join(',')},` : '';
  const limit = opts.maxRows !== undefined ? Math.min(opts.maxRows, eventIndices.length) : eventIndices.length;

  const fields = new Array<string>(count);
  for (let r = 0; r < limit; r++) {
    const e = eventIndices[r]!;
    for (let c = 0; c < count; c++) {
      const v = source[c]![e]! * scaleOf[c]!;
      // Round-trip-safe but compact: trailing zeros are noise in a 12M-field file.
      fields[c] = Number.isFinite(v) ? trimNumber(v, precisionOf[c]!) : '';
    }
    lines.push(leadStr + fields.join(','));
  }
  return lines.join('\r\n');
}

/**
 * Everything the two serialisers need in order to agree with each other.
 *
 * Extracted (2026-08-04, Item 11) when Excel joined CSV as an output format.
 * Which columns, under which headings, with the `$TIMESTEP` conversion applied
 * and at what precision, are not presentation details — they are what the
 * numbers *mean*. Two exports of the same population that disagree about any of
 * them is the class of defect the whole of 2026-08-03 went on, so there is one
 * function that answers the question and two that render the answer.
 */
function eventColumns(parsed: ParsedFcs, opts: EventCsvOptions) {
  const md = parsed.metadata;
  const n = md.eventCount;
  const { indices, naming } = opts.columns;
  const precision = opts.precision ?? 4;

  const extra = opts.extraColumns ?? [];

  const headers = [
    ...(opts.leadingColumns?.headers ?? []),
    ...indices.map((i) => columnHeader(md, i, naming)),
    ...extra.map((c) => c.header),
  ];

  const source = [
    ...(opts.valueMode === 'transformed' && opts.transformed
      ? indices.map((i) => opts.transformed!(i))
      : indices.map((i) => parsed.data.subarray(i * n, (i + 1) * n))),
    ...extra.map((c) => c.values),
  ];

  /*
     Ticks → seconds, on the Time column only.

     Applied in **both** value modes on purpose. Time's transform is linear and
     its forward is the identity, so the "as displayed" column is the same ticks
     the raw one holds — writing it unconverted under a `Time (s)` header would
     put the bug back for anybody who happened to pick transformed values. The
     multiply by 1.0 on every other column is exact and costs a multiply per
     field, which is nothing beside the `toFixed` beside it.
  */
  const timeIndex = timeParameterIndex(md);
  const scale = timeScaleFor(md);
  const scaleOf = [
    ...indices.map((i) => (i === timeIndex && scale !== null ? scale : 1)),
    // A computed column is already in the units it means — an abundance, or
    // whatever the user's expression produced — so there is nothing to convert.
    ...extra.map(() => 1),
  ];
  const precisionOf = scaleOf.map((s) => (s === 1 ? precision : timePrecision(s, precision)));

  return { headers, source, scaleOf, precisionOf, count: source.length };
}

/** The header row an Excel sheet of these events opens with. */
export function eventHeaders(parsed: ParsedFcs, opts: EventCsvOptions): string[] {
  return eventColumns(parsed, opts).headers;
}

/**
 * The same events as `eventsToCsv`, a row at a time, as **numbers**.
 *
 * A generator, because this feeds the XLSX writer and that writer compresses a
 * sheet as the sheet is produced (see `core/xlsx.ts`). Materialising 170 000
 * rows here would defeat the only reason it streams.
 *
 * Numbers rather than the CSV's strings: a spreadsheet cell holding text is not
 * a measurement — it will not chart, will not average, and sorts
 * lexicographically, so `10` lands between `1` and `2`. They are still rounded
 * to **the same decimal places the CSV would use**, through the same
 * `precisionOf`, so two exports of one population hold the same values rather
 * than differing in the sixteenth digit; the Time column keeps its own precision
 * derived from `$TIMESTEP`.
 */
export function* eventRows(
  parsed: ParsedFcs,
  eventIndices: Uint32Array,
  opts: EventCsvOptions,
): Generator<Array<number | string>> {
  const { source, scaleOf, precisionOf, count } = eventColumns(parsed, opts);
  const lead = opts.leadingColumns?.values ?? [];
  const limit = opts.maxRows !== undefined ? Math.min(opts.maxRows, eventIndices.length) : eventIndices.length;

  for (let r = 0; r < limit; r++) {
    const e = eventIndices[r]!;
    const row: Array<number | string> = lead.length ? [...lead] : [];
    for (let c = 0; c < count; c++) {
      const v = source[c]![e]! * scaleOf[c]!;
      // NaN reaches the writer as NaN and becomes an empty cell — see `cellXml`.
      row.push(Number.isFinite(v) ? Number(v.toFixed(precisionOf[c]!)) : NaN);
    }
    yield row;
  }
}

function trimNumber(v: number, precision: number): string {
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/* -------------------------------------------------------------------------
   Full Gate Export
   ------------------------------------------------------------------------- */

export interface ExportTarget {
  sampleId: string;
  sampleName: string;
  gateId: string;
  populationName: string;
  populationPath: string;
  parentName: string;
  eventCount: number;
}

/**
 * What happened to one sample × population, for the run's results table.
 *
 * Still called a manifest entry, because that is what it is; it is no longer
 * written to a file. See the header note.
 */
export interface ManifestEntry extends ExportTarget {
  status: 'written' | 'skipped-empty' | 'skipped-missing' | 'failed';
  /** Filename written, for per-population exports. */
  file: string | null;
  reason?: string;
}

/**
 * What one results row says happened, in words rather than in field values.
 *
 * `ManifestEntry.status` is the right vocabulary for a record and the wrong one
 * for a badge. It rendered verbatim — `completed`, `empty`, `missing`, `failed`,
 * lowercase, because that is how the strings are spelled in the type — and every
 * other word this application puts on screen is sentence case, so one column of
 * lowercase read as a different kind of thing entirely (2026-08-11, Item 4).
 *
 * Here rather than in `ExportView` because the vocabulary is here: a status and
 * its label are one decision, and two files is how they come to disagree.
 */
export function statusLabel(status: ManifestEntry['status']): string {
  switch (status) {
    // "Completed", not "Written": the tile above the table says the same word,
    // and what a reader is checking is the outcome rather than the mechanism.
    case 'written': return 'Completed';
    case 'skipped-empty': return 'Empty';
    case 'skipped-missing': return 'Missing';
    case 'failed': return 'Failed';
  }
}

export interface ExportPlan {
  targets: ExportTarget[];
  sampleCount: number;
  populationCount: number;
  /** Combinations that will produce a file. */
  fileCount: number;
  totalEvents: number;
  estimatedBytes: number;
  /** Combinations that will be skipped, with why. */
  skipped: ManifestEntry[];
}

/**
 * Filesystem-safe name, preserving readability.
 *
 * A whitelist rather than a blacklist of forbidden characters: the blacklist
 * form needs a trailing dash inside the character class, which made the
 * neighbouring space ambiguous and silently stopped matching it. Allowing only
 * known-safe characters cannot fail that way, and covers every platform at once.
 */
export function safeName(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9._+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    // Windows rejects a trailing dot.
    .replace(/[.]+$/, '');
  return cleaned || 'unnamed';
}

export interface PlanInput {
  sampleId: string;
  sampleName: string;
  gates: Gate[];
  /** gateId → event count for this sample. */
  counts: Map<string, number>;
  totalEvents: number;
}

/**
 * The path the ungated root population is selected and reported under.
 *
 * A path rather than `ROOT_ID` because that is what the selection is keyed by —
 * see `planFullExport`.
 */
export const ROOT_PATH = 'All events';

/**
 * Work out exactly what a Full Gate Export will produce, before running it.
 *
 * The pre-export summary the brief asks for depends on this: users need
 * "6 samples × 14 populations = 84 files, ~X events, ~Y MB" *before* committing,
 * because a full workspace export can be very large.
 *
 * ## Choosing populations
 *
 * `selectedPaths` narrows the export to named populations; `null` means every one,
 * which is what the feature did and still does by default.
 *
 * Keyed by **population path** rather than by gate id, and that is the one
 * decision in here worth arguing. Gating is shared across samples, so a gate id
 * *usually* identifies the same population everywhere — but a sample that has been
 * explicitly unlinked carries a fork whose gates have **fresh ids**, so selecting
 * `g7` would export the population from five samples and silently skip the sixth.
 * A path — `Lymphocytes/CD3+/CD4+` — is what the two hierarchies genuinely have in
 * common, it is what the tree in the export dialog is built from, it is what the
 * results table reports, and it is what a user would say if asked which
 * population they meant.
 */
export function planFullExport(
  inputs: PlanInput[],
  columnCount: number,
  shape: ExportShape,
  includeRoot = true,
  format: ExportFormat = 'csv',
  selectedPaths: ReadonlySet<string> | null = null,
): ExportPlan {
  const targets: ExportTarget[] = [];
  const skipped: ManifestEntry[] = [];
  const populationIds = new Set<string>();

  for (const input of inputs) {
    const entries: Array<{ gateId: string; name: string; path: string; parent: string }> = [];
    if (includeRoot) {
      entries.push({ gateId: ROOT_ID, name: ROOT_PATH, path: ROOT_PATH, parent: '' });
    }
    for (const g of input.gates) {
      const parent = g.parentId ? input.gates.find((x) => x.id === g.parentId)?.name ?? ROOT_PATH : ROOT_PATH;
      entries.push({ gateId: g.id, name: g.name, path: populationPath(input.gates, g.id), parent });
    }

    for (const e of entries) {
      // A population left unchecked in the tree is not a skip and does not belong
      // in the results table: nothing was attempted, so there is nothing to
      // report. That table is the record of what an export *tried* to do, and
      // filling it with every population the user deliberately did not ask for
      // would bury the entries that mean something — an empty population, or a
      // gate one sample does not have.
      if (selectedPaths && !selectedPaths.has(e.path)) continue;
      populationIds.add(e.gateId === ROOT_ID ? ROOT_ID : e.path);
      const count = e.gateId === ROOT_ID ? input.totalEvents : input.counts.get(e.gateId);

      const base: ExportTarget = {
        sampleId: input.sampleId,
        sampleName: input.sampleName,
        gateId: e.gateId,
        populationName: e.name,
        populationPath: e.path,
        parentName: e.parent,
        eventCount: count ?? 0,
      };

      if (count === undefined) {
        // The gate does not exist on this sample — expected when strategies
        // differ between samples, and exactly what the manifest is for.
        skipped.push({ ...base, status: 'skipped-missing', file: null, reason: 'Gate not defined on this sample' });
      } else if (count === 0) {
        skipped.push({ ...base, status: 'skipped-empty', file: null, reason: 'Population contains no events' });
      } else {
        targets.push(base);
      }
    }
  }

  const totalEvents = targets.reduce((a, t) => a + t.eventCount, 0);
  /*
     CSV: ~9 bytes per numeric field is close for typical flow magnitudes at 4 dp.

     XLSX: the same numbers as ~34 bytes of cell XML each, then DEFLATE'd. The
     ratio is measured rather than assumed — a sheet of 4-dp decimals in
     `<c r="AB1234"><v>…</v></c>` wrappers compresses to roughly a fifth, because
     the wrapper is the same eleven characters on every cell and the references
     are near-sequential. That lands an .xlsx a shade under the CSV of the same
     data, which is worth the estimate being roughly right rather than an order
     out.
  */
  const estimatedBytes = format === 'xlsx'
    ? Math.round(totalEvents * columnCount * 34 * 0.2) + targets.length * 4 * 1024
    : totalEvents * columnCount * 9;

  return {
    targets,
    sampleCount: inputs.length,
    populationCount: populationIds.size,
    // A workbook per sample holds every one of that sample's populations as a
    // tab, so the file count is the number of samples that produced anything —
    // not the number of populations, and not `inputs.length`, since a sample
    // whose every population was empty or unselected produces no workbook.
    fileCount: shape === 'workbook-per-sample'
      ? new Set(targets.map((t) => t.sampleId)).size
      : targets.length,
    totalEvents,
    estimatedBytes,
    skipped,
  };
}

/* -------------------------------------------------------------------------
   Which populations to export
   ------------------------------------------------------------------------- */

/** One row of the export dialog's population tree. */
export interface PopulationNode {
  /** `Cells/CD3+/CD4+`. The key the selection is held by. */
  path: string;
  name: string;
  /** Indentation, matching the sidebar's tree. Root is 0. */
  depth: number;
  /** Path of the node above, or null for the root row. */
  parentPath: string | null;
  /** How many loaded samples carry a population at this path. */
  sampleCount: number;
  /** Events across every sample that carries it. */
  eventCount: number;
}

/**
 * The union of every sample's gating, as one tree keyed by population path.
 *
 * A union rather than one sample's hierarchy, because the dialog has to be able to
 * offer a population that exists on five of six samples — that is precisely the
 * case the `skipped-missing` status exists for, and a tree built from whichever
 * sample happened to be first would hide it. `sampleCount` is what says so on the
 * row.
 *
 * Ordered depth-first in first-seen order, so it reads like the sidebar tree the
 * user already knows rather than like a set.
 */
export function populationTree(inputs: PlanInput[], includeRoot = true): PopulationNode[] {
  const byPath = new Map<string, PopulationNode>();
  const childOrder = new Map<string | null, string[]>();

  const note = (path: string, name: string, parentPath: string | null, depth: number, events: number) => {
    const existing = byPath.get(path);
    if (existing) {
      existing.sampleCount++;
      existing.eventCount += events;
      return;
    }
    byPath.set(path, { path, name, depth, parentPath, sampleCount: 1, eventCount: events });
    const siblings = childOrder.get(parentPath) ?? [];
    siblings.push(path);
    childOrder.set(parentPath, siblings);
  };

  if (includeRoot) {
    for (const input of inputs) note(ROOT_PATH, ROOT_PATH, null, 0, input.totalEvents);
  }

  for (const input of inputs) {
    // Topological order is not needed — a path carries its own depth — but walking
    // the gate list in order keeps siblings in the order they were drawn, which is
    // the order the sidebar shows them in.
    for (const g of input.gates) {
      const path = populationPath(input.gates, g.id);
      const cut = path.lastIndexOf('/');
      const parentPath = cut < 0 ? (includeRoot ? ROOT_PATH : null) : path.slice(0, cut);
      const depth = path.split('/').length - (includeRoot ? 0 : 1);
      note(path, g.name, parentPath, depth, input.counts.get(g.id) ?? 0);
    }
  }

  // Depth-first from the roots, so a parent is always immediately above its
  // children and the indentation is readable as containment.
  const out: PopulationNode[] = [];
  const walk = (parentPath: string | null) => {
    for (const path of childOrder.get(parentPath) ?? []) {
      const node = byPath.get(path);
      if (!node) continue;
      out.push(node);
      walk(path);
    }
  };
  walk(null);
  return out;
}

/** Every path in the tree — the "select all" answer, and the default. */
export function allPaths(tree: PopulationNode[]): Set<string> {
  return new Set(tree.map((n) => n.path));
}

/**
 * Toggle a node and everything under it.
 *
 * The familiar checkbox-tree behaviour, and the useful one here: "export
 * Lymphocytes and everything inside it" is the common request, and a parent that
 * selected only itself would make it N clicks. Selecting exactly one population
 * with children is still possible — check the parent, then uncheck the children —
 * and unchecking a child never unchecks its parent, because a parent population is
 * a real population in its own right rather than a folder.
 *
 * **The root row is the one exception, and it has to be.** Every gate descends from
 * *All events*, so cascading from it selects the entire tree — which makes the row
 * a second Select all, sitting forty pixels from the first. What the row means is
 * the thing the checkbox it replaced meant: *also export the ungated population*.
 * So it toggles only itself.
 */
export function toggleSubtree(
  tree: PopulationNode[],
  selected: ReadonlySet<string>,
  path: string,
): Set<string> {
  const subtree = path === ROOT_PATH ? [ROOT_PATH] : subtreePaths(tree, path);
  // Fully selected → clear it; anything else (none, or partial) → select it all.
  // Partial going to "all" rather than to "none" is what makes a half-checked
  // parent a single click away from the state the user is obviously reaching for.
  const on = !subtree.every((p) => selected.has(p));
  const next = new Set(selected);
  for (const p of subtree) {
    if (on) next.add(p);
    else next.delete(p);
  }
  return next;
}

/** A node and all its descendants, by path. */
export function subtreePaths(tree: PopulationNode[], path: string): string[] {
  const out = [path];
  const children = (parent: string) => tree.filter((n) => n.parentPath === parent);
  const walk = (parent: string) => {
    for (const c of children(parent)) { out.push(c.path); walk(c.path); }
  };
  walk(path);
  return out;
}

/**
 * How a node's own checkbox should render.
 *
 * `mixed` is the tri-state a checkbox-tree needs: it says "something below this is
 * selected" without claiming the node itself is, which is the difference between a
 * tree you can read and one you have to expand to understand.
 */
export function nodeState(
  tree: PopulationNode[],
  selected: ReadonlySet<string>,
  path: string,
): 'on' | 'off' | 'mixed' {
  const own = selected.has(path);
  // The root row does not cascade, so it does not report a partial state either —
  // it would otherwise read `mixed` while being exactly as checked as the user left
  // it. See `toggleSubtree`.
  if (path === ROOT_PATH) return own ? 'on' : 'off';
  const descendants = subtreePaths(tree, path).slice(1);
  const anyBelow = descendants.some((p) => selected.has(p));
  const allBelow = descendants.every((p) => selected.has(p));
  if (own && (descendants.length === 0 || allBelow)) return 'on';
  if (!own && !anyBelow) return 'off';
  return 'mixed';
}

/**
 * Filename for one exported population. **Flat** — no directory component.
 *
 * `SampleName_PopulationName.csv`, straight into the chosen folder. It was
 * `SampleName/SampleName_PopulationName.csv`, which nested a folder whose name
 * was already the first half of every filename inside it, so the tree carried no
 * information the names did not. Flattening is what makes the manifest
 * unnecessary rather than merely unfashionable: the two facts a reader needs —
 * which sample, which population — are in the name, so `ls`, a glob, a file
 * manager's sort and a spreadsheet's title bar all answer the question that
 * previously required opening a CSV of metadata.
 *
 * The one thing a flat list gives up is collision safety, and it is worth being
 * precise about where: two *different* populations can only collide if their
 * names collide after `safeName`, which is the same collision the nested form
 * had inside one sample's folder. Nesting never protected against it.
 */
export function targetPath(t: ExportTarget, format: ExportFormat = 'csv'): string {
  return `${safeName(t.sampleName)}_${safeName(t.populationName)}.${format}`;
}

/**
 * Filename for one sample's whole workbook, under `workbook-per-sample`.
 *
 * The population is not in the name because it is not a property of the file —
 * every population this sample carries is a tab inside it. That is the whole
 * distinction between the two shapes, and it is the one place where nesting the
 * populations under the sample is the right call rather than the mistake the
 * folder-per-sample tree was: a tab is *addressable* from inside the file the
 * way a directory entry is not, so nothing has to be globbed to find one.
 */
export function workbookPath(sampleName: string): string {
  return `${safeName(sampleName)}.xlsx`;
}

/* The combined long-format shape's leading columns — `COMBINED_LEADING_HEADERS`
   and `combinedLeadingValues` — are gone with the shape (2026-08-04, Item 11).
   `leadingColumns` on `EventCsvOptions` survives them: it is a general facility,
   nothing about it was specific to that shape, and the per-sample workbook does
   not use it because a tab name already says which population a row is in. */

/* `manifestToCsv` and `manifestToJson` are gone — see the header note. An export
   writes data files and nothing else; what was in them is on screen when the run
   finishes, in the results table, which is where it was actually read. */

/** Human-readable byte size for the pre-export summary. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Event indices for a population, from an evaluated mask. */
export function indicesFor(masks: Map<string, Uint8Array>, gateId: string): Uint32Array {
  const mask = masks.get(gateId);
  return mask ? maskToIndices(mask) : new Uint32Array(0);
}
