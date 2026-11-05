import { contains, inRange } from './geometry';
import { isGeometric, ROOT_ID, type Gate, type PopulationStats } from './types';

/* ==========================================================================
   Gate hierarchy evaluation.

   Membership is a bitmask per gate — one Uint8Array of length N. That is 170 kB
   per gate at 170 000 events, which is cheap next to recomputing, and it makes
   parent/child intersection a single AND pass.

   A gate's population is (its own geometry) ∩ (its parent's population), so the
   tree must be evaluated top-down. `topoOrder` still carries a visited guard:
   `parentId` cannot form a cycle through the UI, but a hand-edited workspace
   file can, and a stack overflow is a worse answer than a flat list.
   ========================================================================== */

export interface GateContext {
  /**
   * Display-space values for one of a gate's axes, **in that gate's own space**.
   *
   * Keyed by the gate rather than by the parameter index, which is the fix for
   * Item 17. A gate's coordinates are display-space numbers and display space is
   * a function of the transform, so "the column for parameter 40" is not a
   * well-formed question — it has as many answers as there are transforms, and
   * every caller used to supply its own. The gate names the one it means
   * (`xSpec`/`ySpec`); the implementation falls back to the parameter's default
   * for gates drawn before that field existed.
   */
  columnFor(gate: Gate, axis: 'x' | 'y'): Float32Array;
  eventCount: number;
}

export type Membership = Uint8Array;

export interface EvaluatedTree {
  /** gateId → membership mask. Includes ROOT_ID (all ones). */
  masks: Map<string, Membership>;
  stats: Map<string, PopulationStats>;
  /** Gates that could not be evaluated, with why. */
  errors: Map<string, string>;
}

function countMask(m: Membership): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i]!;
  return n;
}

/** Children of a gate, in insertion order. */
export function childrenOf(gates: Gate[], parentId: string | null): Gate[] {
  const key = parentId === ROOT_ID ? null : parentId;
  return gates.filter((g) => (g.parentId ?? null) === key);
}

/**
 * The tree flattened into the order the sidebar draws it.
 *
 * `childrenOf` recursively, which is exactly what `GateTree`'s `GateBranch`
 * does to render — one rule, two consumers, rather than a second opinion about
 * what the tree looks like. It exists because a Shift-range and an arrow key
 * both need the rows on screen **as a list**, and a recursive component cannot
 * hand either of them one.
 *
 * Not `topoOrder`: that walks the array and pulls ancestors forward, which is
 * the right answer for evaluation and the wrong one here — it can put a gate
 * somewhere other than where the eye sees it, and a range that covers rows
 * nobody saw between the two they clicked is not a range anybody asked for.
 * Gates with a dangling parent are omitted for the same reason: the sidebar
 * does not draw them either.
 */
export function flattenTree(gates: Gate[], parentId: string | null = null): Gate[] {
  /*
     A visited guard, for the same reason `topoOrder` below carries one: a
     hand-edited workspace can hold a cycle, and a stack overflow is a worse
     answer than a flat list. It also catches the shape that is *not* a cycle
     and recurses just as hard — a gate whose `id` is missing, whose children
     therefore resolve back to the root and start the walk again.
  */
  const seen = new Set<string>();
  const walk = (parent: string | null): Gate[] => {
    const out: Gate[] = [];
    for (const child of childrenOf(gates, parent)) {
      if (child.id === undefined || seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      out.push(...walk(child.id));
    }
    return out;
  };
  return walk(parentId);
}

/**
 * Depth-first order with parents always before children.
 * Gates whose parent is missing are treated as children of the root rather than
 * silently dropped — a dangling parent should not make a population vanish.
 */
export function topoOrder(gates: Gate[]): Gate[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out: Gate[] = [];
  const seen = new Set<string>();

  const visit = (g: Gate, guard: Set<string>) => {
    if (seen.has(g.id) || guard.has(g.id)) return;
    guard.add(g.id);
    const parentId = g.parentId;
    if (parentId && parentId !== ROOT_ID) {
      const parent = byId.get(parentId);
      if (parent) visit(parent, guard);
    }
    guard.delete(g.id);
    if (!seen.has(g.id)) {
      seen.add(g.id);
      out.push(g);
    }
  };

  for (const g of gates) visit(g, new Set());
  return out;
}

/** Full ancestor path, root-first, excluding the gate itself. */
export function ancestorsOf(gates: Gate[], gateId: string): Gate[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const path: Gate[] = [];
  let current = byId.get(gateId);
  const guard = new Set<string>();
  while (current?.parentId && current.parentId !== ROOT_ID) {
    if (guard.has(current.parentId)) break;
    guard.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    path.unshift(parent);
    current = parent;
  }
  return path;
}

/** Slash-separated path used by exports, e.g. "Lymphocytes/CD3+/CD4+". */
export function populationPath(gates: Gate[], gateId: string): string {
  const gate = gates.find((g) => g.id === gateId);
  if (!gate) return '';
  return [...ancestorsOf(gates, gateId).map((g) => g.name), gate.name].join('/');
}

/** Every descendant of a gate, including itself. */
export function subtreeOf(gates: Gate[], gateId: string): Gate[] {
  const out: Gate[] = [];
  const walk = (id: string) => {
    const g = gates.find((x) => x.id === id);
    if (g) out.push(g);
    for (const child of gates.filter((x) => x.parentId === id)) walk(child.id);
  };
  walk(gateId);
  return out;
}

/** True when moving `gateId` under `newParentId` would create a cycle. */
export function wouldCycle(gates: Gate[], gateId: string, newParentId: string | null): boolean {
  if (!newParentId || newParentId === ROOT_ID) return false;
  if (gateId === newParentId) return true;
  return subtreeOf(gates, gateId).some((g) => g.id === newParentId);
}

/* -------------------------------------------------------------------------
   Evaluation
   ------------------------------------------------------------------------- */

/**
 * Evaluate every gate against one sample.
 *
 * `ctx.columnFor` supplies display-space values, so the caller controls
 * compensation and transforms; this function only tests geometry.
 */
export function evaluateGates(gates: Gate[], ctx: GateContext): EvaluatedTree {
  const N = ctx.eventCount;
  const masks = new Map<string, Membership>();
  const stats = new Map<string, PopulationStats>();
  const errors = new Map<string, string>();

  const root = new Uint8Array(N).fill(1);
  masks.set(ROOT_ID, root);
  stats.set(ROOT_ID, {
    gateId: ROOT_ID, count: N, parentCount: N, totalCount: N,
    percentOfParent: 100, percentOfTotal: 100,
  });

  for (const gate of topoOrder(gates)) {
    const parentMask = masks.get(gate.parentId ?? ROOT_ID) ?? root;
    let own: Membership;

    try {
      own = evaluateOne(gate, ctx, N);
    } catch (e) {
      errors.set(gate.id, e instanceof Error ? e.message : String(e));
      own = new Uint8Array(N);
    }

    // A population is always its own geometry intersected with its parent.
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = own[i]! & parentMask[i]!;
    masks.set(gate.id, mask);

    const count = countMask(mask);
    const parentCount = countMask(parentMask);
    stats.set(gate.id, {
      gateId: gate.id,
      count,
      parentCount,
      totalCount: N,
      percentOfParent: parentCount > 0 ? (count / parentCount) * 100 : 0,
      percentOfTotal: N > 0 ? (count / N) * 100 : 0,
    });
  }

  return { masks, stats, errors };
}

function evaluateOne(
  gate: Gate,
  ctx: GateContext,
  N: number,
): Membership {
  const mask = new Uint8Array(N);

  if (gate.kind === 'range') {
    const col = ctx.columnFor(gate, 'x');
    for (let i = 0; i < N; i++) mask[i] = inRange(gate, col[i]!) ? 1 : 0;
    return mask;
  }

  if (isGeometric(gate)) {
    const xs = ctx.columnFor(gate, 'x');
    const ys = ctx.columnFor(gate, 'y');
    for (let i = 0; i < N; i++) mask[i] = contains(gate, xs[i]!, ys[i]!) ? 1 : 0;
    return mask;
  }

  throw new Error(`Unknown gate kind: ${(gate as Gate).kind}`);
}

/** Event indices in a population, for export and for signature extraction. */
export function maskToIndices(mask: Membership): Uint32Array {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i]!;
  const out = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[k++] = i;
  return out;
}

/**
 * Copy a gating strategy onto another sample.
 *
 * Gate ids are regenerated so the two hierarchies stay independent, and parent
 * links are rewritten through the same mapping.
 *
 * `ownerSampleId` is **dropped**, and it has to be. The field means "this gate
 * exists on one file only", so carrying it through a copy would hand the target
 * a gate owned by the source — which `resolveGates` then filters straight back
 * out, silently shrinking a strategy the caller asked to be copied whole. Every
 * caller passes a list already resolved *for* one sample, so what is being
 * cloned is that sample's hierarchy and every gate in it belongs to whoever
 * receives the copy.
 */
export function cloneStrategy(gates: Gate[], newId: (old: string) => string): Gate[] {
  const idMap = new Map(gates.map((g) => [g.id, newId(g.id)]));
  return gates.map((g): Gate => {
    const out = {
      ...g,
      id: idMap.get(g.id)!,
      parentId: g.parentId ? idMap.get(g.parentId) ?? null : null,
    };
    delete out.ownerSampleId;
    return out;
  });
}
