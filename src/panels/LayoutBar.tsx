import { Atom, Columns3, CornerDownRight, Users, Waves } from 'lucide-react';
import type { LayoutKind } from '@/core/layout/layoutKind';
import { flattenLayoutGroups } from '@/core/layout/layoutOrder';
import { useBottomBar } from '@/state/bottomBar';
import { useLayoutGroups } from '@/state/layoutGroups';
import { usePlot } from '@/state/plotStore';
import { useWorkspace } from '@/state/workspaceStore';
import { Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { useKeepTabVisible } from './useKeepTabVisible';

/** One entry on the strip: what it is called and which kind of worksheet it is. */
interface LayoutTab {
  id: string;
  name: string;
  kind: LayoutKind | undefined;
}

/**
 * Every worksheet this window can reach, in the order both surfaces show them.
 *
 * Shared by the tab strip and by the *Move plot to* control now that the two
 * live at opposite ends of the window (2026-08-12, Item 3). They were one
 * component until then and the order was a local `useMemo`; splitting them
 * without lifting this would have left two lists that agree today and are one
 * edit away from not.
 *
 * The order itself moved to `core/layout/layoutOrder.ts` on 2026-08-21, because
 * "the same grouping the top-bar dropdown uses" was a claim rather than a
 * mechanism: the dropdown held a verbatim copy of the comparator. They are two
 * views of one list and now they read one function.
 */
function useOrderedLayouts(): LayoutTab[] {
  return flattenLayoutGroups(useLayoutGroups());
}

/**
 * A tab per worksheet along the bottom of the layout, and a way to send a plot
 * to one of them.
 *
 * ## Why this exists
 *
 * The unmixing wizard has had a bottom tab strip since 2026-08-07
 * (`ControlWalkBar`) and it is the right instrument for the job: switching
 * worksheet is a thing done constantly while working *in* a worksheet, and the
 * layout dropdown answers that question from the opposite corner of the window.
 * General layouts had only the dropdown, so the affordance existed for the
 * thirteen worksheets an operator visits once each and not for the two or three
 * they live in.
 *
 * The two bars never appear together: `ControlWalkBar` renders during Step 3 of
 * the wizard and this one renders when it does not. One strip of tabs at the
 * bottom of the worksheet, showing whichever set of worksheets is currently the
 * point.
 *
 * ## Moving a plot between layouts
 *
 * That control **left this bar on 2026-08-12** (Item 3) for the status bar's
 * right-hand end, beside the window zoom. It is `MovePlotControl` below, and the
 * reasoning is recorded there.
 */
export function LayoutBar() {
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const switchLayout = usePlot((s) => s.switchLayout);
  const groups = useLayoutGroups();
  const ordered = flattenLayoutGroups(groups);
  // The one cell-type worksheet, so this strip can mark it as the different kind
  // of thing it is rather than drawing it as a ninth per-sample sheet.
  const cellTypeId = groups.cellTypes[0]?.id ?? null;
  const owner = useBottomBar();

  // Above the early return: a hook cannot be called conditionally, and the
  // strip it measures is the thing that early return decides not to draw.
  const stripRef = useKeepTabVisible<HTMLDivElement>(
    activeLayoutId,
    ordered.length,
    '[data-layout-tab-active]',
  );

  // A walk bar owns the bottom only while its own worksheet is on screen — see
  // `core/layout/bottomBar.ts`. Standing anywhere else, this strip is the one
  // that can name where you are.
  if (owner !== 'layouts') return null;

  return (
    <div
      data-layout-bar=""
      className="flex items-center gap-1.5 h-9 px-2 shrink-0 hairline-t bg-[var(--surface-sunken)]"
    >
      <Columns3 size={12} className="shrink-0 text-[var(--text-tertiary)]" />

      {/* Scrolls rather than shrinking, for the same reason the control walk
          strip does: a tab squeezed to four characters has stopped being a way
          of finding the worksheet you want. */}
      <div ref={stripRef} className="flex-1 min-w-0 flex items-stretch gap-px overflow-x-auto">
        {ordered.map((l) => {
          const active = l.id === activeLayoutId;
          return (
            <button
              key={l.id}
              type="button"
              data-layout-tab={l.name}
              data-layout-tab-active={active ? '' : undefined}
              title={
                // "a reference control worksheet", not "an unmixing reference
                // worksheet": `kind: 'reference'` is what the Compensation panel
                // builds too, and this strip has no business naming an
                // instrument it would be wrong about half the time.
                l.kind === 'reference' ? `${l.name} — a reference control worksheet`
                  : l.id === cellTypeId
                    ? `${l.name} — one biophysics worksheet for the whole experiment, shown one sample at a time`
                    : l.kind === 'biophysics' ? `${l.name} — a biophysics worksheet, one per sample`
                      : l.name
              }
              onClick={() => switchLayout(l.id)}
              className={cn(
                'shrink-0 max-w-[190px] flex items-center gap-1.5 px-2 h-7 self-center rounded-[var(--radius-xs)]',
                'text-2xs whitespace-nowrap transition-colors duration-[var(--dur-fast)]',
                active
                  ? 'bg-[var(--surface-selected)] text-[var(--text-accent)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
              )}
            >
              {/* The glyph that distinguishes the kinds on this strip. A
                  generated worksheet is walked in order and owned by the panel
                  that made it — and the two panels' glyphs are their own
                  navigation icons, so the tab says which one; a general layout
                  is one somebody made and carries nothing. */}
              {l.kind === 'reference' && <Waves size={10} className="shrink-0 opacity-70" />}
              {l.kind === 'biophysics' && (
                l.id === cellTypeId
                  // Its own glyph, because it is its own kind of worksheet: one
                  // for the experiment where the others are one per sample. A
                  // strip that draws it as a ninth sample sheet is the confusion
                  // the walk bar's worksheet switch exists to end, one surface out.
                  ? <Users size={10} className="shrink-0 opacity-70" />
                  : <Atom size={10} className="shrink-0 opacity-70" />
              )}
              <span className="truncate">{l.name}</span>
            </button>
          );
        })}
      </div>

    </div>
  );
}

/**
 * Send the current plot to another worksheet — in the status bar's right-hand
 * end, beside the window zoom.
 *
 * ## What it does
 *
 * A plot could only ever be created in the worksheet you were standing in, so
 * "this belongs on the summary layout" meant rebuilding it there: the sample,
 * the population, both axes, both transforms and the plot type, every one of
 * which is already correct on the panel in front of you. This hands the panel
 * over with its identity and every setting intact — see `movePanelToLayout`.
 *
 * It acts on the **selected** plot, falling back to the active one, and names
 * whichever it is in the tooltip. An action that moves something has to say what
 * it is about to move.
 *
 * ## Why it is here and not on the tab strip (2026-08-12, Item 3)
 *
 * It shipped on the right-hand end of `LayoutBar` on 2026-08-10, which put it in
 * a bar that **comes and goes**: that strip renders only when there are at least
 * two worksheets and not at all while the wizard is walking its controls, and it
 * sits above a status bar that is always there. So the one control on the
 * worksheet for relocating a plot moved up and down the window by nine pixels,
 * or vanished, depending on state that has nothing to do with plots.
 *
 * The status bar is the window's fixed row of window-scoped controls, and the
 * zoom that arrived on 2026-08-10 is already the last thing in it for the same
 * reason. Two window-scoped controls in one corner is one place to look.
 *
 * **The visibility rules that were the bar's are kept, and now belong to the
 * control itself**: nothing to move to means nothing to render, and the wizard's
 * walk still owns its own navigation. Those were implicit in which bar this
 * lived on; they are stated here because they no longer come for free.
 */
export function MovePlotControl() {
  const panels = usePlot((s) => s.panels);
  const activePanelId = usePlot((s) => s.activePanelId);
  const selectedPanelId = usePlot((s) => s.selectedPanelId);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const movePanelToLayout = usePlot((s) => s.movePanelToLayout);
  const samples = useWorkspace((s) => s.samples);
  const selectedSampleId = useWorkspace((s) => s.selectedSampleId);
  const ordered = useOrderedLayouts();
  const owner = useBottomBar();

  const target = panels.find((p) => p.id === selectedPanelId)
    ?? panels.find((p) => p.id === activePanelId)
    ?? panels[0];

  if (owner !== 'layouts' || !target) return null;

  /** What the plot about to be moved is called, in the words its header uses. */
  const targetLabel = samples.find((s) => s.id === (target.sampleId ?? selectedSampleId))?.name ?? null;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <Tooltip
        content={
          `Move ${targetLabel ? `the “${targetLabel}” plot` : 'this plot'} to another worksheet, `
          + 'keeping its sample, population, axes and transforms'
        }
      >
        <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
          <CornerDownRight size={11} />
          Move plot to
        </span>
      </Tooltip>
      {/*
         A `<select>` that never holds a value: every option is an action and
         the placeholder is what it shows afterwards. Anything else would have to
         answer "which layout is this plot in", which is the tab strip's question
         and is already answered by the strip.
      */}
      <select
        value=""
        data-move-panel-layout=""
        aria-label="Move the current plot to another worksheet"
        onChange={(e) => { if (e.target.value) movePanelToLayout(target.id, e.target.value); }}
        className="h-5 px-1 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] text-2xs text-[var(--text-secondary)] max-w-[150px]"
      >
        <option value="">Choose…</option>
        {ordered.filter((l) => l.id !== activeLayoutId).map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
    </div>
  );
}
