import {
  Activity, AppWindow, Atom, Columns3, Database, Download, FolderPlus, Grid3x3, Network, Sigma,
  Table2, Waves, X,
} from 'lucide-react';
import { AppShell, StatusItem } from '@/app/AppShell';
import { MetadataPanel } from '@/panels/MetadataPanel';
import { GateDeleteConfirm } from '@/panels/GateDeleteConfirm';
import { MissingFilesPrompt } from '@/app/MissingFilesPrompt';
import { ParametersView } from '@/panels/ParametersView';
import { PlotGrid, AddPlotButton } from '@/panels/PlotGrid';
import { ControlWalkBar } from '@/panels/ControlWalkBar';
import { LayoutBar, MovePlotControl } from '@/panels/LayoutBar';
import { UnmixingView } from '@/panels/UnmixingView';
import { BiophysicsView } from '@/panels/BiophysicsView';
import { UmapView } from '@/panels/UmapView';
import { BiophysicsWalkBar } from '@/panels/BiophysicsWalkBar';
import { StatisticsView } from '@/panels/StatisticsView';
import { ExportView } from '@/panels/ExportView';
import { formatFull } from '@/panels/SampleBrowser';
import { Sidebar } from '@/panels/Sidebar';
import { platform } from '@/platform';
import { useUI } from '@/state/uiStore';
import { useViewLock } from '@/state/viewLock';
import { useLayoutGroups } from '@/state/layoutGroups';
import { usePlot } from '@/state/plotStore';
import { acquisitionTypeOf, selectedSample, totalEvents, useWorkspace } from '@/state/workspaceStore';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { Tooltip } from '@/ui/Tooltip';
import { IconButton } from '@/ui/Button';
import { Save } from 'lucide-react';
import { saveWorkspaceToFile } from '@/state/workspaceIO';

export default function App() {
  const { view, setView } = useUI();
  const samples = useWorkspace((s) => s.samples);
  const importFiles = useWorkspace((s) => s.importFiles);
  const sample = useWorkspace(selectedSample);
  // Undefined when the layout has been emptied out, which is now a real state.
  const activePanel = usePlot((s) => s.panels.find((p) => p.id === s.activePanelId) ?? s.panels[0]);
  const panelCount = usePlot((s) => s.panels.length);

  const spectralCount = samples.filter((s) => acquisitionTypeOf(s) === 'spectral').length;
  const events = totalEvents(samples);
  const biophysicsLock = useViewLock('biophysics');
  /*
     The two spillover panels are shown together and one of them is disabled,
     rather than one being hidden.

     Which applies is a property of the loaded files, not a setting — a spectral
     instrument measures every dye across the whole array and a conventional one
     measures each in its own detector, and `detectAcquisitionType` reads which
     at import. A segment that vanished would leave the answer to *"where is
     compensation"* as an absence; disabled with the reason in its tooltip
     leaves it as a sentence. See `state/viewLock.ts`.
  */
  const unmixingLock = useViewLock('unmixing');
  const compensationLock = useViewLock('compensation');

  return (
    <AppShell
      topBarCenter={
        <SegmentedControl
          name="view"
          value={view}
          onChange={setView}
          // The one segmented control in the app that is navigation rather than
          // a setting, and the only one carrying the accent. See `tone`.
          tone="accent"
          segments={[
            { value: 'analysis', label: 'Analysis', icon: <Activity size={11} /> },
            // Parameters sits between Analysis and Unmixing because that is the
            // order the work happens in: gate the data, compute whatever the
            // panel needs computing, then unmix.
            { value: 'parameters', label: 'Parameters', icon: <Sigma size={11} /> },
            {
              value: 'unmixing',
              label: 'Unmixing',
              icon: <Waves size={11} />,
              disabled: !!unmixingLock,
              title: unmixingLock ?? undefined,
            },
            {
              value: 'compensation',
              label: 'Compensation',
              icon: <Grid3x3 size={11} />,
              disabled: !!compensationLock,
              title: compensationLock ?? undefined,
            },
            { value: 'statistics', label: 'Statistics', icon: <Table2 size={11} /> },
            { value: 'export', label: 'Export', icon: <Download size={11} /> },
            /*
               UMAP and Biophysics, after a gap, and the gap is the statement.

               The five before them are one pipeline — gate the data, compute
               what needs computing, unmix, summarise, write it out — and every
               workspace goes through them in that order. Neither of these is the
               sixth stage of that. They are analyses built on top of the same
               gates, plots and parameters, which most workspaces never open at
               all. Sixth in a flat row would read as "the step after Export",
               which is not a sentence anybody would write down.

               UMAP is the nearer of the two because it reads the pipeline's own
               output: its input is the file Export writes. See `Segment.gapBefore`.
            */
            {
              value: 'umap',
              label: 'UMAP',
              icon: <Network size={11} />,
              gapBefore: true,
            },
            /*
               And Biophysics further out still, with a gap of its own.

               It is the only view that owns a multi-step experimental protocol
               rather than answering a single question — two modes, six steps, a
               worksheet per sample and a fit. Sharing a group with UMAP would
               say the two are the same kind of thing, and they are not.
            */
            {
              value: 'biophysics',
              label: 'Biophysics',
              icon: <Atom size={11} />,
              gapBefore: true,
              /*
                 Held shut while the unmixing wizard is past Select. Opening it
                 there gates every loaded sample from a mount effect, on top of
                 the control worksheets the wizard is in the middle of building.
                 See `state/viewLock.ts` — the menu and the command palette ask
                 the same function.
              */
              disabled: !!biophysicsLock,
              title: biophysicsLock ?? undefined,
            },
          ]}
        />
      }
      topBarRight={
        <>
        {view === 'analysis' && <LayoutSwitcher />}
        {samples.length > 0 && view === 'analysis' && <AddPlotButton />}
        {samples.length > 0 && (
          <Tooltip content="Save workspace — gates, derived parameters, transforms and layout">
            <IconButton label="Save workspace" onClick={() => void saveWorkspaceToFile('MCFlow workspace')}>
              <Save size={15} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip content="Import .fcs files">
          <Button
            variant="primary"
            size="md"
            icon={<FolderPlus size={13} />}
            onClick={async () => importFiles(await platform().pickFcsFiles())}
          >
            Import
          </Button>
        </Tooltip>
        </>
      }
      sidebar={<Sidebar />}
      center={
        <>
          {/* Fixed, so it is out of flow entirely. A wrapper div here would
              make the view a child of a plain block instead of `main`'s flex
              column, and `PlotGrid`'s `flex-1` would stop stretching — the plot
              canvas collapses to content height and every mouse-driven harness
              starts missing it. */}
          <NoticeBar />
          {/* Fixed, like NoticeBar, and for the same reason: anything overlaid
              in this slot must be out of flow or `PlotGrid` stops stretching. */}
          <GateDeleteConfirm />
          <MissingFilesPrompt />
          {view === 'parameters' ? <ParametersView />
            : view === 'unmixing' ? <UnmixingView />
              : view === 'compensation' ? <UnmixingView platform="conventional" />
              : view === 'statistics' ? <StatisticsView />
                : view === 'export' ? <ExportView />
                  : view === 'umap' ? <UmapView />
                    : view === 'biophysics' ? <BiophysicsView />
                      : <AnalysisView />}
        </>
      }
      inspector={<MetadataPanel />}
      statusLeft={
        samples.length > 0 ? (
          <>
            <StatusItem icon={<Database size={11} />}>
              {samples.length} sample{samples.length === 1 ? '' : 's'} · {formatFull(events)} events
            </StatusItem>
            {spectralCount > 0 && (
              <StatusItem icon={<Waves size={11} />} tone="accent">
                {spectralCount} spectral
                {sample
                  ? ` · ${sample.parsed.metadata.parameters.filter((p) => p.type === 'Raw_Fluorescence').length} detectors`
                  : ''}
              </StatusItem>
            )}
          </>
        ) : (
          <StatusItem icon={<Database size={11} />}>No samples loaded</StatusItem>
        )
      }
      statusRight={
        <>
          {sample && activePanel && view === 'analysis' && (
            <StatusItem title="Active axis transforms">
              {activePanel.xTransform} · {activePanel.yTransform}
            </StatusItem>
          )}
          {panelCount > 1 && view === 'analysis' && (
            <StatusItem title="Plots in the current layout">{panelCount} plots</StatusItem>
          )}
          <StatusItem title="Platform capabilities">
            {platform().kind === 'electron' ? 'Desktop' : 'Browser (read-only export)'}
          </StatusItem>
          <StatusItem tone="ok">Ready</StatusItem>
          {/* Last before the zoom, so the two window-scoped controls sit
              together in the bottom-right corner. Analysis only: it moves a
              plot between worksheets, and the statistics, export, parameters
              and unmixing panels have neither. */}
          {view === 'analysis' && <MovePlotControl />}
        </>
      }
    />
  );
}

/**
 * The worksheet, plus whichever bottom strip belongs to it.
 *
 * All three ask `useBottomBar()` and render if the answer names them, so exactly
 * one can ever be on screen and it is not a question of z-order. A guided strip
 * owns the bottom only while its own generated worksheet is showing; anywhere
 * else `LayoutBar` does, provided there is more than one worksheet to be in. All
 * three are absent from a workspace with one layout and no guided panel open,
 * which is the common case and the one that must cost nothing.
 *
 * The rule lives in `core/layout/bottomBar.ts`, and the reason it is one total
 * function rather than a condition per component is recorded there.
 */
function AnalysisView() {
  return (
    <>
      <PlotGrid />
      <ControlWalkBar />
      <BiophysicsWalkBar />
      <LayoutBar />
    </>
  );
}

/**
 * Which worksheet this window is showing, and a way to open a second MCFlow.
 *
 * A workspace holds several **layouts** and a window views one of them, so a
 * gating arrangement and a statistics arrangement can be switched between while
 * both remain views onto the same gates and the same samples. That is what the
 * `+` here adds, and it is unchanged.
 *
 * The window button beside it is **not** a second view of this workspace, as of
 * 2026-08-03. It opens an independent, blank MCFlow — for a second experiment,
 * which is what people were reaching for. See `electron/windows.ts`.
 */
function LayoutSwitcher() {
  const { activeLayoutId, activeLayoutName, otherLayouts, addLayout, switchLayout, removeLayout } = usePlot();
  const layoutCount = Object.keys(otherLayouts).length + 1;
  const canOpenWindow = !!platform().newWindow;

  /*
     ## The bug this memo had, which is what broke *New layout*

     It read `allLayouts()` — a store method — with a dependency list of
     `[allLayouts, controls]`. A zustand action is created once when the store
     is, so `allLayouts` never changes identity, and `controls` only changes when
     the unmixing panel does. So this memo computed **once, at mount**, when the
     only layout in existence was the boot "Main", and then never again.

     Every visible symptom followed from that one line. Pressing *New layout*
     switched the store to a new layout correctly, and this list still held only
     `L_main` — so the `<select>` had a value matching none of its options, which
     a browser renders by displaying the first one. The control said **"Main"**
     while the worksheet showed something else. And selecting "Main" from the
     list fired no `change` event, because "Main" was already what the element
     was displaying, so the one route back was `removeLayout` — deleting a
     worksheet in order to leave it.

     It reads the state it depends on directly now. `otherLayouts` is replaced on
     every add, switch and remove, so the identity comparison that defeated this
     is the same one that now drives it.

     ## Three kinds of worksheet, said out loud

     Reference worksheets — the ones the unmixing wizard generates, one per
     control — are grouped under their own heading and ordered by the wizard's
     own walk, which is the peak-detector order its bottom tab strip uses.
     Biophysics worksheets are grouped the same way and ordered by that
     pipeline's own sample list, for the same reason. The general layouts are
     what *New layout* makes, and they come first because that is the list this
     control was built for. Before `LayoutDef.kind` existed the kinds were
     indistinguishable, so thirteen generated worksheets and one general layout
     rendered as one flat list of fourteen.
  */
  const groups = useLayoutGroups();

  return (
    <div className="flex items-center gap-1">
      {layoutCount > 1 && (
        <select
          value={activeLayoutId}
          onChange={(e) => switchLayout(e.target.value)}
          title="Which worksheet this window is showing"
          data-layout-select=""
          className="h-6 px-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] text-2xs text-[var(--text-secondary)] max-w-[150px]"
        >
          {/* Grouped only when there is something to group. A single-group
              `<optgroup>` is a heading over a list of one kind, which is noise. */}
          {groups.reference.length === 0 && groups.perSample.length === 0 && groups.cellTypes.length === 0
            ? groups.general.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)
            : (
              <>
                <optgroup label="Layouts">
                  {groups.general.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </optgroup>
                {groups.reference.length > 0 && (
                  <optgroup label="Unmixing worksheets">
                    {groups.reference.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </optgroup>
                )}
                {groups.perSample.length > 0 && (
                  <optgroup label="Biophysics — per sample">
                    {groups.perSample.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </optgroup>
                )}
                {/* Its own heading rather than the last entry under the eight
                    sample sheets. One worksheet for the whole experiment is a
                    different kind of thing to be looking at, and it used to sort
                    last only because its id is in `immuneLayoutId` and therefore
                    matched no rank — correct by accident. */}
                {groups.cellTypes.length > 0 && (
                  <optgroup label="Biophysics — all samples">
                    {groups.cellTypes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </optgroup>
                )}
              </>
            )}
        </select>
      )}
      <Tooltip content="Add another layout to this workspace">
        <IconButton label="New layout" onClick={() => addLayout()}><Columns3 size={14} /></IconButton>
      </Tooltip>
      {layoutCount > 1 && (
        <Tooltip content={`Remove the “${activeLayoutName}” layout from this workspace`}>
          <IconButton label="Remove layout" onClick={() => removeLayout(activeLayoutId)}>
            <X size={14} />
          </IconButton>
        </Tooltip>
      )}
      {canOpenWindow && (
        <Tooltip content="Open an empty second window — a separate experiment, sharing nothing with this one">
          <IconButton label="New window" onClick={() => void platform().newWindow?.()}>
            <AppWindow size={14} />
          </IconButton>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The single transient-message slot.
 *
 * Actions reached from the native menu — loading a matrix, a second instance
 * being turned away from an open workspace — have no panel of their own to
 * report into, and a result the user cannot see is a result that did not happen.
 */
function NoticeBar() {
  const notice = useUI((s) => s.notice);
  const setNotice = useUI((s) => s.setNotice);
  if (!notice) return null;

  const tone = notice.tone === 'ok' ? 'var(--status-ok)' : notice.tone === 'warn' ? 'var(--status-warn)' : 'var(--status-err)';
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 max-w-[70ch] flex items-start gap-2 px-3 py-2 rounded-[var(--radius-md)] border shadow-lg mc-panel-in"
      style={{ background: 'var(--surface-raised)', borderColor: tone, top: 'calc(var(--h-topbar) + 12px)' }}
      role="status"
    >
      <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: tone }} />
      <p className="text-xs text-[var(--text-primary)]">{notice.text}</p>
      <IconButton label="Dismiss" size="sm" onClick={() => setNotice(null)}><X size={12} /></IconButton>
    </div>
  );
}
