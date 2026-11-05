import { useMemo } from 'react';
import { GateTree } from './GateTree';
import { SampleBrowser } from './SampleBrowser';
import { mergeControlTrees, type ControlEvaluation } from './panelGateTree';
import { controlIndexForLayout, isWalkingControls } from '@/core/unmixing/wizard';
import { evaluateFor, defaultSpecFor, resolveGates, useGates } from '@/state/gateStore';
import { useVisibleGates } from '@/state/gateVisibility';
import { usePlot } from '@/state/plotStore';
import { useSpectral } from '@/state/spectralStore';
import { selectedSample, useWorkspace } from '@/state/workspaceStore';
import { EmptyState } from '@/ui/Feedback';
import { Square } from 'lucide-react';

/**
 * Left sidebar: sample browser above, gating tree below.
 *
 * They share the column rather than living in tabs because building a gating
 * strategy means moving between "which sample" and "which population"
 * constantly, and hiding either behind a tab makes that a two-click loop.
 *
 * ## Two things the tree can be about (2026-08-09)
 *
 * Ordinarily it is about **one sample**: gating is shared, so every sample shows
 * the same populations with its own numbers, and the selected sample is the one
 * whose numbers those are.
 *
 * During the unmixing wizard's gating walk it is about **the reference panel**.
 * A control's positive gate belongs to one file (`ownerSampleId`, 2026-08-08)
 * precisely so that no worksheet draws another control's population — which also
 * means no single sample's gate list contains the panel. The step's work is
 * getting thirteen populations right *together*, and the one place the app lists
 * populations was showing at most one of them, usually not even the one on
 * screen: the sidebar follows the sample browser's selection, and during a walk
 * that is routinely the multicolour sample nobody is gating.
 *
 * So while the walk is on, this evaluates every control against its own file and
 * merges the results — see `mergeControlTrees` for which number comes from
 * where. The control whose worksheet is on screen leads, so the shared rows and
 * the root read as the plot in front of the user reads.
 */
export function Sidebar() {
  const sample = useWorkspace(selectedSample);
  const samples = useWorkspace((s) => s.samples);
  /*
     The shared strategy unless this sample has been forked off it, **and with
     the unmixing wizard's own gates left out unless this is one of its
     worksheets** (2026-08-12, Item 11).

     `useVisibleGates` is the join of those two questions. This tree is where the
     leak was reported: on a general layout it listed the shared cell gate and
     every control's bracket, at 0.00%, above the user's own populations.
  */
  const gates = useVisibleGates(sample?.id);

  /*
     The three pieces `resolveGates` folds together, subscribed to individually
     rather than through `gatesOfSample`, because the panel view resolves a list
     per control rather than one for the selected sample. Same inputs, thirteen
     answers.
  */
  const shared = useGates((s) => s.shared);
  const divergent = useGates((s) => s.divergent);
  const overrides = useGates((s) => s.overrides);

  const tab = useSpectral((s) => s.tab);
  const step = useSpectral((s) => s.step);
  const controls = useSpectral((s) => s.controls);
  const walkIndex = useSpectral((s) => s.walkIndex);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const walking = isWalkingControls(tab, step, controls);

  const panel = useMemo(() => {
    if (!walking) return null;
    const byId = new Map(samples.map((s) => [s.id, s]));
    const index = controlIndexForLayout(controls, activeLayoutId, walkIndex);
    // The control on screen first — it is what decides the shared rows' numbers
    // — then the rest of the walk in its own order.
    const ordered = [controls[index], ...controls.filter((_, i) => i !== index)]
      .filter((c): c is NonNullable<typeof c> => !!c);

    const evaluations: ControlEvaluation[] = [];
    for (const c of ordered) {
      const s = byId.get(c.sampleId);
      if (!s) continue;
      const list = resolveGates(shared, divergent, overrides, s.id);
      const ev = evaluateFor(s.id, s.parsed, list, (p) => defaultSpecFor(s.parsed, p));
      evaluations.push({ sampleId: s.id, gates: list, stats: ev.stats, errors: ev.errors });
    }
    if (evaluations.length === 0) return null;
    return { anchorSampleId: evaluations[0]!.sampleId, ...mergeControlTrees(evaluations) };
  }, [walking, samples, controls, activeLayoutId, walkIndex, shared, divergent, overrides]);

  const evaluated = useMemo(() => {
    if (!sample || panel) return null;
    return evaluateFor(sample.id, sample.parsed, gates, (p) => defaultSpecFor(sample.parsed, p));
  }, [sample, gates, panel]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 flex flex-col" style={{ maxHeight: '55%' }}>
        <SampleBrowser />
      </div>
      <div className="hairline-t flex-1 min-h-0 flex flex-col bg-[var(--surface-sunken)]">
        {panel ? (
          <GateTree
            // The control on screen, so the header's unlink/relink and the
            // context menu's "open in new plot" act on the worksheet in front of
            // the user rather than on the sample browser's selection.
            sampleId={panel.anchorSampleId}
            gates={panel.gates}
            stats={panel.stats}
            errors={panel.errors}
            scopeNote={`Reference panel — ${controls.length} control${controls.length === 1 ? '' : 's'}, each counted on its own file`}
          />
        ) : sample && evaluated ? (
          <GateTree
            sampleId={sample.id}
            gates={gates}
            stats={evaluated.stats}
            errors={evaluated.errors}
          />
        ) : (
          <EmptyState
            size="sm"
            className="my-auto"
            icon={<Square size={15} />}
            title="No sample selected"
            description="Select a sample to build a gating strategy."
          />
        )}
      </div>
    </div>
  );
}
