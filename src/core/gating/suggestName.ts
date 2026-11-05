/**
 * The name a gate offers when it is finalised.
 *
 * A population is named at the moment it is created — the FCS Express and
 * FlowJo convention — so the suggestion has to be good enough that pressing
 * Enter without typing gives a name worth keeping. Two rules, in order:
 *
 * 1. If the gate discriminates on a single channel that carries a marker
 *    (`$PnS`), suggest `<marker>+`. A range gate on "CD3 FITC" is, essentially
 *    always, the CD3-positive population, and "CD3+" is what the operator was
 *    going to type.
 * 2. Otherwise `P1`, `P2`, … — FlowJo's convention, and the honest answer when
 *    the file carries no marker names. The Aurora files in this project have an
 *    empty `$PnS` in every parameter, so this is the path they take.
 *
 * Pure, so the rules can be asserted directly rather than through a rendered
 * component and a simulated keystroke.
 */

import type { Gate, GateKind } from './types';

export interface NameContext {
  kind: GateKind;
  /** Gates already in this sample, so the suggestion is unique. */
  existing: Gate[];
  /** `$PnS` of the x parameter, if the file carries one. */
  xStain?: string;
  /** `$PnS` of the y parameter. Absent for a one-dimensional gate. */
  yStain?: string;
}

/**
 * The marker from a `$PnS` string.
 *
 * `$PnS` conventionally reads "<marker> <fluorophore>" — "CD4 FITC", "CD19
 * AF647" — so the first token is the marker and the rest is the dye. Naming a
 * population after the dye would be wrong: two panels can put CD4 on different
 * fluorophores and the population is CD4 either way.
 */
export function markerOf(stain: string | undefined): string | null {
  const clean = (stain ?? '').trim();
  if (!clean) return null;
  const first = clean.split(/[\s/_-]+/)[0]!;
  // A bare fluorophore with no marker in front of it ("FITC", "APC-Cy7") names
  // the detector, not the population.
  return first.length >= 2 && !KNOWN_DYES.has(first.toUpperCase()) ? first : null;
}

/** Enough of the common dyes to catch a `$PnS` that names only the label. */
const KNOWN_DYES = new Set([
  'FITC', 'PE', 'APC', 'PERCP', 'PACIFIC', 'BV421', 'BV510', 'BV605', 'BV650', 'BV711',
  'BV786', 'AF488', 'AF647', 'AF700', 'AF750', 'PECY7', 'PECY5', 'APCCY7', 'APCFIRE',
  'CY5', 'CY7', 'DAPI', 'BB515', 'BUV395', 'BUV737', 'EFLUOR', 'ZOMBIE', 'VIABILITY',
]);

/** True when the gate bounds exactly one parameter. */
export function isOneDimensional(kind: GateKind): boolean {
  return kind === 'range';
}

export function suggestGateName(ctx: NameContext): string {
  const taken = new Set(ctx.existing.map((g) => g.name));

  // A quadrant names its own four populations from the split it just placed, so
  // there is nothing here to suggest — the caller supplies the stem.
  if (ctx.kind !== 'quadrant') {
    const marker = isOneDimensional(ctx.kind)
      ? markerOf(ctx.xStain)
      // On two axes a single marker does not describe the population: the gate
      // is a region in both, and "CD3+" would be a claim about only one of
      // them. Two markers do — that is a double-positive.
      : bothMarkers(ctx.xStain, ctx.yStain);
    if (marker && !taken.has(marker)) return marker;
  }

  return unique('P', taken);
}

function bothMarkers(xStain?: string, yStain?: string): string | null {
  const x = markerOf(xStain);
  const y = markerOf(yStain);
  return x && y ? `${x}+${y}+` : null;
}

/**
 * The population already carrying this name, if there is one.
 *
 * **One rule, two callers.** The naming prompt has refused a duplicate since
 * 2026-08-12 — two populations sharing a name leaves every surface that
 * identifies one *by* name (the export's path column, the compare chart's
 * picker, the statistics table's grouping) with two answers and no way to say
 * so. The gate tree's inline rename went straight to the store and never asked,
 * so the rule held for exactly one of the two ways a population gets its name.
 *
 * Trimmed and case-insensitive, matching the prompt: "CD4" and "cd4 " are one
 * population. `exceptId` is the gate being renamed — a gate does not collide
 * with itself, so re-committing an unchanged name is not a collision.
 */
export function nameCollision(
  gates: readonly Gate[],
  name: string,
  exceptId?: string | null,
): Gate | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return gates.find((g) => g.id !== exceptId && g.name.trim().toLowerCase() === wanted) ?? null;
}

/** `P1`, `P2`, … — the first index not already used. */
export function unique(stem: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}
