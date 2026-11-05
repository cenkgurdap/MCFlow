import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useUI, type MainView } from '@/state/uiStore';
import { Button } from '@/ui/Button';

/**
 * The green bar that says a guided pipeline is finished, and what to do next.
 *
 * ## Why it exists (2026-08-19)
 *
 * Every guided panel in this application ends the same way: the last step's work
 * completes, the numbered tracker at the top shows the last number lit, and
 * nothing anywhere says *that was the end*. A step tracker cannot say it —
 * "step 4 of 4, current" is where you are, not whether you are done, and the
 * last step of each pipeline is also the step where the work is performed, so
 * standing on it means nothing on its own. Every one of the four ended with the
 * operator asking whether there was more.
 *
 * So each pipeline states it, in one shape, in the one place a person is already
 * looking. Reported as: *it is not clear if you have done with everything.*
 *
 * ## What it is allowed to claim
 *
 * Only that **the pipeline's own work is finished** — the matrix is built, the
 * populations are fitted, the projection has run, the worksheet is up. Never
 * that the analysis is finished, which is a judgement no application is in a
 * position to make: gates still want checking, and the cell-type step in
 * particular hands over a worksheet that has to be gated by hand afterwards.
 * The body text each caller passes says which of the two it means, and the
 * cell-type step's says plainly that the gating is the operator's.
 *
 * It is rendered only once the work is genuinely done. A banner that appears
 * with the step and waits to become true is furniture.
 *
 * ## Why green, and why this big
 *
 * `--status-ok` is the only colour in the palette that means *finished* — it is
 * the tick in the walk strips and the ok tone of `Callout`. This is a heavier
 * treatment than `Callout tone="ok"` on purpose: a terminal state is the one
 * thing on a step that should be readable without reading, and the four
 * pipelines being identical here is what makes it recognisable on the second
 * one. It sits at the **top** of its step for the same reason.
 *
 * ## Where next goes
 *
 * The suggestions are the panel's own, because only the caller knows what its
 * output is for — a matrix wants applying, a fitted set wants Statistics, a
 * projection is already the end of its own road. Each is a `MainView`, so the
 * button is a view switch and nothing more; there is no route here that does
 * work.
 */
export interface PipelineNext {
  view: MainView;
  label: string;
  /** One clause on what is over there. Rendered under the row, not on the button. */
  hint: string;
}

export function PipelineDone({
  title = 'Pipeline complete',
  children,
  actions,
  next = [],
  testId,
}: {
  title?: string;
  /** One or two plain sentences: what is finished, and what is not. */
  children: ReactNode;
  /**
   * The panel's own action, when finishing leaves one thing worth doing here
   * rather than elsewhere — *Apply it to a sample*. Above the view switches,
   * because it is about this pipeline and they are about leaving it.
   */
  actions?: ReactNode;
  next?: PipelineNext[];
  /** Marker for the harnesses — `data-unmixing-done`, and so on. */
  testId?: string;
}) {
  const setView = useUI((s) => s.setView);

  return (
    <div
      {...(testId ? { [testId]: '' } : {})}
      data-pipeline-done=""
      className={
        'flex gap-2.5 p-3 rounded-[var(--radius-md)] border '
        + 'bg-[var(--status-ok-bg)] border-[var(--status-ok)]/35'
      }
    >
      <CheckCircle2 size={20} className="shrink-0 mt-px text-[var(--status-ok)]" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-[var(--status-ok)] leading-tight">{title}</p>
        <div className="text-xs text-[var(--text-secondary)] leading-snug">{children}</div>

        {actions && <div className="flex flex-wrap items-center gap-1.5 pt-0.5">{actions}</div>}

        {next.length > 0 && (
          <div className="space-y-1.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {next.map((n) => (
                <Button
                  key={n.view + n.label}
                  size="sm"
                  variant="secondary"
                  data-pipeline-next={n.view}
                  onClick={() => setView(n.view)}
                >
                  {n.label}
                </Button>
              ))}
            </div>
            <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
              {next.map((n) => n.hint).join(' · ')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
