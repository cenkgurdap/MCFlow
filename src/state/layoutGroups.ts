import { useMemo } from 'react';
import { groupLayouts, type LayoutGroups } from '@/core/layout/layoutOrder';
import { usePlot } from './plotStore';
import { useSpectral } from './spectralStore';
import { useBiophysics } from './biophysicsStore';

/**
 * This window's worksheets, grouped and ordered, subscribed to the stores.
 *
 * The rule itself is `core/layout/layoutOrder.ts` — pure and tested. This is the
 * only thing that reads its inputs out of state, so the two surfaces that list
 * worksheets cannot drift apart again: the bottom tab strip flattens the groups,
 * the title-bar dropdown renders one `<optgroup>` per group, and both are
 * looking at one answer.
 *
 * Same shape, and the same argument, as `useBottomBar` beside it.
 */
export function useLayoutGroups(): LayoutGroups {
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const activeLayoutName = usePlot((s) => s.activeLayoutName);
  const activeLayoutKind = usePlot((s) => s.activeLayoutKind);
  const otherLayouts = usePlot((s) => s.otherLayouts);
  const controls = useSpectral((s) => s.controls);
  const bioSamples = useBiophysics((s) => s.samples);

  return useMemo(() => groupLayouts(
    [
      // The active layout is kept unpacked beside the map, so it is always the
      // one extra — see the note on `LayoutDef`, and the undo defect that came
      // of enumerating those fields by eye.
      { id: activeLayoutId, name: activeLayoutName, kind: activeLayoutKind },
      ...Object.values(otherLayouts).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
    ],
    {
      controls: controls.map((c) => c.layoutId),
      bioSamples: bioSamples.map((s) => s.layoutId),
      /*
         Read off the records rather than through the store's `immuneLayoutId()`
         accessor, because a `useMemo` over store state depends on values and
         never on the store's methods. The accessor also checks the layout still
         exists; here that check is free — an id naming no layout simply matches
         nothing and the group comes back empty.
      */
      cellTypes: bioSamples.find((s) => s.immuneLayoutId)?.immuneLayoutId ?? null,
    },
  ), [activeLayoutId, activeLayoutName, activeLayoutKind, otherLayouts, controls, bioSamples]);
}
