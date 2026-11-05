/* ==========================================================================
   Building an equation by clicking rather than typing.

   Detector names contain the minus sign — `V1-A`, `YG10-A` — so a typed `-`
   operator is visually indistinguishable from the hyphen inside the token
   beside it, and `V1-A-B1-A` is ambiguous to read even though the tokeniser
   resolves it. Inserting from a list and from operator buttons removes the
   ambiguity at the source: the token arrives spelled correctly and the operator
   arrives spaced away from it.

   Spacing is the whole job here. `(FITC-A-APC-A)` and `(FITC-A - APC-A)` mean
   the same thing to `core/derived.ts` but only one of them can be checked by
   eye, and this is the surface that decides which one gets written.
   ========================================================================== */

export interface Insertion {
  expression: string;
  /** Where the caret should land — always just past what was inserted. */
  caret: number;
}

/**
 * Insert `token` over the selection `[start, end)` of `expression`.
 *
 * A single space is added on each side unless the neighbour makes one wrong:
 * nothing hugs the inside of a bracket, and nothing doubles a space that is
 * already there. That keeps a clicked-together expression looking like one a
 * careful person typed, which matters because the next reader of it is checking
 * a panel design rather than debugging a parser.
 */
export function insertToken(expression: string, start: number, end: number, token: string): Insertion {
  const s = clampIndex(expression, start);
  const e = clampIndex(expression, Math.max(start, end));
  const left = expression.slice(0, s);
  const right = expression.slice(e);

  const spaceBefore = left.length > 0 && !/[\s(]$/.test(left) && token !== ')';
  const spaceAfter = right.length > 0 && !/^[\s)]/.test(right) && token !== '(';

  const middle = `${spaceBefore ? ' ' : ''}${token}${spaceAfter ? ' ' : ''}`;
  return {
    expression: left + middle + right,
    // Past the token, not past the trailing space: the next click inserts its
    // own separator, and leaving the caret before the space keeps a subsequent
    // keystroke adjacent to what was just inserted.
    caret: left.length + (spaceBefore ? 1 : 0) + token.length,
  };
}

/**
 * Wrap a name in brackets when it needs them.
 *
 * `core/derived.ts` matches the longest known name at each position, which
 * resolves almost everything — but a name containing a space or an operator
 * character other than the hyphen the detectors all carry cannot be told from
 * an expression, and `[ ]` is the language's existing escape for exactly that.
 */
export function tokenForName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? name : `[${name}]`;
}

/**
 * A caret index, made safe for the string it is about to be used in.
 *
 * Exported because the editor has to answer the same question one step earlier
 * than `insertToken` does — it reads the caret from a DOM selection, which gives
 * `null` when there is none, and from a value recorded before the expression was
 * last edited, which can be past the end of the current one.
 *
 * Both of those mean **the end of the expression** rather than position zero.
 * Appending is what a click gets when the caret is genuinely unknown, and it is
 * also what every click was getting by accident until the caret started being
 * tracked at all — so an unknown caret degrades to the old behaviour rather than
 * to a surprising one.
 */
export function clampCaret(i: number | null | undefined, length: number): number {
  if (i === null || i === undefined || !Number.isFinite(i) || i < 0) return length;
  return Math.min(length, Math.round(i));
}

/** Operator buttons, in the order they are shown. */
export const OPERATOR_BUTTONS: Array<{ glyph: string; insert: string; title: string }> = [
  { glyph: '+', insert: '+', title: 'Add' },
  // The glyphs are the mathematical ones and the inserted text is ASCII: `−`
  // and `×` read correctly at 10 px in a row of buttons, and the expression
  // language takes `-` and `*`. The button is the thing that disambiguates a
  // minus from a detector name's hyphen, so it must not look like one.
  { glyph: '−', insert: '-', title: 'Subtract' },
  { glyph: '×', insert: '*', title: 'Multiply' },
  { glyph: '÷', insert: '/', title: 'Divide' },
  { glyph: '(', insert: '(', title: 'Open bracket' },
  { glyph: ')', insert: ')', title: 'Close bracket' },
];

function clampIndex(s: string, i: number): number {
  if (!Number.isFinite(i) || i < 0) return s.length;
  return Math.min(s.length, Math.round(i));
}
