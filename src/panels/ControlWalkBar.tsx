import { controlIndexForLayout, controlIsGated } from '@/core/unmixing/wizard';
import { useBottomBar } from '@/state/bottomBar';
import { usePlot } from '@/state/plotStore';
import { useSpectral } from '@/state/spectralStore';
import { WalkBar } from './WalkBar';

/**
 * A tab per reference control, along the bottom of the worksheet.
 *
 * The primary way of moving through Step 3 of the unmixing wizard. Why a tab
 * strip rather than the layout dropdown, and why the position is derived from
 * `activeLayoutId` rather than held, are both in `WalkBar` — this is the wizard's
 * binding to it.
 *
 * ## What moved, and what did not (2026-08-14)
 *
 * The 190 lines of markup that used to be here are `WalkBar`, because the
 * Biophysics pipeline needed exactly the same strip and two copies of it would
 * agree on the day they were written and not for long. **Nothing about this
 * bar's behaviour or its DOM changed**: same `data-control-walk-bar` marker,
 * same `data-walk-tab` per control, same `data-walk-bar-{first,prev,next,last}`
 * and `data-walk-bar-counter`, which is what end-to-end tests drive
 * it by and what would otherwise have made a refactor look like a regression.
 *
 * It renders while the wizard is on Step 3, has worksheets, **and one of them is
 * on screen** — `useBottomBar`, the one function all three bottom strips ask.
 * That is what keeps it out of ordinary gating, what makes it and the biophysics
 * strip mutually exclusive, and what hands the bottom back to `LayoutBar` when a
 * general worksheet is opened mid-walk.
 */
export function ControlWalkBar() {
  const controls = useSpectral((s) => s.controls);
  const walkIndex = useSpectral((s) => s.walkIndex);
  const goToControl = useSpectral((s) => s.goToControl);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const owner = useBottomBar();

  if (owner !== 'reference') return null;

  const index = controlIndexForLayout(controls, activeLayoutId, walkIndex);
  const done = controls.filter(controlIsGated).length;

  return (
    <WalkBar
      testId="data-control-walk-bar"
      tabAttr="data-walk-tab"
      itemNoun="control"
      index={index}
      onGo={goToControl}
      // The order is `controls` as it stands: peak-detector order, settled where
      // the peaks are measured. Sorting here would be a second order to keep in
      // step with the one the Assign table and the layout dropdown show.
      items={controls.map((c) => ({
        id: c.sampleId,
        label: c.label,
        done: controlIsGated(c),
        // The tab also carries the one piece of state the walk is *for*, so
        // "what is left to do" is answerable without going back to the Unmixing
        // panel and reading the checklist.
        detail: [c.peak?.name, controlIsGated(c) ? null : 'not gated yet']
          .filter(Boolean).join(' · ') || undefined,
      }))}
      trailing={`${done}/${controls.length} gated`}
    />
  );
}
