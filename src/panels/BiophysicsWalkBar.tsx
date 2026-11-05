import { useEffect } from 'react';
import {
  biophysicsWalk, crossWalkIndex, isFitted, sampleIndexForLayout, walkFamilies,
  type BiophysicsWalk,
} from '@/core/biophysics/pipeline';
import { useBottomBar } from '@/state/bottomBar';
import { useBiophysics } from '@/state/biophysicsStore';
import { usePlot } from '@/state/plotStore';
import { useWorkspace } from '@/state/workspaceStore';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { WalkBar } from './WalkBar';

/**
 * A tab per sample, along the bottom of any worksheet the Biophysics pipeline
 * generated.
 *
 * The same instrument the unmixing wizard's Step 3 uses and literally the same
 * component — see `WalkBar` for why a tab strip rather than the layout dropdown.
 * Reviewing a per-sample worksheet is the same shape of task as gating a
 * per-control one: a sequence of near-identical pages with a defined order,
 * walked once each.
 *
 * ## Two walks, one strip (2026-08-18)
 *
 * Which one is showing comes from `biophysicsWalk`, which asks what the
 * worksheet on screen *is* rather than which step the panel is on:
 *
 *   - **`samples`** — the per-sample distribution worksheets. A tab switches
 *     layout, and the position is read back off `activeLayoutId`, which is what
 *     makes the strip, the panel's own arrows and the layout dropdown one
 *     control rather than three.
 *   - **`cell-types`** — the single cell-type worksheet. There is one layout, so
 *     a tab **re-points** it at another sample instead; the position is
 *     `walkIndex`, which is the only thing that can distinguish them.
 *
 * Both were missing before. The strip rendered on Step 4 alone, so the three
 * earlier steps that build and rewrite those same worksheets had no arrows at
 * all, and the cell-type sheet — the one that genuinely cannot be walked any
 * other way, because every sample is the same layout — had none either. That
 * left the only way through it in a panel on a different view from the plots,
 * which reads exactly as the walk not working.
 *
 * The tab's done marker is *fitted*, not *reviewed*. There is no way for the
 * application to know somebody has looked at a fit, and a tick that meant
 * "opened" would be a tick that means nothing — whereas "this sample has
 * populations" is a fact, and an empty ring is what is left to do. On the
 * cell-type walk nothing is ticked: there is
 * no per-sample state on that sheet to be done or not done, which is the whole
 * point of it being one sheet.
 *
 * ## The sample browser drives it too (2026-08-19)
 *
 * On the cell-type sheet, clicking a sample in the left-hand list re-points the
 * worksheet at it — the effect below — and every other way of moving the walk
 * moves that selection back, in `showImmuneSample`.
 *
 * This is the one worksheet in the application where the sample browser can mean
 * that. Everywhere else a panel names its own sample and several panels on one
 * sheet routinely name different ones, so a selection cannot re-point anything
 * without deciding which panel it meant. Here every panel is the same sample by
 * construction, and the sheet's whole purpose is being walked across the set.
 *
 * It also settles which sample the **gate tree** is about, which is not
 * cosmetic: the tree beneath the browser is where a cell type is renamed,
 * unlinked or checked, and on this sheet it was routinely showing another file's
 * percentages while the operator gated the one on screen.
 *
 * The two directions cannot loop. Each writes the value the other reads and both
 * return early when the walk is already where it is being asked to go.
 *
 * ## Which worksheet, and which sample, are two questions (2026-08-21)
 *
 * The strip answered only the second. Standing on the cell-type sheet after a
 * pipeline over eight samples, it drew eight sample names and a page counter, so
 * nothing on screen said whether a click would leave that sheet — and once the
 * eight per-sample worksheets and the one cell-type worksheet both existed,
 * there was no way to cross between them except the layout dropdown in the
 * opposite corner of the window, which knows nothing about either.
 *
 * The two are orthogonal and are now drawn that way: the segmented control names
 * **which kind of worksheet**, the tabs name **which sample**, and changing
 * either keeps the other's answer. Crossing carries the sample by **id** — see
 * `crossWalkIndex`, because the two walks index two different lists — and it
 * calls the same two actions the tabs already call, so there is one way into
 * each worksheet rather than a second one written for this control.
 *
 * The segment appears only once both kinds exist. That is `walkFamilies`, and it
 * is what keeps offering the choice from ever being what builds the sheet.
 */
export function BiophysicsWalkBar() {
  const records = useBiophysics((s) => s.samples);
  const walkIndex = useBiophysics((s) => s.walkIndex);
  const goToSample = useBiophysics((s) => s.goToSample);
  const showImmuneSample = useBiophysics((s) => s.showImmuneSample);
  const pipelineSamples = useBiophysics((s) => s.pipelineSamples);
  const samples = useWorkspace((s) => s.samples);
  const selectedSampleId = useWorkspace((s) => s.selectedSampleId);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const owner = useBottomBar();

  const walk = biophysicsWalk(records, activeLayoutId);

  /*
     Above the early return, because a hook cannot be conditional — and this
     component is mounted at all times, returning null when another strip owns
     the bottom of the worksheet. That is what makes it the right home for this:
     it is already the thing that knows which walk is on screen, and it is
     mounted whether or not it is drawing.

     Deliberately not keyed on `owner`. Which strip is drawn is a question about
     the bottom bar; which sample the sheet shows is a question about the sheet.
  */
  useEffect(() => {
    if (walk !== 'cell-types' || !selectedSampleId) return;
    const scoped = pipelineSamples(samples);
    const at = scoped.findIndex((s) => s.id === selectedSampleId);
    // Not in the pipeline's set — a single-stain control, say. The worksheet
    // stays where it is rather than jumping to a neighbour.
    if (at < 0 || at === Math.min(Math.max(0, walkIndex), scoped.length - 1)) return;
    showImmuneSample(samples, at);
  }, [walk, selectedSampleId, samples, walkIndex, pipelineSamples, showImmuneSample]);

  if (owner !== 'biophysics' || !walk) return null;

  const nameOf = (id: string) => samples.find((s) => s.id === id)?.name ?? id;

  // The pipeline's own set and its own order, which is what `showImmuneSample`
  // indexes into. Taking the workspace list here would put the eleven
  // single-stain controls in a strip that walks the eight samples.
  const scoped = pipelineSamples(samples);
  const cellTypeIndex = Math.min(Math.max(0, walkIndex), Math.max(0, scoped.length - 1));
  const sampleIndex = sampleIndexForLayout(records, activeLayoutId, walkIndex);

  /*
     Which file is on screen, asked of whichever walk is drawing — the two read
     their position from different places for the reason `sampleIndexForLayout`
     records. This is the value the crossing carries, and it is an id rather than
     a position because the two walks index two different lists.
  */
  const currentId = walk === 'cell-types'
    ? scoped[cellTypeIndex]?.id ?? null
    : records[sampleIndex]?.sampleId ?? null;

  const crossTo = (target: BiophysicsWalk) => {
    if (target === walk) return;
    if (target === 'cell-types') {
      showImmuneSample(samples, crossWalkIndex(scoped.map((s) => s.id), currentId, walkIndex));
    } else {
      goToSample(crossWalkIndex(records.map((r) => r.sampleId), currentId, walkIndex));
    }
  };

  /*
     Offered only once there are two kinds of worksheet to choose between, so it
     is never the thing that builds the second one.

     `tone="accent"` for the reason `SegmentedControl` gives for the view
     switcher: this is navigation rather than a setting, and a neutral chip a
     shade lighter than the one beside it does not say where you are. It is the
     second such control in the application and the first was the argument for
     the tone existing.
  */
  const family = walkFamilies(records).length > 1 ? (
    <SegmentedControl
      name="biophysics-walk-family"
      size="sm"
      tone="accent"
      value={walk}
      onChange={crossTo}
      segments={[
        {
          value: 'samples',
          label: 'Per sample',
          title: 'One worksheet per sample — this sample’s distribution, and the split fitted inside it.',
        },
        {
          value: 'cell-types',
          label: 'Cell types',
          title: 'One worksheet for the whole experiment. It shows one sample at a time; the gates you draw on it are measured on every sample.',
        },
      ]}
    />
  ) : undefined;

  if (walk === 'cell-types') {
    return (
      <WalkBar
        testId="data-biophysics-walk-bar"
        tabAttr="data-bio-walk-tab"
        itemNoun="sample"
        index={cellTypeIndex}
        onGo={(i) => showImmuneSample(samples, i)}
        items={scoped.map((s) => ({ id: s.id, label: s.name, done: false }))}
        leading={family}
        /*
           What this sheet *is*, rather than how many files it walks — the count
           is already in the page counter two controls to the left, and "does
           what I draw here land on the other seven" is the question this strip
           was reported for.

           "Drawn" is load-bearing. A gate drawn here is an ordinary shared gate
           and does apply to every sample; the Live / Dead bands are one shared
           definition with a boundary per file, because the fit is per file. The
           gate tree's unlinked badge is where that per-gate distinction is
           read, and it is already there.
        */
        trailing="Drawn gates apply to every sample"
      />
    );
  }

  const done = records.filter(isFitted).length;

  return (
    <WalkBar
      testId="data-biophysics-walk-bar"
      // A marker of its own rather than `data-walk-tab`. The two strips cannot
      // be mounted at once, so a shared name would work — and a harness reaching
      // for `[data-walk-tab]` globally would then silently find whichever panel
      // happened to be open, which is the class of ambiguity this project keeps
      // recording rather than the kind it tolerates.
      tabAttr="data-bio-walk-tab"
      itemNoun="sample"
      index={sampleIndex}
      onGo={goToSample}
      leading={family}
      items={records.map((r) => ({
        id: r.sampleId,
        label: nameOf(r.sampleId),
        done: isFitted(r),
        detail: r.fit
          ? `${r.fit.components.length} population${r.fit.components.length === 1 ? '' : 's'}`
            + (r.countSource === 'user' ? ' · set by hand' : '')
          : 'not fitted yet',
      }))}
      trailing={`${done}/${records.length} fitted`}
    />
  );
}
