/**
 * Derived parameters — new channels computed from existing ones.
 *
 * `(FITC-A - APC-A) / (FITC-A + APC-A)` is a ratio parameter, and once it exists
 * it should behave exactly like a detector: selectable on either axis, gateable,
 * reportable in statistics, saved with the workspace. That is the whole feature,
 * and it is the same thing FCS Express calls parameter math.
 *
 * The awkward part is lexical, not mathematical. Detector names contain the
 * minus sign: `FITC-A`, `SSC-B-A`, `PerCP-Cy5.5-A`. So `FITC-A - APC-A` cannot be
 * tokenised by splitting on operators — `FITC` minus `A` minus `APC` minus `A` is
 * an equally valid reading of the same characters, and it is the wrong one.
 *
 * The tokeniser therefore knows the parameter names and matches the **longest**
 * one at each position before it considers anything else. That resolves the
 * ambiguity the way a person reads it, and it is why `parse` takes a name list
 * rather than being context-free. `[FITC-A]` is accepted as an explicit form for
 * anyone who would rather not rely on that, and for a channel whose name happens
 * to contain a bracket-free substring of another.
 */

export interface DerivedParameterDef {
  id: string;
  /** Short name, used on axes and as a reference from other expressions. */
  name: string;
  expression: string;
}

/* -------------------------------------------------------------------------
   AST
   ------------------------------------------------------------------------- */

export type Node =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'neg'; operand: Node }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

export interface ParseOk {
  ok: true;
  ast: Node;
  /** Parameter names the expression reads, in first-seen order, de-duplicated. */
  references: string[];
}

export interface ParseFail {
  ok: false;
  /** Complete sentence, shown inline under the field. */
  error: string;
}

export type ParseResult = ParseOk | ParseFail;

/* -------------------------------------------------------------------------
   Tokeniser
   ------------------------------------------------------------------------- */

type Token =
  | { t: 'num'; value: number; at: number }
  | { t: 'ref'; name: string; at: number }
  | { t: 'op'; op: '+' | '-' | '*' | '/'; at: number }
  | { t: '('; at: number }
  | { t: ')'; at: number };

/** Longest name first, so `SSC-B-A` is never read as `SSC-B` followed by `-A`. */
function byLengthDesc(names: string[]): string[] {
  return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function tokenise(src: string, names: string[]): { tokens: Token[] } | ParseFail {
  const ordered = byLengthDesc(names);
  const lower = src.toLowerCase();
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === '(') { tokens.push({ t: '(', at: i }); i++; continue; }
    if (c === ')') { tokens.push({ t: ')', at: i }); i++; continue; }

    // An explicit reference. Unambiguous by construction, so it is checked
    // before the longest-match pass rather than after it.
    if (c === '[') {
      const end = src.indexOf(']', i + 1);
      if (end < 0) {
        return { ok: false, error: `Unclosed “[” at position ${i + 1}. A bracketed parameter name needs a closing “]”.` };
      }
      tokens.push({ t: 'ref', name: src.slice(i + 1, end).trim(), at: i });
      i = end + 1;
      continue;
    }

    // A number, but only where a number can start. `1e3` is one token; `1e` is
    // not a number at all and falls through to the error below.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (m) {
        tokens.push({ t: 'num', value: Number(m[0]), at: i });
        i += m[0].length;
        continue;
      }
    }

    // Longest known parameter name wins. This is the whole reason the tokeniser
    // is not context-free, and it has to run before the operator check or every
    // hyphenated detector name would be torn into pieces.
    const hit = ordered.find((n) => n.length > 0 && lower.startsWith(n.toLowerCase(), i));
    if (hit) {
      tokens.push({ t: 'ref', name: hit, at: i });
      i += hit.length;
      continue;
    }

    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ t: 'op', op: c, at: i });
      i++;
      continue;
    }

    // Anything left is a name that is not a parameter, which is the mistake
    // worth naming precisely — a typo in a detector name is the common one.
    const word = /^[A-Za-z_][\w.\-]*/.exec(src.slice(i));
    if (word) {
      return {
        ok: false,
        error: `“${word[0]}” is not a parameter in this sample. Check the spelling, or pick it from the list below.`,
      };
    }
    return { ok: false, error: `Unexpected character “${c}” at position ${i + 1}.` };
  }

  return { tokens };
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/* -------------------------------------------------------------------------
   Parser — precedence climbing over + - * /
   ------------------------------------------------------------------------- */

/**
 * Parse an expression against a set of known parameter names.
 *
 * Deliberately total: every failure comes back as a sentence rather than as a
 * thrown error, because every caller — the editor's live validation, the
 * workspace loader, the column builder — has to show it rather than crash on it.
 */
export function parseExpression(src: string, names: string[]): ParseResult {
  if (!src.trim()) return { ok: false, error: 'Enter an expression, e.g. (FITC-A - APC-A) / (FITC-A + APC-A).' };

  const lexed = tokenise(src, names);
  if ('ok' in lexed) return lexed;
  const { tokens } = lexed;
  if (tokens.length === 0) return { ok: false, error: 'This expression is empty.' };

  const depth = tokens.reduce((d, t) => d + (t.t === '(' ? 1 : t.t === ')' ? -1 : 0), 0);
  if (depth !== 0) {
    return {
      ok: false,
      error: depth > 0
        ? `${depth} unclosed “(” — every opening bracket needs a closing one.`
        : `${-depth} unmatched “)” — there are more closing brackets than opening ones.`,
    };
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const references: string[] = [];

  const parsePrimary = (): Node | ParseFail => {
    const tok = peek();
    if (!tok) return { ok: false, error: 'The expression ends after an operator. Something has to follow it.' };

    if (tok.t === 'op' && (tok.op === '-' || tok.op === '+')) {
      pos++;
      const operand = parsePrimary();
      if ('ok' in operand) return operand;
      return tok.op === '-' ? { kind: 'neg', operand } : operand;
    }
    if (tok.t === 'num') { pos++; return { kind: 'number', value: tok.value }; }
    if (tok.t === 'ref') {
      pos++;
      if (!names.some((n) => n.toLowerCase() === tok.name.toLowerCase())) {
        return {
          ok: false,
          error: `“${tok.name}” is not a parameter in this sample. Check the spelling, or pick it from the list below.`,
        };
      }
      // Canonicalise to the declared spelling so the AST is comparable and the
      // column lookup is a plain map hit.
      const canonical = names.find((n) => n.toLowerCase() === tok.name.toLowerCase())!;
      if (!references.includes(canonical)) references.push(canonical);
      return { kind: 'ref', name: canonical };
    }
    if (tok.t === '(') {
      pos++;
      const inner = parseBinary(0);
      if ('ok' in inner) return inner;
      const close = peek();
      if (!close || close.t !== ')') return { ok: false, error: 'Expected a closing “)”.' };
      pos++;
      return inner;
    }
    return { ok: false, error: `Unexpected “)” at position ${tok.at + 1}.` };
  };

  const precedence = (op: string) => (op === '*' || op === '/' ? 2 : 1);

  function parseBinary(minPrec: number): Node | ParseFail {
    let left = parsePrimary();
    if ('ok' in left) return left;

    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op') break;
      const prec = precedence(tok.op);
      if (prec < minPrec) break;
      pos++;
      // Left-associative: `a - b - c` is `(a - b) - c`, so the right operand
      // binds only operators strictly tighter than this one.
      const right = parseBinary(prec + 1);
      if ('ok' in right) return right;
      left = { kind: 'binary', op: tok.op, left, right };
    }
    return left;
  }

  const ast = parseBinary(0);
  if ('ok' in ast) return ast;
  if (pos < tokens.length) {
    const tok = tokens[pos]!;
    return { ok: false, error: `Unexpected “${describe(tok)}” at position ${tok.at + 1}.` };
  }

  if (references.length === 0) {
    return { ok: false, error: 'This expression is a constant — it has to reference at least one parameter.' };
  }

  const zeroDiv = dividesByLiteralZero(ast);
  if (zeroDiv) return { ok: false, error: 'This expression divides by zero.' };

  return { ok: true, ast, references };
}

function describe(t: Token): string {
  return t.t === 'op' ? t.op : t.t === 'num' ? String(t.value) : t.t === 'ref' ? t.name : t.t;
}

/**
 * A literal zero denominator, which is always a mistake.
 *
 * Division by a *parameter* that happens to be zero for some events is not — it
 * is normal, produces a non-finite value for those events, and is handled at
 * evaluation time rather than refused here. Refusing it would rule out every
 * ratio parameter, which is the main thing this feature is for.
 */
function dividesByLiteralZero(n: Node): boolean {
  if (n.kind === 'binary') {
    if (n.op === '/' && n.right.kind === 'number' && n.right.value === 0) return true;
    return dividesByLiteralZero(n.left) || dividesByLiteralZero(n.right);
  }
  if (n.kind === 'neg') return dividesByLiteralZero(n.operand);
  return false;
}

/* -------------------------------------------------------------------------
   Evaluation
   ------------------------------------------------------------------------- */

/**
 * Compute a derived column, one event at a time.
 *
 * Non-finite results are kept as-is rather than clamped or zeroed. A ratio whose
 * denominator is zero for 40 events is a real property of the data; writing 0
 * there would put those events in the middle of the distribution and quietly
 * inside whatever gate sits there. The plot's extent calculation already ignores
 * non-finite values, and gate membership tests are false for them.
 */
export function evaluateExpression(
  ast: Node,
  columns: Map<string, Float32Array>,
  eventCount: number,
): Float32Array {
  const out = new Float32Array(eventCount);
  // Resolve every reference once rather than per event — a map lookup inside a
  // 170 000-iteration loop is most of the cost of the whole computation.
  const compiled = compile(ast, columns);
  for (let i = 0; i < eventCount; i++) out[i] = compiled(i);
  return out;
}

type Compiled = (i: number) => number;

function compile(n: Node, columns: Map<string, Float32Array>): Compiled {
  switch (n.kind) {
    case 'number': {
      const v = n.value;
      return () => v;
    }
    case 'ref': {
      const col = columns.get(n.name);
      if (!col) return () => NaN;
      return (i) => col[i]!;
    }
    case 'neg': {
      const inner = compile(n.operand, columns);
      return (i) => -inner(i);
    }
    case 'binary': {
      const l = compile(n.left, columns);
      const r = compile(n.right, columns);
      switch (n.op) {
        case '+': return (i) => l(i) + r(i);
        case '-': return (i) => l(i) - r(i);
        case '*': return (i) => l(i) * r(i);
        case '/': return (i) => l(i) / r(i);
      }
    }
  }
}

/* -------------------------------------------------------------------------
   Definition-level validation
   ------------------------------------------------------------------------- */

export interface DefValidation {
  ok: boolean;
  /** Null when valid. */
  error: string | null;
  references: string[];
}

/**
 * Validate one definition against the real parameters and its sibling derived
 * parameters.
 *
 * A derived parameter may reference another — a ratio of two ratios is a
 * reasonable thing to want — which is the only reason cycles are possible, so
 * they are checked here rather than being discovered as a stack overflow during
 * evaluation.
 */
export function validateDefinition(
  def: { id: string; name: string; expression: string },
  realNames: string[],
  siblings: DerivedParameterDef[],
): DefValidation {
  const name = def.name.trim();
  if (!name) return { ok: false, error: 'Give the parameter a name.', references: [] };
  if (realNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `“${name}” is already a detector on this sample. Pick a different name.`, references: [] };
  }
  if (siblings.some((s) => s.id !== def.id && s.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `Another derived parameter is already called “${name}”.`, references: [] };
  }
  if (/[[\]()+\-*/]/.test(name)) {
    return {
      ok: false,
      error: 'A parameter name cannot contain brackets or arithmetic operators — an expression referencing it would be ambiguous.',
      references: [],
    };
  }

  const others = siblings.filter((s) => s.id !== def.id);
  const parsed = parseExpression(def.expression, [...realNames, ...others.map((s) => s.name)]);
  if (!parsed.ok) return { ok: false, error: parsed.error, references: [] };

  // Cycle check across the derived set, with this definition's proposed
  // expression standing in for whatever is currently stored.
  const byName = new Map<string, DerivedParameterDef>(
    [...others, { ...def, name }].map((d) => [d.name.trim().toLowerCase(), d as DerivedParameterDef]),
  );
  const visiting = new Set<string>();
  const done = new Set<string>();
  const allNames = [...realNames, ...byName.keys()];

  const walk = (key: string): string | null => {
    if (done.has(key)) return null;
    if (visiting.has(key)) return `“${byName.get(key)?.name ?? key}” ends up referencing itself.`;
    const d = byName.get(key);
    if (!d) return null;
    visiting.add(key);
    const p = parseExpression(d.expression, allNames);
    if (p.ok) {
      for (const ref of p.references) {
        const err = walk(ref.toLowerCase());
        if (err) return err;
      }
    }
    visiting.delete(key);
    done.add(key);
    return null;
  };

  const cycle = walk(name.toLowerCase());
  if (cycle) return { ok: false, error: cycle, references: parsed.references };

  return { ok: true, error: null, references: parsed.references };
}

/**
 * Derived definitions in dependency order — every definition after the ones it
 * reads. A definition in a cycle, or referencing something that does not exist,
 * is dropped rather than ordered.
 */
export function derivedOrder(defs: DerivedParameterDef[], realNames: string[]): DerivedParameterDef[] {
  const byName = new Map(defs.map((d) => [d.name.trim().toLowerCase(), d]));
  const allNames = [...realNames, ...defs.map((d) => d.name)];
  const out: DerivedParameterDef[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (d: DerivedParameterDef): boolean => {
    const key = d.name.trim().toLowerCase();
    const s = state.get(key);
    if (s === 'done') return true;
    if (s === 'visiting') return false;
    state.set(key, 'visiting');
    const p = parseExpression(d.expression, allNames);
    if (!p.ok) { state.set(key, 'done'); return false; }
    for (const ref of p.references) {
      const dep = byName.get(ref.toLowerCase());
      if (dep && dep !== d && !visit(dep)) { state.set(key, 'done'); return false; }
    }
    state.set(key, 'done');
    out.push(d);
    return true;
  };

  for (const d of defs) visit(d);
  return out;
}

let derivedSeq = 0;
export function nextDerivedId(): string {
  return `d${Date.now().toString(36)}${(derivedSeq++).toString(36)}`;
}
