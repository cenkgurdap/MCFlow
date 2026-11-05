/**
 * Which guided panel generated a worksheet, when one did.
 *
 * A file of its own, and the reason is a dependency direction rather than the
 * size of the type. `LayoutDef` lives in `state/plotStore` and `WorkspaceLayout`
 * lives in `core/workspace`; both carry this field and both have to agree about
 * its values, and `core` must not import `state`. Written down once here, it
 * cannot be widened in one and not the other — which is exactly what happened
 * when `'reference'` was spelled inline in five places and a sixth kept treating
 * every generated worksheet as a general one.
 *
 * `undefined` is a **general** layout: the boot worksheet, and everything *New
 * layout* makes. That is deliberately the absent case rather than a `'general'`
 * member, so every workspace and every sibling-window snapshot written before
 * the field existed reads correctly without a migration.
 *
 * A closed union rather than a string, so adding a fourth guided panel forces the
 * addition here and therefore forces a look at everything that switches on it:
 * the two layout strips, `state/gateVisibility`, and each panel's own sweep for
 * worksheets whose owner has gone.
 */
export type LayoutKind = 'reference' | 'biophysics';

/**
 * A `kind` read from a file or from a sibling window, or `undefined`.
 *
 * A value this build does not recognise falls through to *general*, which is the
 * only reading that draws something: a worksheet whose owning panel does not
 * exist here is not owned by anything here. Same rule `sanitisePanel` applies to
 * a ramp name that has been removed, and for the same reason — the alternative is
 * a layout that silently belongs to a walk nothing can walk.
 */
export function asLayoutKind(v: unknown): LayoutKind | undefined {
  return v === 'reference' || v === 'biophysics' ? v : undefined;
}
