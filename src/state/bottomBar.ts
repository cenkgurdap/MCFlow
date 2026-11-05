import { isWalkingControls } from '@/core/unmixing/wizard';
import { isWalkingSamples } from '@/core/biophysics/pipeline';
import { bottomBarOwner, type BottomBar } from '@/core/layout/bottomBar';
import { usePlot } from './plotStore';
import { useSpectral } from './spectralStore';
import { useBiophysics } from './biophysicsStore';

/**
 * Which strip owns the bottom of the worksheet, subscribed to the stores.
 *
 * The rule itself is `core/layout/bottomBar.ts` — pure, tested, and stated once.
 * This is the only thing that reads the four inputs out of state, so the three
 * components that render a bottom strip cannot drift apart again: each asks this
 * and renders if the answer names it.
 *
 * It replaced a `useWalking()` local to `LayoutBar` that the two walk bars did
 * not share. See the core module for what that cost.
 */
export function useBottomBar(): BottomBar {
  const tab = useSpectral((s) => s.tab);
  const step = useSpectral((s) => s.step);
  const controls = useSpectral((s) => s.controls);
  const bioSamples = useBiophysics((s) => s.samples);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const activeLayoutKind = usePlot((s) => s.activeLayoutKind);
  const otherLayouts = usePlot((s) => s.otherLayouts);

  return bottomBarOwner({
    walkingControls: isWalkingControls(tab, step, controls),
    // The Biophysics step is deliberately not an input any more — the strip
    // belongs to the worksheet on screen, not to a step. See `biophysicsWalk`.
    walkingSamples: isWalkingSamples(bioSamples, activeLayoutId),
    activeLayoutKind,
    // The active layout is not in `otherLayouts`; it is always the one extra.
    layoutCount: Object.keys(otherLayouts).length + 1,
  });
}
