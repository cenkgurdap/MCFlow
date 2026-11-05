import { useMemo, useState } from 'react';
import { FileQuestion, Search, SlidersHorizontal } from 'lucide-react';
import { acquisitionTypeOf, selectedSample, useWorkspace } from '@/state/workspaceStore';
import type { FcsWarning } from '@/core/fcs/types';
import { TextInput } from '@/ui/Field';
import { Field } from '@/ui/Field';
import { Badge, Callout, EmptyState, StatTile } from '@/ui/Feedback';
import { MetaRow, Panel, PanelHeader, PanelSection } from '@/ui/Panel';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint } from '@/ui/Tooltip';
import { formatFull } from './SampleBrowser';
import { AxisSettings } from './AxisSettings';
import { parametersFor, useDerived } from '@/state/derivedStore';
import { unmixedCount } from '@/core/unmixedColumns';
import { useSpectral } from '@/state/spectralStore';
import { cn } from '@/ui/cn';

const WARNING_TONE: Record<FcsWarning['code'], 'warn' | 'info' | 'err'> = {
  'header-offset-mismatch': 'warn',
  'data-size-mismatch': 'err',
  'missing-spillover': 'info',
  'identity-spillover': 'info',
  'non-finite-values': 'err',
  'multiple-datasets': 'warn',
  'deprecated-mode': 'warn',
  'unusual-parameter-count': 'warn',
  'missing-time-channel': 'warn',
  'supplemental-text': 'info',
};

export function MetadataPanel() {
  const sample = useWorkspace(selectedSample);
  const setAcquisitionOverride = useWorkspace((s) => s.setAcquisitionOverride);
  const [paramQuery, setParamQuery] = useState('');

  const md = sample?.parsed.metadata;
  const derivedDefs = useDerived((d) => d.defs);
  const derivedCount = derivedDefs.length;

  // The signal that a matrix has been applied — see `PlotCanvas`.
  const unmixedResults = useSpectral((s) => s.unmixed);

  const params = useMemo(() => {
    if (!sample || !md) return [];
    // Real detectors, derived parameters and unmixed abundances in one list.
    // Once they exist they are the same kind of thing to every consumer — an
    // axis, a gate, a statistic — so listing them separately would teach a
    // distinction the rest of the app goes out of its way not to make. The
    // `type` column already says which is which.
    const all = parametersFor(sample.parsed, derivedDefs);
    const q = paramQuery.trim().toLowerCase();
    return q
      ? all.filter((p) => p.name.toLowerCase().includes(q) || p.stain.toLowerCase().includes(q))
      : all;
  }, [sample, md, derivedDefs, paramQuery, unmixedResults]);

  if (!sample || !md) {
    return (
      <Panel surface="sunken" className="h-full">
        <PanelHeader title="Inspector" icon={<SlidersHorizontal size={12} />} />
        <EmptyState
          className="mt-8"
          icon={<FileQuestion size={19} />}
          title="No sample selected"
          description="Import an .fcs file and select it to inspect its parameters and acquisition metadata, and to configure a plot's axes."
        />
      </Panel>
    );
  }

  const acq = acquisitionTypeOf(sample);
  // Spillover warnings are shown in the Compensation section, where they have
  // the matrix next to them; repeating them here reads as two separate problems.
  const fileNotes = sample.parsed.warnings.filter(
    (w) => w.code !== 'identity-spillover' && w.code !== 'missing-spillover',
  );
  const durationSec =
    md.timestep && md.parameters[0]?.type === 'Time'
      ? maxOf(sample.parsed.data.subarray(0, md.eventCount)) * md.timestep
      : null;

  return (
    <Panel surface="sunken" className="h-full">
      {/* Named in the header because the inspector follows the sample list's
          selection, not the plot on screen — and a file name that differed from
          the plot beside it read as the two having fallen out of step. */}
      <PanelHeader
        title={
          <span className="flex items-baseline gap-1.5 min-w-0" title="Follows the selection in Samples">
            Inspector
            <span data-inspector-sample="" className="text-[var(--text-tertiary)] font-normal truncate">{sample.name}</span>
          </span>
        }
        icon={<SlidersHorizontal size={12} />}
      />
      <div className="flex-1 overflow-y-auto">
        <PanelSection title="Sample">
          <div className="grid grid-cols-2 gap-1.5">
            <StatTile label="Events" value={formatFull(md.eventCount)} />
            {/* What the sample *has*, not what its file declared, so this tile
                and the Parameters section below it stop giving two answers to
                one word. The file's own count moves into the unit line whenever
                the two differ, because it is still a fact about the file and a
                71-parameter Aurora acquisition is a thing somebody checks. */}
            <StatTile
              label="Parameters"
              value={md.parameterCount + derivedCount + unmixedCount(sample.parsed)}
              unit={derivedCount + unmixedCount(sample.parsed) > 0 ? `${md.parameterCount} in the file` : undefined}
            />
          </div>
          <div className="space-y-0.5 pt-1">
            <MetaRow label="File" value={sample.fileName} mono={false} title={sample.filePath ?? sample.fileName} />
            <MetaRow label="Cytometer" value={md.cytometer ?? '—'} mono={false} />
            <MetaRow label="Serial" value={md.cytometerSerial ?? '—'} />
            <MetaRow label="Software" value={md.software ?? '—'} mono={false} />
            <MetaRow label="Operator" value={md.operator ?? '—'} mono={false} />
            <MetaRow
              label="Acquired"
              value={md.acquiredAt ? md.acquiredAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
            />
            {durationSec !== null && <MetaRow label="Duration" value={`${durationSec.toFixed(1)} s`} />}
            {md.volume !== null && <MetaRow label="Volume" value={`${md.volume} µL`} />}
          </div>
          <div className="flex flex-wrap gap-1 pt-1.5">
            <Badge tone={acq === 'spectral' ? 'accent' : 'neutral'}>
              {acq === 'spectral' ? 'Spectral' : 'Conventional'}
            </Badge>
            <Badge mono>{md.version}</Badge>
            <Badge mono>{md.dataType === 'F' ? 'float32' : md.dataType === 'D' ? 'float64' : md.dataType === 'I' ? 'integer' : 'ascii'}</Badge>
            <Badge mono>{md.byteOrder === 'little' ? 'LE' : 'BE'}</Badge>
          </div>
        </PanelSection>

        <PanelSection title="Acquisition type">
          <Callout tone={acq === 'spectral' ? 'accent' : 'neutral'}>{sample.detection.reason}.</Callout>
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                Treat as
                <InfoHint content="Auto-detection counts narrow detector channels. Override it if a file was mis-classified — this decides whether the sample routes to spectral unmixing or conventional compensation." />
              </span>
            }
          >
            <SegmentedControl
              fullWidth
              size="sm"
              value={acq}
              onChange={(v) => setAcquisitionOverride(sample.id, v === sample.detection.type ? null : v)}
              segments={[
                { value: 'conventional', label: 'Conventional' },
                { value: 'spectral', label: 'Spectral' },
              ]}
            />
          </Field>
          {sample.acquisitionOverride && (
            <p className="text-2xs text-[var(--status-warn)]">
              Manually overridden — auto-detection said {sample.detection.type}.
            </p>
          )}
        </PanelSection>

        {fileNotes.length > 0 && (
          <PanelSection title={`File notes (${fileNotes.length})`} defaultOpen>
            {fileNotes.map((w, i) => (
              <Callout key={`${w.code}-${i}`} tone={WARNING_TONE[w.code]}>
                {w.message}
                {w.detail && <span className="block text-[var(--text-tertiary)] mt-1">{w.detail}</span>}
              </Callout>
            ))}
          </PanelSection>
        )}

        {/* Read-only, and deliberately titled after the keyword rather than
            after a feature: `$SPILLOVER` says something true about how the file
            was acquired whether or not anything acts on it. Since 2026-08-27
            something does — the Compensation panel reads exactly this matrix —
            so the callout says which panel, rather than saying the matrix is
            metadata and nothing else. */}
        <PanelSection title="Spillover ($SPILLOVER)" defaultOpen={false}>
          {md.spillover ? (
            <>
              <MetaRow label="Matrix" value={`${md.spillover.size} × ${md.spillover.size}`} />
              <MetaRow label="Applied at acq." value={md.compensationApplied ? 'Yes' : 'No'} mono={false} />
              <Callout tone="info">
                {md.spillover.isIdentity
                  ? 'This matrix is the identity — the acquisition software had nothing to correct, which is what a spectral instrument writes. Spillover is resolved here by unmixing.'
                  : 'The Compensation panel reads this matrix — From this file applies it without a setup.'}
              </Callout>
            </>
          ) : (
            <Callout tone="info">No spillover matrix is embedded in this file.</Callout>
          )}
        </PanelSection>

        <PanelSection title={`Parameters (${md.parameterCount + derivedCount + unmixedCount(sample.parsed)})`} defaultOpen={false}>
          {/* Real detectors and computed parameters in one list, because once
              defined they are the same kind of thing to every consumer: an axis,
              a gate, a statistic. Read-only here — defining them is what the
              Parameters section is for, and an editor in two places is two
              editors that drift. */}
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)] pointer-events-none" />
            <TextInput
              value={paramQuery}
              onChange={(e) => setParamQuery(e.target.value)}
              placeholder="Filter parameters…"
              className="pl-6 h-6 text-2xs"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto -mx-0.5">
            {params.map((p) => (
              <div
                key={p.index}
                className="flex items-baseline gap-2 h-[22px] px-1 rounded-[var(--radius-xs)] hover:bg-[var(--surface-hover)]"
              >
                <span className="font-mono tnum text-[10px] text-[var(--text-disabled)] w-6 shrink-0 text-right">
                  {p.index}
                </span>
                <span className="font-mono text-2xs text-[var(--text-primary)] truncate flex-1 min-w-0" title={p.stain || undefined}>
                  {p.name}
                </span>
                {p.stain && <span className="text-2xs text-[var(--text-tertiary)] truncate">{p.stain}</span>}
                <span
                  className={cn(
                    'text-[9px] font-mono shrink-0',
                    p.type === 'Raw_Fluorescence' ? 'text-[var(--text-accent)] opacity-60'
                      : p.type === 'Time' ? 'text-[var(--text-disabled)]'
                        : 'text-[var(--text-tertiary)]',
                  )}
                >
                  {SHORT_TYPE[p.type]}
                </span>
              </div>
            ))}
            {params.length === 0 && (
              <p className="text-2xs text-[var(--text-tertiary)] px-1 py-2">No parameter matches “{paramQuery}”.</p>
            )}
          </div>
        </PanelSection>

        {/* Where the raw keyword dump used to be.
            That list was reference material — read twice a session, never while
            analysing — occupying the bottom of the most-used column in the
            window. This is the opposite: the axis settings are edited
            constantly, and with pan and zoom gone the range fields here are the
            only way to frame an axis on purpose. The keywords are not lost;
            they are one right-click away, on the sample they describe. */}
        <PanelSection title="Axes" defaultOpen>
          <AxisSettings />
        </PanelSection>
      </div>
    </Panel>
  );
}

const SHORT_TYPE: Record<string, string> = {
  Time: 'time',
  Forward_Scatter: 'FSC',
  Side_Scatter: 'SSC',
  Raw_Fluorescence: 'raw',
  Unmixed_Fluorescence: 'unmix',
  Compensated_Fluorescence: 'comp',
  Derived: 'calc',
  Other: '—',
};

function maxOf(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}
