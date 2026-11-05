import { describe, expect, it } from 'vitest';
import { clampCaret, insertToken, tokenForName, OPERATOR_BUTTONS } from './equationInsert';

describe('insertToken', () => {
  it('inserts into an empty equation without leading or trailing space', () => {
    expect(insertToken('', 0, 0, 'FITC-A')).toEqual({ expression: 'FITC-A', caret: 6 });
  });

  it('separates a token from what precedes it', () => {
    expect(insertToken('FITC-A', 6, 6, '-').expression).toBe('FITC-A -');
  });

  it('hugs the inside of a bracket', () => {
    expect(insertToken('(', 1, 1, 'FITC-A').expression).toBe('(FITC-A');
    expect(insertToken('(FITC-A - APC-A', 15, 15, ')').expression).toBe('(FITC-A - APC-A)');
  });

  it('does not double a space that is already there', () => {
    expect(insertToken('FITC-A ', 7, 7, '-').expression).toBe('FITC-A -');
    expect(insertToken('a  b', 2, 2, '+').expression).toBe('a + b');
  });

  it('spaces on both sides when inserting into the middle', () => {
    expect(insertToken('AB', 1, 1, '+').expression).toBe('A + B');
  });

  it('replaces a selection rather than inserting beside it', () => {
    const r = insertToken('FITC-A + APC-A', 9, 14, 'PE-A');
    expect(r.expression).toBe('FITC-A + PE-A');
  });

  it('leaves the caret just past the token, not past its trailing space', () => {
    // So the next thing typed lands against what was just inserted, and the
    // next thing *clicked* still supplies its own separator.
    const r = insertToken('AB', 1, 1, '+');
    expect(r.caret).toBe(3);
    expect(r.expression.slice(0, r.caret)).toBe('A +');
  });

  it('builds the brief’s equation from clicks alone', () => {
    // The whole point of the feature: `(FITC-A - APC-A) / (FITC-A + APC-A)`
    // with no character typed by hand, and legible spacing throughout.
    const clicks = ['(', 'FITC-A', '-', 'APC-A', ')', '/', '(', 'FITC-A', '+', 'APC-A', ')'];
    let expr = '';
    let caret = 0;
    for (const c of clicks) {
      const r = insertToken(expr, caret, caret, c);
      expr = r.expression;
      caret = r.caret;
    }
    expect(expr).toBe('(FITC-A - APC-A) / (FITC-A + APC-A)');
  });

  it('never runs a detector name into an operator', () => {
    // The reason the buttons exist. `V1-A-B1-A` parses but cannot be read.
    const a = insertToken('V1-A', 4, 4, '-');
    const b = insertToken(a.expression, a.caret, a.caret, 'B1-A');
    expect(b.expression).toBe('V1-A - B1-A');
    expect(b.expression).not.toContain('A-B');
  });

  it('treats an out-of-range or missing caret as the end of the equation', () => {
    expect(insertToken('FITC-A', 99, 99, '+').expression).toBe('FITC-A +');
    expect(insertToken('FITC-A', -1, -1, '+').expression).toBe('FITC-A +');
    expect(insertToken('FITC-A', Number.NaN, Number.NaN, '+').expression).toBe('FITC-A +');
  });

  /* ------------------------------------------------------------------------
     Inserting where the caret actually is.

     `insertToken` always took a range and always spliced; what shipped broken
     was the editor, which read the caret only when the field still had focus —
     and by the time a click on a name or an operator runs, it never does. Every
     insert therefore took the "unknown caret" path and appended. These cases
     model the gesture that exposed it: a caret placed *into* an expression, and
     then a run of inserts that has to continue from there.
     ------------------------------------------------------------------------ */

  it('inserts a forgotten channel into the middle of a finished equation', () => {
    // The reported case. `(FSC-A + SSC-A)` with the caret between `+` and
     // `SSC-A`, then a name clicked: it belongs where the caret is.
    const expr = '(FSC-A + SSC-A)';
    const at = expr.indexOf('SSC-A');
    const r = insertToken(expr, at, at, 'FITC-A');
    expect(r.expression).toBe('(FSC-A + FITC-A SSC-A)');
    // And not at the end, which is what it used to do.
    expect(r.expression.endsWith('FITC-A')).toBe(false);
  });

  it('continues a run of inserts from where the previous one ended', () => {
    // Consecutive clicks have to behave like consecutive keystrokes, or building
    // an expression by clicking is impossible in the middle of one.
    let expr = 'FSC-A / SSC-A';
    let caret = expr.indexOf(' / ');
    for (const token of ['-', 'B1-A']) {
      const r = insertToken(expr, caret, caret, token);
      expr = r.expression;
      caret = r.caret;
    }
    expect(expr).toBe('FSC-A - B1-A / SSC-A');
  });

  it('replaces a highlighted range, the way typing over it would', () => {
    const expr = 'FSC-A / SSC-A';
    const start = expr.indexOf('SSC-A');
    const r = insertToken(expr, start, expr.length, 'B1-A');
    expect(r.expression).toBe('FSC-A / B1-A');
    expect(r.expression.slice(0, r.caret)).toBe('FSC-A / B1-A');
  });
});

describe('clampCaret', () => {
  it('keeps a caret that is inside the string', () => {
    expect(clampCaret(0, 6)).toBe(0);
    expect(clampCaret(3, 6)).toBe(3);
    expect(clampCaret(6, 6)).toBe(6);
  });

  it('treats an unknown caret as the end, not as the start', () => {
    // A DOM selection reports `null` when there is none, and a caret recorded
    // before the expression was shortened can be past its end. Appending is the
    // behaviour a click gets when the caret is genuinely unknown — and it is what
    // every click was getting before the caret was tracked at all, so the
    // degraded case is the familiar one rather than a surprising one.
    expect(clampCaret(null, 6)).toBe(6);
    expect(clampCaret(undefined, 6)).toBe(6);
    expect(clampCaret(99, 6)).toBe(6);
    expect(clampCaret(-1, 6)).toBe(6);
    expect(clampCaret(Number.NaN, 6)).toBe(6);
  });
});

describe('tokenForName', () => {
  it('leaves a plain detector name alone — the hyphen is part of it', () => {
    expect(tokenForName('FITC-A')).toBe('FITC-A');
    expect(tokenForName('YG10-A')).toBe('YG10-A');
    expect(tokenForName('Time')).toBe('Time');
  });

  it('brackets a name the tokeniser could not otherwise pick out', () => {
    expect(tokenForName('CD3 PerCP-Cy5.5')).toBe('[CD3 PerCP-Cy5.5]');
    expect(tokenForName('ratio/index')).toBe('[ratio/index]');
    expect(tokenForName('7-AAD')).toBe('[7-AAD]');
  });
});

describe('OPERATOR_BUTTONS', () => {
  it('shows mathematical glyphs and inserts ASCII', () => {
    const byGlyph = Object.fromEntries(OPERATOR_BUTTONS.map((o) => [o.glyph, o.insert]));
    expect(byGlyph['−']).toBe('-');
    expect(byGlyph['×']).toBe('*');
    expect(byGlyph['÷']).toBe('/');
  });

  it('offers exactly the six the brief names', () => {
    expect(OPERATOR_BUTTONS.map((o) => o.glyph)).toEqual(['+', '−', '×', '÷', '(', ')']);
  });

  it('gives every button a title, since the glyph is all there is to read', () => {
    for (const o of OPERATOR_BUTTONS) expect(o.title.length).toBeGreaterThan(2);
  });
});
