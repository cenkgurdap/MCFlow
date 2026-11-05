/**
 * Synthetic FCS writers used by the parser tests.
 *
 * The 16 real test files are all FCS 3.1 / float32 / little-endian, so they
 * exercise only one path through the reader. These builders cover the rest:
 * integer data, big-endian byte order, FCS 2.0 header-only offsets, log
 * amplification, $PnR masking, bit-packed widths, supplemental TEXT and
 * $NEXTDATA chaining.
 */

export interface FixtureParam {
  name: string;
  stain?: string;
  bits: number;
  range: number;
  /** `$PnE` as [decades, offset]. */
  amp?: [number, number];
  gain?: number;
  type?: string;
}

export interface FixtureSpec {
  version?: string;
  dataType: 'I' | 'F' | 'D' | 'A';
  byteOrd?: string;
  params: FixtureParam[];
  /** Row-major events: `events[eventIndex][parameterIndex]`. */
  events: number[][];
  extraKeywords?: Record<string, string>;
  delimiter?: string;
  /** Write 0 into the HEADER data offsets and rely on $BEGINDATA/$ENDDATA. */
  headerOffsetsZero?: boolean;
  /** Move some keywords into a supplemental TEXT segment. */
  supplementalKeywords?: Record<string, string>;
  /** Append a second dataset and point $NEXTDATA at it. */
  chain?: FixtureSpec;
}

const enc = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const pad8 = (n: number): string => String(n).padStart(8, ' ');

function buildKeywords(spec: FixtureSpec, beginData: number, endData: number, nextData: number): Record<string, string> {
  const kv: Record<string, string> = {
    $BEGINANALYSIS: '0',
    $ENDANALYSIS: '0',
    $BEGINSTEXT: '0',
    $ENDSTEXT: '0',
    $BEGINDATA: String(beginData),
    $ENDDATA: String(endData),
    $BYTEORD: spec.byteOrd ?? '1,2,3,4',
    $DATATYPE: spec.dataType,
    $MODE: 'L',
    $NEXTDATA: String(nextData),
    $PAR: String(spec.params.length),
    $TOT: String(spec.events.length),
  };
  spec.params.forEach((p, i) => {
    const n = i + 1;
    kv[`$P${n}N`] = p.name;
    kv[`$P${n}B`] = String(p.bits);
    kv[`$P${n}R`] = String(p.range);
    kv[`$P${n}E`] = `${p.amp?.[0] ?? 0},${p.amp?.[1] ?? 0}`;
    if (p.stain) kv[`$P${n}S`] = p.stain;
    if (p.gain !== undefined) kv[`$P${n}G`] = String(p.gain);
    if (p.type) kv[`$P${n}TYPE`] = p.type;
  });
  // extraKeywords is applied last so a test can deliberately corrupt any
  // generated keyword (a blank $P1N, a bad $MODE) to exercise error paths.
  return { ...kv, ...spec.extraKeywords };
}

function encodeText(kv: Record<string, string>, delim: string): Uint8Array {
  // A doubled delimiter escapes a literal one — mirror that on the way out.
  const esc = (s: string) => s.split(delim).join(delim + delim);
  let body = delim;
  for (const [k, v] of Object.entries(kv)) body += `${esc(k)}${delim}${esc(v)}${delim}`;
  return enc(body);
}

function encodeData(spec: FixtureSpec): Uint8Array {
  const little = !(spec.byteOrd ?? '1,2,3,4').startsWith('4');
  const nPar = spec.params.length;

  if (spec.dataType === 'A') {
    return enc(spec.events.map((ev) => ev.join(',')).join(',') + ' ');
  }

  const allAligned = spec.params.every((p) => p.bits % 8 === 0);
  if (!allAligned) {
    // MSB-first bit packing.
    const totalBits = spec.events.length * spec.params.reduce((a, p) => a + p.bits, 0);
    const out = new Uint8Array(Math.ceil(totalBits / 8));
    let bitPos = 0;
    for (const ev of spec.events) {
      for (let p = 0; p < nPar; p++) {
        const bits = spec.params[p]!.bits;
        const v = ev[p]! >>> 0;
        for (let b = bits - 1; b >= 0; b--) {
          const bit = (v >> b) & 1;
          if (bit) out[bitPos >> 3]! |= 0x80 >> (bitPos & 7);
          bitPos++;
        }
      }
    }
    return out;
  }

  const widths = spec.params.map((p) => (spec.dataType === 'F' ? 4 : spec.dataType === 'D' ? 8 : p.bits / 8));
  const stride = widths.reduce((a, w) => a + w, 0);
  const out = new Uint8Array(stride * spec.events.length);
  const view = new DataView(out.buffer);

  spec.events.forEach((ev, e) => {
    let off = e * stride;
    for (let p = 0; p < nPar; p++) {
      const v = ev[p]!;
      const w = widths[p]!;
      if (spec.dataType === 'F') view.setFloat32(off, v, little);
      else if (spec.dataType === 'D') view.setFloat64(off, v, little);
      else if (w === 1) view.setUint8(off, v);
      else if (w === 2) view.setUint16(off, v, little);
      else if (w === 3) {
        const a = v & 0xff, b = (v >> 8) & 0xff, c = (v >> 16) & 0xff;
        if (little) { view.setUint8(off, a); view.setUint8(off + 1, b); view.setUint8(off + 2, c); }
        else { view.setUint8(off, c); view.setUint8(off + 1, b); view.setUint8(off + 2, a); }
      } else if (w === 4) view.setUint32(off, v, little);
      else if (w === 8) view.setBigUint64(off, BigInt(v), little);
      off += w;
    }
  });
  return out;
}

/** Assemble a complete, standard-compliant FCS file in memory. */
export function buildFcs(spec: FixtureSpec): ArrayBuffer {
  const delim = spec.delimiter ?? '\f';
  const version = (spec.version ?? 'FCS3.1').padEnd(6, ' ');
  const HEADER_LEN = 58;
  const textStart = 256;

  const data = encodeData(spec);
  const supplemental = spec.supplementalKeywords
    ? encodeText(spec.supplementalKeywords, delim)
    : new Uint8Array(0);

  // Two passes: keyword text length depends on the offsets it encodes, so size
  // the segment with placeholders first, then rebuild at the final positions.
  let textLen = encodeText(buildKeywords(spec, 0, 0, 0), delim).length + 64;
  let stextStart = 0, stextEnd = 0, dataStart = 0, dataEnd = 0, chainStart = 0;

  for (let pass = 0; pass < 4; pass++) {
    let cursor = textStart + textLen;
    if (supplemental.length) {
      stextStart = cursor;
      stextEnd = cursor + supplemental.length - 1;
      cursor = stextEnd + 1;
    }
    dataStart = cursor;
    dataEnd = dataStart + data.length - 1;
    chainStart = spec.chain ? dataEnd + 1 : 0;

    const kv = buildKeywords(spec, dataStart, dataEnd, chainStart);
    if (supplemental.length) {
      kv['$BEGINSTEXT'] = String(stextStart);
      kv['$ENDSTEXT'] = String(stextEnd);
    }
    const encoded = encodeText(kv, delim);
    if (encoded.length === textLen) break;
    textLen = encoded.length;
  }

  const kvFinal = buildKeywords(spec, dataStart, dataEnd, chainStart);
  if (supplemental.length) {
    kvFinal['$BEGINSTEXT'] = String(stextStart);
    kvFinal['$ENDSTEXT'] = String(stextEnd);
  }
  const text = encodeText(kvFinal, delim);

  const chainBytes = spec.chain ? new Uint8Array(buildFcs(spec.chain)) : new Uint8Array(0);
  const total = (chainStart || dataEnd + 1) + chainBytes.length;
  const file = new Uint8Array(total);

  file.set(enc(version), 0);
  file.set(enc('    '), 6);
  const hz = spec.headerOffsetsZero;
  const headerText =
    pad8(textStart) + pad8(textStart + text.length - 1) +
    pad8(hz ? 0 : dataStart) + pad8(hz ? 0 : dataEnd) +
    pad8(0) + pad8(0);
  file.set(enc(headerText), 10);
  if (HEADER_LEN > 58) throw new Error('unreachable');

  file.set(text, textStart);
  if (supplemental.length) file.set(supplemental, stextStart);
  file.set(data, dataStart);
  if (chainBytes.length) file.set(chainBytes, chainStart);

  return file.buffer;
}
