import {
  FcsParseError,
  type AcquisitionType,
  type FcsMetadata,
  type FcsParameter,
  type FcsVersion,
  type FcsWarning,
  type ParameterType,
  type ParsedFcs,
  type SpilloverMatrix,
} from './types';

/* ==========================================================================
   FCS 2.0 / 3.0 / 3.1 reader.
   ========================================================================== */

const TEXT_DECODER_LATIN1 = new TextDecoder('latin1');
const TEXT_DECODER_UTF8 = new TextDecoder('utf-8');

interface HeaderOffsets {
  version: FcsVersion;
  textStart: number;
  textEnd: number;
  dataStart: number;
  dataEnd: number;
  analysisStart: number;
  analysisEnd: number;
}

/* -------------------------------------------------------------------------
   HEADER
   ------------------------------------------------------------------------- */

function parseHeader(bytes: Uint8Array): HeaderOffsets {
  if (bytes.length < 58) {
    throw new FcsParseError(
      'File is too short to be an FCS file.',
      'The HEADER alone requires 58 bytes; this file has ' + bytes.length + '.',
    );
  }

  const version = ascii(bytes, 0, 6).trim() as FcsVersion;
  if (!/^FCS[23]\.\d$/.test(version)) {
    throw new FcsParseError(
      `Not an FCS file — expected a version stamp like "FCS3.1", found "${sanitise(version)}".`,
      'Check that the file is a Flow Cytometry Standard data file and is not corrupted.',
    );
  }
  if (version !== 'FCS2.0' && version !== 'FCS3.0' && version !== 'FCS3.1' && version !== 'FCS3.2') {
    throw new FcsParseError(`Unsupported FCS version "${sanitise(version)}".`, 'Supported: FCS 2.0, 3.0, 3.1, 3.2.');
  }

  // Six 8-byte, space-padded, right-justified ASCII integers.
  const num = (start: number) => {
    const s = ascii(bytes, start, start + 8).trim();
    if (s === '') return 0;
    const v = Number.parseInt(s, 10);
    return Number.isFinite(v) ? v : 0;
  };

  return {
    version,
    textStart: num(10),
    textEnd: num(18),
    dataStart: num(26),
    dataEnd: num(34),
    analysisStart: num(42),
    analysisEnd: num(50),
  };
}

/* -------------------------------------------------------------------------
   TEXT segment
   ------------------------------------------------------------------------- */

/**
 * Split a TEXT segment into keyword/value pairs.
 *
 * The first byte is the delimiter. A **doubled delimiter is an escaped literal**,
 * not an empty token — getting this wrong silently corrupts every keyword after
 * the first value that contains the delimiter character. The Aurora files use
 * 0x0C (form feed) as their delimiter.
 */
function parseTextSegment(bytes: Uint8Array, start: number, end: number, utf8: boolean): Record<string, string> {
  if (start <= 0 || end < start || end >= bytes.length) return {};

  const decoder = utf8 ? TEXT_DECODER_UTF8 : TEXT_DECODER_LATIN1;
  const raw = decoder.decode(bytes.subarray(start, end + 1));
  if (raw.length === 0) return {};

  const delim = raw[0]!;
  const body = raw.slice(1);

  const tokens: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === delim) {
      if (body[i + 1] === delim) {
        cur += delim;
        i++;
        continue;
      }
      tokens.push(cur);
      cur = '';
    } else {
      cur += body[i];
    }
  }
  // A trailing delimiter is normal; anything left over is a final unterminated token.
  if (cur.length > 0) tokens.push(cur);

  const kv: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const key = tokens[i]!.trim();
    if (key) kv[key] = tokens[i + 1]!;
  }
  return kv;
}

/* -------------------------------------------------------------------------
   Parameters
   ------------------------------------------------------------------------- */

function normaliseParameterType(raw: string | undefined, name: string): ParameterType {
  const t = (raw ?? '').trim();
  if (t) {
    if (t === 'Time') return 'Time';
    if (t === 'Forward_Scatter') return 'Forward_Scatter';
    if (t === 'Side_Scatter') return 'Side_Scatter';
    if (t === 'Raw_Fluorescence') return 'Raw_Fluorescence';
    if (t === 'Unmixed_Fluorescence') return 'Unmixed_Fluorescence';
    return 'Other';
  }
  // No $PnTYPE (FCS 2.0/3.0, most non-Cytek writers) — infer from the name.
  const n = name.toUpperCase();
  if (n === 'TIME' || n.startsWith('TIME')) return 'Time';
  if (n.startsWith('FSC')) return 'Forward_Scatter';
  if (n.startsWith('SSC')) return 'Side_Scatter';
  return 'Other';
}

function parseParameters(kv: Record<string, string>, count: number): FcsParameter[] {
  const params: FcsParameter[] = [];
  for (let i = 1; i <= count; i++) {
    const name = (kv[`$P${i}N`] ?? '').trim();
    if (!name) {
      throw new FcsParseError(
        `Parameter ${i} has no $P${i}N (short name) keyword.`,
        'The TEXT segment may be truncated or the $PAR count may be wrong.',
      );
    }
    const stain = (kv[`$P${i}S`] ?? '').trim();
    const bits = Number.parseInt(kv[`$P${i}B`] ?? '', 10);
    if (!Number.isFinite(bits) || bits <= 0) {
      throw new FcsParseError(
        `Parameter ${i} (${sanitise(name)}) has an invalid $P${i}B bit width: "${sanitise(kv[`$P${i}B`] ?? '')}".`,
      );
    }

    // $PnE is "f1,f2": f1 log decades (0 = linear), f2 the value at channel 0.
    const eRaw = (kv[`$P${i}E`] ?? '0,0').split(',');
    const decades = Number.parseFloat(eRaw[0] ?? '0') || 0;
    const offset = Number.parseFloat(eRaw[1] ?? '0') || 0;

    const gainRaw = Number.parseFloat(kv[`$P${i}G`] ?? '');
    const voltRaw = Number.parseFloat(kv[`$P${i}V`] ?? '');
    const type = normaliseParameterType(kv[`$P${i}TYPE`], name);

    params.push({
      index: i,
      name,
      stain,
      label: stain || name,
      bits,
      range: Number.parseFloat(kv[`$P${i}R`] ?? '0') || 0,
      amplification: [decades, offset],
      gain: Number.isFinite(gainRaw) ? gainRaw : null,
      voltage: Number.isFinite(voltRaw) ? voltRaw : null,
      type,
      isDataChannel: type !== 'Time',
    });
  }
  return params;
}

/* -------------------------------------------------------------------------
   Spillover
   ------------------------------------------------------------------------- */

function parseSpillover(raw: string | undefined, warnings: FcsWarning[]): SpilloverMatrix | null {
  if (!raw || !raw.trim()) return null;

  const parts = raw.split(',').map((s) => s.trim());
  const n = Number.parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  const expected = 1 + n + n * n;
  if (parts.length < expected) {
    warnings.push({
      code: 'missing-spillover',
      message: 'The spillover matrix in this file is malformed and was ignored.',
      detail: `Declared ${n}×${n}, which needs ${expected} comma-separated fields, but found ${parts.length}.`,
    });
    return null;
  }

  const parameters = parts.slice(1, 1 + n);
  const values = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) values[i] = Number.parseFloat(parts[1 + n + i] ?? '0') || 0;

  let isIdentity = true;
  for (let r = 0; r < n && isIdentity; r++) {
    for (let c = 0; c < n; c++) {
      const v = values[r * n + c]!;
      // 1e-6 tolerance: SpectroFlo writes exact 1.0 diagonals but occasionally a
      // stray 1e-6 off-diagonal, which is numerically a no-op.
      if (r === c ? Math.abs(v - 1) > 1e-6 : Math.abs(v) > 1e-6) {
        isIdentity = false;
        break;
      }
    }
  }

  return { parameters, values, size: n, isIdentity };
}

/* -------------------------------------------------------------------------
   DATA segment
   ------------------------------------------------------------------------- */

/**
 * Read the DATA segment into a column-major Float32Array.
 *
 * Handles $DATATYPE F (float32), D (float64), I (integer, byte-aligned or
 * bit-packed) and A (ASCII), honouring $BYTEORD, $PnR masking, $PnG gain and
 * $PnE log amplification.
 */
function readData(
  bytes: Uint8Array,
  start: number,
  end: number,
  params: FcsParameter[],
  eventCount: number,
  dataType: 'I' | 'F' | 'D' | 'A',
  little: boolean,
  warnings: FcsWarning[],
): Float32Array {
  const nPar = params.length;
  const out = new Float32Array(nPar * eventCount);
  if (eventCount === 0) return out;

  const view = new DataView(bytes.buffer, bytes.byteOffset + start, Math.max(0, end - start + 1));

  if (dataType === 'A') {
    readAsciiData(bytes, start, end, nPar, eventCount, out, warnings);
  } else if (dataType === 'F') {
    const stride = nPar * 4;
    for (let e = 0; e < eventCount; e++) {
      const base = e * stride;
      for (let p = 0; p < nPar; p++) out[p * eventCount + e] = view.getFloat32(base + p * 4, little);
    }
  } else if (dataType === 'D') {
    const stride = nPar * 8;
    for (let e = 0; e < eventCount; e++) {
      const base = e * stride;
      // Narrowed to float32 on store. Flow data never needs more than 24 bits of
      // mantissa, and halving the working set matters at 1M+ events.
      for (let p = 0; p < nPar; p++) out[p * eventCount + e] = view.getFloat64(base + p * 8, little);
    }
  } else {
    readIntegerData(view, params, eventCount, little, out);
  }

  // Post-read per-parameter corrections.
  for (let p = 0; p < nPar; p++) {
    const prm = params[p]!;
    const col = out.subarray(p * eventCount, (p + 1) * eventCount);

    // $PnE log amplification (integer data only; float data is already linear).
    const [decades, zeroValue] = prm.amplification;
    if (dataType === 'I' && decades > 0 && prm.range > 0) {
      const f2 = zeroValue === 0 ? 1 : zeroValue;
      for (let i = 0; i < col.length; i++) col[i] = f2 * Math.pow(10, (decades * col[i]!) / prm.range);
    }

    // $PnG gain.
    if (prm.gain !== null && prm.gain !== 0 && prm.gain !== 1) {
      const g = prm.gain;
      for (let i = 0; i < col.length; i++) col[i] = col[i]! / g;
    }
  }

  let nonFinite = 0;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i]!)) nonFinite++;
  if (nonFinite > 0) {
    warnings.push({
      code: 'non-finite-values',
      message: `${nonFinite.toLocaleString()} non-finite value${nonFinite === 1 ? '' : 's'} in the data segment were read as-is.`,
      detail: 'NaN or Infinity in the DATA segment usually indicates a corrupt file or an upstream processing error.',
    });
  }

  return out;
}

function readIntegerData(
  view: DataView,
  params: FcsParameter[],
  eventCount: number,
  little: boolean,
  out: Float32Array,
): void {
  const nPar = params.length;
  const bitsPerEvent = params.reduce((a, p) => a + p.bits, 0);
  const byteAligned = params.every((p) => p.bits % 8 === 0);

  // Masks: when $PnR needs fewer bits than $PnB, the high bits are undefined and
  // must be masked off (FCS 3.1 §3.3.4).
  const masks = params.map((p) => {
    if (p.range <= 0) return null;
    const needed = Math.ceil(Math.log2(p.range));
    if (needed >= p.bits || needed <= 0 || needed > 32) return null;
    return (1 << needed) - 1;
  });

  if (byteAligned) {
    const widths = params.map((p) => p.bits / 8);
    const strideBytes = bitsPerEvent / 8;
    const offsets: number[] = [];
    let acc = 0;
    for (const w of widths) {
      offsets.push(acc);
      acc += w;
    }

    for (let e = 0; e < eventCount; e++) {
      const base = e * strideBytes;
      for (let p = 0; p < nPar; p++) {
        const off = base + offsets[p]!;
        let v: number;
        switch (widths[p]!) {
          case 1: v = view.getUint8(off); break;
          case 2: v = view.getUint16(off, little); break;
          case 3: {
            const a = view.getUint8(off), b = view.getUint8(off + 1), c = view.getUint8(off + 2);
            v = little ? a | (b << 8) | (c << 16) : (a << 16) | (b << 8) | c;
            break;
          }
          case 4: v = view.getUint32(off, little); break;
          case 8: v = Number(view.getBigUint64(off, little)); break;
          default:
            throw new FcsParseError(
              `Unsupported integer width for parameter ${p + 1}: ${params[p]!.bits} bits.`,
              'Supported byte-aligned widths are 8, 16, 24, 32 and 64 bits.',
            );
        }
        const m = masks[p];
        out[p * eventCount + e] = m === null || m === undefined ? v : v & m;
      }
    }
  } else {
    // Bit-packed integers (legacy FCS 2.0). Rare but part of the standard.
    const reader = new BitReader(view);
    for (let e = 0; e < eventCount; e++) {
      for (let p = 0; p < nPar; p++) {
        const v = reader.read(params[p]!.bits);
        const m = masks[p];
        out[p * eventCount + e] = m === null || m === undefined ? v : v & m;
      }
    }
  }
}

/** MSB-first bit reader for non-byte-aligned integer DATA segments. */
class BitReader {
  private bytePos = 0;
  private bitPos = 0;
  constructor(private readonly view: DataView) {}
  read(bits: number): number {
    if (bits > 32) throw new FcsParseError(`Bit-packed parameter wider than 32 bits (${bits}) is not supported.`);
    let value = 0;
    let remaining = bits;
    while (remaining > 0) {
      if (this.bytePos >= this.view.byteLength) return value;
      const avail = 8 - this.bitPos;
      const take = Math.min(avail, remaining);
      const byte = this.view.getUint8(this.bytePos);
      const shift = avail - take;
      const chunk = (byte >> shift) & ((1 << take) - 1);
      value = (value << take) | chunk;
      this.bitPos += take;
      remaining -= take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return value >>> 0;
  }
}

function readAsciiData(
  bytes: Uint8Array,
  start: number,
  end: number,
  nPar: number,
  eventCount: number,
  out: Float32Array,
  warnings: FcsWarning[],
): void {
  const text = TEXT_DECODER_LATIN1.decode(bytes.subarray(start, end + 1));
  const fields = text.split(/[\s,]+/).filter((s) => s.length > 0);
  const needed = nPar * eventCount;
  if (fields.length < needed) {
    warnings.push({
      code: 'data-size-mismatch',
      message: `ASCII data segment holds ${fields.length.toLocaleString()} values but ${needed.toLocaleString()} were expected.`,
      detail: 'Missing values were left as zero.',
    });
  }
  for (let e = 0; e < eventCount; e++) {
    for (let p = 0; p < nPar; p++) {
      const f = fields[e * nPar + p];
      out[p * eventCount + e] = f === undefined ? 0 : Number.parseFloat(f) || 0;
    }
  }
}

/* -------------------------------------------------------------------------
   Metadata assembly
   ------------------------------------------------------------------------- */

/** `$DATE` appears as "28-Jul-2025", "2025-07-28" or "28-JUL-25" in the wild. */
function parseAcquiredAt(dateStr: string | undefined, timeStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const d = dateStr.trim();
  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  let y: number | null = null, mo: number | null = null, day: number | null = null;

  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(d);
  if (m) {
    day = +m[1]!;
    mo = MONTHS[m[2]!.toLowerCase()] ?? null;
    y = +m[3]!;
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d))) {
    y = +m[1]!; mo = +m[2]! - 1; day = +m[3]!;
  } else if ((m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d))) {
    day = +m[1]!; mo = +m[2]! - 1; y = +m[3]!;
  }
  if (y === null || mo === null || day === null) return null;

  let hh = 0, mm = 0, ss = 0;
  if (timeStr) {
    const t = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(timeStr.trim());
    if (t) { hh = +t[1]!; mm = +t[2]!; ss = +t[3]!; }
  }
  const date = new Date(y, mo, day, hh, mm, ss);
  return Number.isNaN(date.getTime()) ? null : date;
}

const str = (kv: Record<string, string>, key: string): string | null => {
  const v = kv[key]?.trim();
  return v ? v : null;
};
const num = (kv: Record<string, string>, key: string): number | null => {
  const v = Number.parseFloat(kv[key] ?? '');
  return Number.isFinite(v) ? v : null;
};

/* -------------------------------------------------------------------------
   Public entry point
   ------------------------------------------------------------------------- */

export interface ParseOptions {
  /** Which dataset to read when `$NEXTDATA` chains several. Default 0. */
  datasetIndex?: number;
}

/**
 * A file's event and parameter counts, from its HEADER and TEXT alone, or null
 * when it is not a readable FCS file.
 *
 * For telling whether a file found under a different name is the one a
 * workspace recorded (2026-10-28): the counts are a property of the data, so a
 * match on them is a content check, not a reading of the name.
 */
export function readCounts(buffer: ArrayBuffer): { eventCount: number; parameterCount: number } | null {
  try {
    const bytes = new Uint8Array(buffer);
    const header = parseHeader(bytes);
    const kv = parseTextSegment(bytes, header.textStart, header.textEnd, false);
    const eventCount = Number.parseInt(kv['$TOT'] ?? '', 10);
    const parameterCount = Number.parseInt(kv['$PAR'] ?? '', 10);
    return Number.isFinite(eventCount) && Number.isFinite(parameterCount) ? { eventCount, parameterCount } : null;
  } catch {
    return null;
  }
}

export function parseFcs(buffer: ArrayBuffer, options: ParseOptions = {}): ParsedFcs {
  const bytes = new Uint8Array(buffer);
  const warnings: FcsWarning[] = [];

  const header = parseHeader(bytes);

  // Primary TEXT. CHARSET/$UNICODE decide the decoder; latin1 is the safe default
  // because FCS 3.0 predates any encoding declaration.
  const probe = parseTextSegment(bytes, header.textStart, header.textEnd, false);
  const utf8 = (probe['CHARSET'] ?? probe['$CHARSET'] ?? '').toLowerCase().includes('utf-8');
  let kv = utf8 ? parseTextSegment(bytes, header.textStart, header.textEnd, true) : probe;

  if (Object.keys(kv).length === 0) {
    throw new FcsParseError(
      'The TEXT segment is empty or unreadable.',
      `HEADER points at bytes ${header.textStart}–${header.textEnd} of a ${bytes.length}-byte file.`,
    );
  }

  // Supplemental TEXT (FCS 3.x) — merged, primary wins on conflict.
  const sStart = Number.parseInt(kv['$BEGINSTEXT'] ?? '0', 10) || 0;
  const sEnd = Number.parseInt(kv['$ENDSTEXT'] ?? '0', 10) || 0;
  if (sStart > 0 && sEnd > sStart) {
    const supplemental = parseTextSegment(bytes, sStart, sEnd, utf8);
    const added = Object.keys(supplemental).filter((k) => !(k in kv));
    if (added.length) {
      kv = { ...supplemental, ...kv };
      warnings.push({
        code: 'supplemental-text',
        message: `Merged ${added.length} keyword${added.length === 1 ? '' : 's'} from the supplemental TEXT segment.`,
      });
    }
  }

  const mode = (kv['$MODE'] ?? 'L').trim().toUpperCase();
  if (mode !== 'L') {
    throw new FcsParseError(
      `This file uses $MODE=${sanitise(mode)}, which MCFlow cannot read.`,
      mode === 'H'
        ? 'Histogram mode stores binned counts rather than individual events, so per-event gating is not possible.'
        : 'Only list mode ($MODE=L) files contain per-event data.',
    );
  }

  const dataTypeRaw = (kv['$DATATYPE'] ?? 'F').trim().toUpperCase();
  if (dataTypeRaw !== 'I' && dataTypeRaw !== 'F' && dataTypeRaw !== 'D' && dataTypeRaw !== 'A') {
    throw new FcsParseError(`Unknown $DATATYPE "${sanitise(dataTypeRaw)}".`, 'Expected I, F, D or A.');
  }
  const dataType = dataTypeRaw as 'I' | 'F' | 'D' | 'A';

  const byteOrdRaw = (kv['$BYTEORD'] ?? '1,2,3,4').trim();
  const little = byteOrdRaw.startsWith('1,2') || byteOrdRaw === '1,2' || byteOrdRaw === '1';

  const parameterCount = Number.parseInt(kv['$PAR'] ?? '', 10);
  if (!Number.isFinite(parameterCount) || parameterCount <= 0) {
    throw new FcsParseError(`Invalid or missing $PAR (parameter count): "${sanitise(kv['$PAR'] ?? '')}".`);
  }
  const eventCount = Number.parseInt(kv['$TOT'] ?? '', 10);
  if (!Number.isFinite(eventCount) || eventCount < 0) {
    throw new FcsParseError(`Invalid or missing $TOT (event count): "${sanitise(kv['$TOT'] ?? '')}".`);
  }

  const parameters = parseParameters(kv, parameterCount);

  // Resolve DATA offsets. HEADER fields are only 8 characters wide, so files
  // beyond 99,999,999 bytes write 0 there and put the real offsets in TEXT.
  const textDataStart = Number.parseInt(kv['$BEGINDATA'] ?? '0', 10) || 0;
  const textDataEnd = Number.parseInt(kv['$ENDDATA'] ?? '0', 10) || 0;
  let dataStart = header.dataStart || textDataStart;
  let dataEnd = header.dataEnd || textDataEnd;

  if (header.dataStart && textDataStart && header.dataStart !== textDataStart) {
    warnings.push({
      code: 'header-offset-mismatch',
      message: 'HEADER and TEXT disagree about where the data segment starts; TEXT was used.',
      detail: `HEADER says ${header.dataStart}, $BEGINDATA says ${textDataStart}.`,
    });
    dataStart = textDataStart;
    dataEnd = textDataEnd || dataEnd;
  }

  // $NEXTDATA chaining.
  const nextData = Number.parseInt(kv['$NEXTDATA'] ?? '0', 10) || 0;
  const wanted = options.datasetIndex ?? 0;
  if (wanted > 0) {
    if (nextData <= 0) throw new FcsParseError(`Dataset ${wanted} was requested but this file has only one.`);
    return parseFcs(buffer.slice(nextData), { ...options, datasetIndex: wanted - 1 });
  }
  if (nextData > 0) {
    warnings.push({
      code: 'multiple-datasets',
      message: 'This file contains more than one dataset; the first was loaded.',
      detail: `$NEXTDATA points at byte ${nextData}.`,
    });
  }

  if (dataStart <= 0 || dataEnd < dataStart) {
    throw new FcsParseError(
      'The data segment offsets are missing or invalid.',
      `Resolved to bytes ${dataStart}–${dataEnd}.`,
    );
  }
  if (dataEnd >= bytes.length) {
    warnings.push({
      code: 'data-size-mismatch',
      message: 'The data segment extends past the end of the file; it was clamped.',
      detail: `$ENDDATA is ${dataEnd} but the file is ${bytes.length} bytes.`,
    });
    dataEnd = bytes.length - 1;
  }

  // Reconcile declared size against actual bytes. A truncated file is read up to
  // the last COMPLETE event rather than throwing — a partially-written file is
  // still worth looking at, provided the reduced count is stated plainly.
  const bitsPerEvent = parameters.reduce((a, p) => a + p.bits, 0);
  let effectiveEventCount = eventCount;
  if (dataType !== 'A' && bitsPerEvent > 0) {
    const bytesPerEvent = bitsPerEvent / 8;
    const expected = bytesPerEvent * eventCount;
    const actual = dataEnd - dataStart + 1;
    if (Math.abs(expected - actual) > 1) {
      warnings.push({
        code: 'data-size-mismatch',
        message: 'The data segment is not the size the metadata implies.',
        detail: `${bitsPerEvent} bits/event × ${eventCount.toLocaleString()} events = ${expected.toLocaleString()} bytes, but the segment is ${actual.toLocaleString()} bytes.`,
      });
    }
    const fits = Math.floor(actual / bytesPerEvent);
    if (fits < eventCount) {
      warnings.push({
        code: 'data-size-mismatch',
        message: `Only ${fits.toLocaleString()} of the ${eventCount.toLocaleString()} declared events are present; the file appears truncated.`,
        detail: 'Statistics and gate percentages are computed on the events that were actually read.',
      });
      effectiveEventCount = Math.max(0, fits);
    }
  }

  const spillover = parseSpillover(
    kv['$SPILLOVER'] ?? kv['SPILL'] ?? kv['$SPILL'] ?? kv['SPILLOVER'],
    warnings,
  );

  const data = readData(bytes, dataStart, dataEnd, parameters, effectiveEventCount, dataType, little, warnings);

  const metadata: FcsMetadata = {
    version: header.version,
    keywords: kv,
    parameters,
    eventCount: effectiveEventCount,
    parameterCount,
    cytometer: str(kv, '$CYT'),
    cytometerSerial: str(kv, '$CYTSN'),
    instrument: str(kv, '$INST'),
    operator: str(kv, '$OP'),
    project: str(kv, '$PROJ'),
    originalFilename: str(kv, '$FIL'),
    software: str(kv, 'CREATOR') ?? str(kv, '$SYS'),
    acquiredAt: parseAcquiredAt(kv['$DATE'], kv['$BTIM']),
    beginTime: str(kv, '$BTIM'),
    endTime: str(kv, '$ETIM'),
    timestep: num(kv, '$TIMESTEP'),
    volume: num(kv, '$VOL'),
    spillover,
    compensationApplied: (kv['APPLY COMPENSATION'] ?? '').trim().toUpperCase() === 'TRUE',
    dataType,
    byteOrder: little ? 'little' : 'big',
    mode,
    nextData,
  };

  collectQualityWarnings(metadata, warnings);

  return { metadata, data, warnings };
}

/* -------------------------------------------------------------------------
   Quality flags surfaced in the metadata panel
   ------------------------------------------------------------------------- */

function collectQualityWarnings(md: FcsMetadata, warnings: FcsWarning[]): void {
  if (!md.spillover) {
    warnings.push({
      code: 'missing-spillover',
      message: 'No compensation matrix is embedded in this file.',
      detail: 'Apply a saved matrix, build one from single-stain controls, or use the spectral unmixing workflow.',
    });
  } else if (md.spillover.isIdentity) {
    warnings.push({
      code: 'identity-spillover',
      message: 'The embedded spillover matrix is the identity — this is raw, uncompensated data.',
      detail: `A ${md.spillover.size}×${md.spillover.size} identity matrix means applying compensation would change nothing.`,
    });
  }

  if (!md.parameters.some((p) => p.type === 'Time')) {
    warnings.push({
      code: 'missing-time-channel',
      message: 'No Time parameter — acquisition-stability QC will not be available.',
    });
  }

  if (md.parameterCount < 3) {
    warnings.push({
      code: 'unusual-parameter-count',
      message: `Only ${md.parameterCount} parameter${md.parameterCount === 1 ? '' : 's'} in this file.`,
      detail: 'Most flow files carry at least forward scatter, side scatter and one fluorescence channel.',
    });
  }
}

/* -------------------------------------------------------------------------
   Acquisition-type detection
   ------------------------------------------------------------------------- */

/** Detector-array names used by spectral instruments, e.g. "UV14-A", "YG3-A". */
const SPECTRAL_DETECTOR = /^(UV|V|B|YG|R|G|O)\d{1,2}(-[AHW])?$/i;

export interface DetectionResult {
  type: AcquisitionType;
  /** Number of channels that drove the decision. */
  fluorescenceChannels: number;
  reason: string;
}

/**
 * Decide whether a sample came off a spectral instrument.
 *
 * Prefers the explicit `$PnTYPE=Raw_Fluorescence` tag that SpectroFlo writes;
 * falls back to counting detector-array-style channel names, which is what
 * distinguishes a 64-detector Aurora file from an 18-colour conventional panel.
 * The threshold is 20 — comfortably above the largest conventional panels and
 * well below the 40+ of any spectral instrument.
 */
export function detectAcquisitionType(md: FcsMetadata): DetectionResult {
  const raw = md.parameters.filter((p) => p.type === 'Raw_Fluorescence').length;
  if (raw >= 20) {
    return {
      type: 'spectral',
      fluorescenceChannels: raw,
      reason: `${raw} channels tagged $PnTYPE=Raw_Fluorescence`,
    };
  }

  const detectorNamed = md.parameters.filter(
    (p) => p.isDataChannel && SPECTRAL_DETECTOR.test(p.name) && p.type !== 'Forward_Scatter' && p.type !== 'Side_Scatter',
  ).length;
  if (detectorNamed >= 20) {
    return {
      type: 'spectral',
      fluorescenceChannels: detectorNamed,
      reason: `${detectorNamed} detector-array channels (e.g. UV1-A, B14-A)`,
    };
  }

  const fluor = md.parameters.filter(
    (p) => p.isDataChannel && p.type !== 'Forward_Scatter' && p.type !== 'Side_Scatter',
  ).length;
  return {
    type: 'conventional',
    fluorescenceChannels: fluor,
    reason: `${fluor} fluorescence channel${fluor === 1 ? '' : 's'} — below the 20-channel spectral threshold`,
  };
}

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Keep untrusted file content out of the UI as raw text. */
function sanitise(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, '·').slice(0, 60);
}
