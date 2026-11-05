/**
 * Reading the CSV this application wrote.
 *
 * ## Why a parser of our own
 *
 * The UMAP panel's input is **Gate Export's output**: one file per
 * sample-population, a header row of parameter names, then numeric rows. That is
 * a narrow, known shape, and a general CSV library would bring quoting modes,
 * type inference and a row-of-objects representation this panel would
 * immediately have to undo — a 300 000 × 40 table as objects is tens of millions
 * of boxed numbers.
 *
 * So this reads straight into **column-major `Float32Array`s**, the same layout
 * `ParsedFcs` uses and for the same reason: every consumer here wants a column
 * at a time, and a projection over 40 columns should touch 40 buffers rather
 * than walk a million objects. It is the one representation in the panel.
 *
 * ## What it accepts
 *
 * Quoted fields with embedded commas and doubled quotes, because `csvField`
 * writes them. `\r\n` and `\n`. A trailing newline. Anything that is not a
 * finite number becomes `NaN` and its row is dropped by `dropIncompleteRows` —
 * a half-parsed event is worse than a missing one, and silently reading a text
 * column as zeros would put a stripe through the middle of the projection.
 */

export interface CsvTable {
  /** Column headers, in file order. */
  headers: string[];
  /** One `Float32Array` per header, all the same length. */
  columns: Float32Array[];
  /** Rows kept. */
  count: number;
  /** Rows dropped for holding something that is not a number. */
  dropped: number;
}

/** Split one CSV line, honouring quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        // A doubled quote is a literal one — the escape `csvField` emits.
        if (line[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/**
 * Parse a whole CSV into columns.
 *
 * Two passes: one to count rows so the buffers are allocated once at their final
 * size, one to fill them. Growing 40 `Float32Array`s by doubling would copy the
 * whole table five times on a 300 000-row export, which on the main thread is
 * exactly the freeze this panel is supposed not to have.
 */
export function parseCsvTable(text: string): CsvTable {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);

  // A trailing newline leaves an empty last element; so does a blank line in the
  // middle of a file somebody edited.
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  if (first >= lines.length) return { headers: [], columns: [], count: 0, dropped: 0 };

  const headers = splitCsvLine(lines[first]!).map((h) => h.trim());
  const width = headers.length;
  if (width === 0) return { headers: [], columns: [], count: 0, dropped: 0 };

  let rows = 0;
  for (let i = first + 1; i < lines.length; i++) if (lines[i]!.trim() !== '') rows++;

  const columns = headers.map(() => new Float32Array(rows));
  let at = 0;
  let dropped = 0;

  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const fields = splitCsvLine(line);
    // A row of the wrong width is a different table, not a value to guess at.
    if (fields.length !== width) { dropped++; continue; }

    let ok = true;
    for (let c = 0; c < width; c++) {
      const v = Number(fields[c]);
      if (!Number.isFinite(v)) { ok = false; break; }
      columns[c]![at] = v;
    }
    if (ok) at++; else dropped++;
  }

  // Trimmed to what was actually kept, so `count` and `length` agree everywhere
  // downstream and nothing has to remember to stop early.
  const trimmed = at === rows ? columns : columns.map((c) => c.subarray(0, at));
  return { headers, columns: trimmed as Float32Array[], count: at, dropped };
}

/**
 * Do two tables describe the same measurements?
 *
 * **By name and order, never by count** — the same rule the unmixing matrices
 * follow, and it is here for the same reason. Column *k* of one file and column
 * *k* of another are only the same parameter if they are named the same, and a
 * projection built from two files whose columns disagree produces a picture that
 * is plausible and wrong rather than an error.
 */
export function headersMatch(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}
