/**
 * What unit an axis is in, and how its transform is described — for figure
 * titles and notes.
 *
 * ## The rule, and why it reads structure rather than names (2026-10-22)
 *
 * A figure's axis says what it measures *and in what*: `Time (s)`,
 * `FSC-A (a.u.)`, `Membrane order (GP)`. Time is in seconds because
 * `parametersFor` applies `$TIMESTEP` before any plot sees the column. Every
 * detector, compensated or unmixed channel is an intensity on the instrument's
 * own scale — arbitrary units, which is what a cytometry figure writes. A
 * derived parameter has the unit its **equation** gives it: a normalised
 * difference of two channels, (A − B)/(A + B), is a generalised polarisation,
 * GP, whatever it is called and whichever two detectors it reads — the shape of
 * the arithmetic decides, never the name, which is the rule this project keeps
 * about filenames applied to parameters. Any other equation has no unit this
 * can vouch for, and gets none.
 */
import type { TransformSpec } from '@/core/transform';

/** The unit an axis is labelled in, or null for none. */
export function unitOf(type: string | undefined, expression?: string | null): string | null {
  switch (type) {
    case 'Time':
      return 's';
    case 'Forward_Scatter':
    case 'Side_Scatter':
    case 'Raw_Fluorescence':
    case 'Unmixed_Fluorescence':
    case 'Compensated_Fluorescence':
      return 'a.u.';
    case 'Derived':
      return expression && isNormalisedDifference(expression) ? 'GP' : null;
    default:
      return null;
  }
}

/** (A − B)/(A + B), over any two operands, spaced or not. */
export function isNormalisedDifference(expression: string): boolean {
  const m = /^\s*\(\s*([^()+\-*/\s]+(?:-[A-Za-z0-9]+)*)\s*-\s*([^()+\-*/\s]+(?:-[A-Za-z0-9]+)*)\s*\)\s*\/\s*\(\s*([^()+\-*/\s]+(?:-[A-Za-z0-9]+)*)\s*\+\s*([^()+\-*/\s]+(?:-[A-Za-z0-9]+)*)\s*\)\s*$/.exec(expression);
  return !!m && m[1] === m[3] && m[2] === m[4];
}

/** An axis's transform in words, for the notes. */
export function transformLabel(spec: TransformSpec): string {
  switch (spec.kind) {
    case 'linear':
      return 'linear';
    case 'log':
      return `log, ${spec.decades ?? 4.5} decades`;
    case 'logicle':
    case 'biexponential':
      return `${spec.kind}${spec.width !== undefined ? `, W ${spec.width}` : ''}${spec.decades !== undefined ? `, M ${spec.decades}` : ''}`;
    case 'hyperlog':
      return `hyperlog${spec.decades !== undefined ? `, ${spec.decades} decades` : ''}`;
    case 'asinh':
      return `arcsinh, cofactor ${spec.cofactor ?? 150}`;
    default:
      return String(spec.kind);
  }
}
