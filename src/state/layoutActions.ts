/**
 * Layout actions driven by a drag or a menu.
 *
 * One code path, several entry points: the worksheet's drop handler, the
 * "Open in new plot" context menu on a sample row, and the same menu on a gate
 * node all land here. Keeping them together is what stops the menu and the drop
 * from quietly diverging — they are the same operation, differing only in how
 * the user asked for it.
 *
 * Store reads go through `getState()` at call time rather than through captured
 * snapshots, because a snapshot taken before an earlier action in the same
 * gesture reports stale values — the trap PROGRESS.md records.
 */

import { panelForRequest, type OpenPanelContext } from '@/core/layout/openPanel';
import { nearestFreePosition, panelRect } from '@/core/layout/geometry';
import { usePlot } from './plotStore';
import { useGates } from './gateStore';
import { useWorkspace } from './workspaceStore';
import type { DragPayload } from '@/panels/dragPayload';

/**
 * The panel a new one should resemble.
 *
 * The active panel if there is one, otherwise the last in the layout. Someone
 * building a series of related plots wants the next to continue the series.
 */
function recentPanel() {
  const s = usePlot.getState();
  return s.panels.find((p) => p.id === s.activePanelId) ?? s.panels[s.panels.length - 1] ?? null;
}

function contextFor(sampleId: string, sourcePanelId?: string | null): OpenPanelContext | null {
  const sample = useWorkspace.getState().samples.find((s) => s.id === sampleId);
  if (!sample) return null;
  return {
    metadata: sample.parsed.metadata,
    gates: useGates.getState().gatesFor(sampleId),
    recent: recentPanel(),
    // The plot the gate was dragged off, when there was one. Resolved here
    // rather than passed as a `PanelConfig`, so every caller hands over an id
    // and cannot supply a stale copy of a panel that has since moved.
    source: sourcePanelId ? usePlot.getState().panel(sourcePanelId) ?? null : null,
  };
}

/**
 * Open one panel per sample, at the root population.
 *
 * Plural because a multi-selection drags as a unit: comparing three replicates
 * side by side should be one gesture, not three. Each panel is created against
 * the layout as it stands after the previous one, so a batch inherits the
 * column growth rather than all landing in a one-column layout.
 */
export function openPanelsForSamples(sampleIds: string[]): string[] {
  const ids: string[] = [];
  for (const sampleId of sampleIds) {
    const ctx = contextFor(sampleId);
    if (!ctx) continue;
    ids.push(usePlot.getState().openPanel(panelForRequest({ sampleId, populationId: null }, ctx)));
  }
  return ids;
}

/**
 * Open a panel scoped to one population.
 *
 * The panel shows only that population's events, and any gate drawn on it
 * becomes the population's child — which is the whole reason for dragging a
 * gate onto the worksheet instead of drawing the next one on top of the first.
 */
export function openPanelForPopulation(
  sampleId: string,
  gateId: string,
  /**
   * The panel the gate was dragged out of, when it was dragged out of one.
   *
   * The new plot opens on its axes (2026-08-12, Item 10) — sequential gating
   * changes one axis per step, so the plot you want next is the one you were
   * just looking at. Omitted by the sidebar tree and the context menus, which
   * name a population without naming a plot.
   */
  sourcePanelId?: string | null,
): string | null {
  const ctx = contextFor(sampleId, sourcePanelId);
  if (!ctx) return null;
  // A gate that has since been deleted would scope the panel to nothing;
  // opening at the root is the honest fallback.
  const exists = ctx.gates.some((g) => g.id === gateId);
  return usePlot.getState().openPanel(
    panelForRequest({ sampleId, populationId: exists ? gateId : null }, ctx),
  );
}

/** Route a dropped payload to the right opener. Returns the new panel ids. */
export function openFromPayload(payload: DragPayload): string[] {
  if (payload.kind === 'sample') return openPanelsForSamples(payload.sampleIds);
  const id = openPanelForPopulation(payload.sampleId, payload.gateId, payload.sourcePanelId);
  return id ? [id] : [];
}

/**
 * The same, but landing where the pointer was released.
 *
 * The worksheet is a positioned canvas, so a drop has a place as well as a
 * meaning — the plot should appear under the pointer rather than at the end of a
 * queue. A release that would overlap an existing panel is nudged to the nearest
 * clear spot rather than refused: refusing a drop leaves the user with nothing
 * to act on, and "empty space" is now a property of the position rather than of
 * a cell being unused.
 *
 * A batch of samples cascades from the release point for the same reason a
 * single one lands on it — three replicates dropped together should read as
 * three plots, laid out, not three plots stacked on one another.
 */
export function openFromPayloadAt(
  payload: DragPayload,
  at: { x: number; y: number },
  viewportWidth: number,
): string[] {
  const ids = openFromPayload(payload);
  const plot = usePlot.getState();
  const placed = plot.panels
    .filter((p) => !ids.includes(p.id))
    .map((p) => panelRect(p.x, p.y, p.w));

  ids.forEach((id, i) => {
    const panel = usePlot.getState().panel(id);
    if (!panel) return;
    const desired = { x: at.x + i * 24, y: at.y + i * 24 };
    const spot = nearestFreePosition(desired, placed, panel.w, viewportWidth);
    placed.push(panelRect(spot.x, spot.y, panel.w));
    usePlot.getState().movePanel(id, spot.x, spot.y);
  });
  return ids;
}

/**
 * Re-target an existing panel instead of creating one.
 *
 * Axes, transforms and plot type stay put; only the data underneath changes.
 * That is the useful half of the gesture — A/B-ing one view across samples, or
 * following the same pair of markers down a hierarchy.
 */
export function retargetPanel(panelId: string, payload: DragPayload): boolean {
  const plot = usePlot.getState();
  if (!plot.panel(panelId)) return false;

  // Deliberately not `setPanelSample`: that clears `initialisedFor`, which makes
  // the panel's mount effect reset the axes to FSC/SSC. Holding the axes still
  // while the data underneath changes is the entire point of this gesture.
  if (payload.kind === 'sample') {
    const sampleId = payload.sampleIds[0];
    if (!sampleId) return false;
    // Pinned, not following: the user named this sample explicitly.
    plot.updatePanel(panelId, { sampleId, populationId: null, initialisedFor: sampleId });
    return true;
  }

  // A population drop names a population and not a file. Gating is shared, so
  // the panel is put back on **follow** and shows this population against
  // whichever sample is active — the same rule a dropped population uses when it
  // opens a panel of its own.
  plot.updatePanel(panelId, { sampleId: null, initialisedFor: payload.sampleId });
  plot.setPanelPopulation(panelId, payload.gateId);
  return true;
}
