/**
 * Design-system reference. **Development aid — not part of the shipped app.**
 *
 * Built in Stage 1 to sign off the tokens and primitives, and kept because it
 * is still the fastest way to see every surface, tone and control at once when
 * changing `styles/tokens.css`. It was removed from the app's navigation in
 * 2026-07: it was never a user-facing feature, and shipping it invited someone
 * to find a screen that documents the software rather than doing anything with
 * their data.
 *
 * Nothing imports this file, so Vite drops it from the bundle entirely — it is
 * unreachable from the view switcher, the command palette and the native menu
 * because it is not in the build at all. It stays under `tsc`, so it cannot rot
 * silently while the primitives it documents change.
 *
 * To look at it, import `<StyleGuide />` into `App.tsx` temporarily. Do not ship
 * that import.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Braces, ChevronRight, CircleDashed, Download, FolderTree, Layers,
  Play, Plus, Sparkles, Trash2, Waves,
} from 'lucide-react';
import { Button, IconButton, Spinner } from '@/ui/Button';
import { Checkbox, Field, NumberInput, Select, Slider, Switch, TextInput } from '@/ui/Field';
import { Badge, Callout, ColorChip, EmptyState, ProgressBar, StatTile } from '@/ui/Feedback';
import { MetaRow, PanelSection } from '@/ui/Panel';
import { SegmentedControl, Tabs } from '@/ui/SegmentedControl';
import { DataTable } from '@/ui/Table';
import { InfoHint, Kbd, Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

const POP_VARS = Array.from({ length: 12 }, (_, i) => `--pop-${String(i + 1).padStart(2, '0')}`);
const RAMPS = ['rainbow', 'viridis'] as const;

/* ========================================================================== */

export function StyleGuide() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-10 space-y-14">
        <header className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Badge tone="accent">Design system</Badge>
            <Badge mono>v0.1</Badge>
          </div>
          <h1 className="text-xl font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            MCFlow style guide
          </h1>
          <p className="text-base text-[var(--text-secondary)] max-w-[62ch] leading-normal">
            Every token and primitive the application is built from. Toggle the theme in the
            top bar — both light and dark are hand-tuned ramps, not one inverted into the other.
          </p>
        </header>

        <Section title="Colour" caption="Semantic surfaces, one accent, and a separate palette reserved for data.">
          <SubHead>Surfaces &amp; borders</SubHead>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              ['sunken', '--surface-sunken'], ['base', '--surface-base'],
              ['raised', '--surface-raised'], ['overlay', '--surface-overlay'],
              ['input', '--surface-input'], ['plot', '--surface-plot'],
            ].map(([name, v]) => (
              <Swatch key={v} name={name!} varName={v!} bordered />
            ))}
          </div>

          <SubHead>Accent &amp; status</SubHead>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <Swatch name="accent" varName="--accent-500" />
            <Swatch name="ok" varName="--status-ok" />
            <Swatch name="warn" varName="--status-warn" />
            <Swatch name="error" varName="--status-err" />
            <Swatch name="info" varName="--status-info" />
          </div>

          <SubHead>
            Population palette
            <InfoHint content="Reserved exclusively for gates and populations so data colour is never confused with UI chrome. The first eight hues stay separable under deuteranopia and protanopia." />
          </SubHead>
          <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
            {POP_VARS.map((v, i) => (
              <div key={v} className="space-y-1">
                <div
                  className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]"
                  style={{ background: `var(${v})` }}
                />
                <p className="text-[10px] font-mono text-[var(--text-disabled)] text-center">
                  {String(i + 1).padStart(2, '0')}
                </p>
              </div>
            ))}
          </div>

          <SubHead>
            Density ramps
            <InfoHint content="Rainbow is the default: a spectral ramp, deliberately not monotonic in lightness, chosen because it separates more populations by hue across the middle of the range. Viridis is perceptually uniform and is the right choice when the reading is quantitative." />
          </SubHead>
          <div className="space-y-2">
            {RAMPS.map((r) => (
              <div key={r} className="flex items-center gap-3">
                <span className="text-xs text-[var(--text-tertiary)] w-16 shrink-0 capitalize">{r}</span>
                <div
                  className="h-6 flex-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]"
                  style={{
                    background: `linear-gradient(to right, ${Array.from({ length: 7 }, (_, i) => `var(--ramp-${r}-${i})`).join(',')})`,
                  }}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Typography" caption="Inter for UI, JetBrains Mono for every number that sits in a column.">
          <div className="space-y-3.5">
            {([
              ['2xl', 'Hero numerals', 'var(--text-2xl)'],
              ['xl', 'Screen titles', 'var(--text-xl)'],
              ['lg', 'Panel titles', 'var(--text-lg)'],
              ['md', 'Section headings', 'var(--text-md)'],
              ['base', 'Body copy and panel content', 'var(--text-base)'],
              ['sm', 'Default UI size', 'var(--text-sm)'],
              ['xs', 'Secondary labels', 'var(--text-xs)'],
              ['2xs', 'Dense meta and axis ticks', 'var(--text-2xs)'],
            ] as const).map(([k, label, size]) => (
              <div key={k} className="flex items-baseline gap-5">
                <code className="text-2xs font-mono text-[var(--text-disabled)] w-12 shrink-0">{k}</code>
                <span
                  style={{ fontSize: size }}
                  className="text-[var(--text-primary)] tracking-[var(--tracking-snug)] truncate"
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-6 p-3.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
            <p className="eyebrow mb-2">Tabular numerals</p>
            <div className="font-mono tnum text-sm text-[var(--text-primary)] leading-relaxed">
              <div>  1 038 421   98.4 %   12 704.55</div>
              <div>     11 903    7.11 %      309.08</div>
              <div>        842    0.06 %  1 004 771.2</div>
            </div>
            <p className="text-2xs text-[var(--text-tertiary)] mt-2">
              Digits share one advance width, so decimal points and magnitudes line up down a column.
            </p>
          </div>
        </Section>

        <Section title="Spacing &amp; radius" caption="A strict 4px grid. Radii stay small — no pill buttons, no 16px cards.">
          <div className="flex flex-wrap items-end gap-4">
            {([1, 2, 3, 4, 5, 6, 8, 10, 12, 16] as const).map((s) => (
              <div key={s} className="flex flex-col items-center gap-1.5">
                <div
                  className="bg-[var(--accent-500)]/30 border-t-2 border-[var(--accent-500)]"
                  style={{ width: `var(--space-${s})`, height: `var(--space-${s})` }}
                />
                <code className="text-[10px] font-mono text-[var(--text-disabled)]">{s * 4}</code>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-4 mt-6">
            {(['xs', 'sm', 'md', 'lg'] as const).map((r) => (
              <div key={r} className="flex flex-col items-center gap-1.5">
                <div
                  className="h-11 w-11 bg-[var(--surface-raised)] border border-[var(--border-strong)]"
                  style={{ borderRadius: `var(--radius-${r})` }}
                />
                <code className="text-[10px] font-mono text-[var(--text-disabled)]">{r}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons" caption="One filled accent surface per view, so the primary action is never ambiguous.">
          <div className="space-y-4">
            <Row label="Variants">
              <Button variant="primary" icon={<Play size={13} />}>Run unmixing</Button>
              <Button variant="secondary" icon={<Plus size={13} />}>Add gate</Button>
              <Button variant="subtle">Subtle</Button>
              <Button variant="ghost" icon={<Layers size={13} />}>Ghost</Button>
              <Button variant="danger" icon={<Trash2 size={13} />}>Remove</Button>
            </Row>
            <Row label="Sizes">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg" variant="primary">Large</Button>
            </Row>
            <Row label="States">
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
              <Button variant="primary" disabled>Disabled</Button>
            </Row>
            <Row label="Icon only">
              <IconButton label="Add"><Plus size={15} /></IconButton>
              <IconButton label="Layers" active><Layers size={15} /></IconButton>
              <IconButton label="Export" variant="secondary"><Download size={15} /></IconButton>
              <span className="inline-flex items-center gap-2 text-2xs text-[var(--text-tertiary)] ml-2">
                <Spinner size={13} /> inline spinner
              </span>
            </Row>
          </div>
        </Section>

        <Section title="Controls" caption="Everything sits on one 28px control height so dense property panels stay aligned.">
          <ControlsDemo />
        </Section>

        <Section title="Navigation" caption="Segments for modes, tabs for views.">
          <NavDemo />
        </Section>

        <Section title="Data display" caption="Statistics tables, population chips, and headline numerals.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
            <StatTile label="Events" value="15 333" />
            <StatTile label="Parameters" value="71" />
            <StatTile label="Detectors" value="64" tone="accent" />
            <StatTile label="Acq. time" value="24.5" unit="s" />
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden bg-[var(--surface-base)]">
            <DataTable
              rows={DEMO_STATS}
              rowKey={(r) => r.pop}
              columns={[
                {
                  key: 'pop', header: 'Population', width: '38%',
                  sortValue: (r) => r.pop,
                  cell: (r) => (
                    <span className="flex items-center gap-2 min-w-0" style={{ paddingLeft: r.depth * 12 }}>
                      <ColorChip color={`var(--pop-${r.color})`} />
                      <span className="truncate text-[var(--text-primary)]">{r.pop}</span>
                    </span>
                  ),
                },
                { key: 'count', header: 'Count', numeric: true, sortValue: (r) => r.count, cell: (r) => r.count.toLocaleString() },
                { key: 'parent', header: '% Parent', numeric: true, sortValue: (r) => r.parent, cell: (r) => r.parent.toFixed(2) },
                { key: 'total', header: '% Total', numeric: true, sortValue: (r) => r.total, cell: (r) => r.total.toFixed(2) },
                { key: 'mfi', header: 'Median FITC', numeric: true, sortValue: (r) => r.mfi, cell: (r) => r.mfi.toLocaleString() },
              ]}
            />
          </div>
        </Section>

        <Section title="Plot chrome" caption="Axes, ticks, and gate outlines are drawn to publication standard — this is what exports look like.">
          <PlotChromeDemo />
        </Section>

        <Section title="Gating tree" caption="Hierarchy, live counts, and population colour in one column.">
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1.5 max-w-[440px]">
            <GateTreeDemo />
          </div>
        </Section>

        <Section title="Feedback" caption="Badges, callouts, and progress.">
          <div className="space-y-4">
            <Row label="Badges">
              <Badge>Neutral</Badge>
              <Badge tone="accent">Spectral</Badge>
              <Badge tone="ok">Unmixed</Badge>
              <Badge tone="warn">No controls</Badge>
              <Badge tone="err">Parse failed</Badge>
              <Badge tone="info" mono>64 ch</Badge>
            </Row>
            <div className="grid sm:grid-cols-2 gap-2.5">
              <Callout tone="accent" title="Spectral acquisition detected">
                71 parameters across 64 narrow detectors. Routed to the unmixing workflow.
              </Callout>
              <Callout tone="warn" title="No reference controls assigned">
                Unmixing needs one single-stain control per fluorophore plus an unstained control.
              </Callout>
            </div>
            <div className="max-w-[380px] space-y-3 pt-1">
              <ProgressBar value={0.62} label="Exporting populations" detail="52 / 84 files" />
              <ProgressBar value={1} label="Parsing samples" detail="6 / 6" />
            </div>
          </div>
        </Section>

        <Section title="Empty states" caption="Every reachable dead end is designed, never bare text.">
          <div className="grid sm:grid-cols-2 gap-2.5">
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--surface-base)]">
              <EmptyState
                icon={<FolderTree size={19} />}
                title="No samples loaded"
                description="Drop .fcs files here, or import a folder to begin an analysis."
                action={<Button variant="primary" size="md" icon={<Plus size={13} />}>Import files</Button>}
              />
            </div>
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--surface-base)]">
              <EmptyState
                icon={<CircleDashed size={19} />}
                title="Gate contains no events"
                description="CD4+ resolves to 0 of 15 333 events. Check the parent gate or the axis transform."
                action={<Button size="md" variant="secondary">Edit gate</Button>}
              />
            </div>
          </div>
        </Section>

        <Section title="Overlays" caption="Tooltips are portalled and flip-aware; ⓘ marks anything whose label isn't self-explanatory.">
          <div className="flex flex-wrap items-center gap-6">
            <Tooltip content="Plain label tooltip"><Button variant="secondary">Hover me</Button></Tooltip>
            <Tooltip
              rich
              side="right"
              content={
                <>
                  <strong className="text-[var(--text-primary)]">Combined long-format CSV</strong>
                  <br />
                  One file with <code className="font-mono">sample_id</code>,{' '}
                  <code className="font-mono">population</code> and{' '}
                  <code className="font-mono">population_path</code> columns. Best for R, pandas,
                  or anything that expects tidy data.
                </>
              }
            >
              <Button variant="secondary" icon={<Braces size={13} />}>Rich tooltip</Button>
            </Tooltip>
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              Autofluorescence extraction
              <InfoHint content="Treats cellular autofluorescence as one of the reference signatures in the unmixing matrix rather than subtracting it as background. On spectral platforms this materially improves resolution of dim populations." />
            </span>
            <span className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
              Shortcut <Kbd>⌘</Kbd><Kbd>K</Kbd>
            </span>
          </div>
        </Section>

        <Section title="Motion" caption="Short, eased, and only where it communicates a state change.">
          <MotionDemo />
        </Section>

        <div className="h-8" />
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Section scaffolding                                                        */
/* ========================================================================== */

function Section({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <section className="space-y-5">
      <div className="space-y-1 pb-3 hairline-b">
        <h2 className="text-md font-semibold tracking-[var(--tracking-snug)] text-[var(--text-primary)]">{title}</h2>
        {caption && <p className="text-xs text-[var(--text-tertiary)] max-w-[70ch]">{caption}</p>}
      </div>
      {children}
    </section>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <p className="eyebrow flex items-center gap-1.5 pt-1">{children}</p>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-2xs text-[var(--text-disabled)] w-[72px] shrink-0">{label}</span>
      {children}
    </div>
  );
}

function Swatch({ name, varName, bordered }: { name: string; varName: string; bordered?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div
        className={cn('h-12 rounded-[var(--radius-sm)]', bordered && 'border border-[var(--border-default)]')}
        style={{ background: `var(${varName})` }}
      />
      <div className="space-y-0.5">
        <p className="text-2xs text-[var(--text-secondary)]">{name}</p>
        <p className="text-[10px] font-mono text-[var(--text-disabled)] truncate">{varName}</p>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Interactive demos                                                          */
/* ========================================================================== */

function ControlsDemo() {
  const [text, setText] = useState('Sample B Pro12A1');
  const [num, setNum] = useState(1000);
  const [sel, setSel] = useState('logicle');
  const [check, setCheck] = useState(true);
  const [mixed, setMixed] = useState(false);
  const [sw, setSw] = useState(true);
  const [slide, setSlide] = useState(4.5);

  return (
    <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4 max-w-[720px]">
      <Field label="Sample name">
        <TextInput value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="Transform">
        <Select value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="linear">Linear</option>
          <option value="log">Logarithmic</option>
          <option value="biex">Biexponential</option>
          <option value="logicle">Logicle</option>
          <option value="hyperlog">Hyperlog</option>
          <option value="asinh">Arcsinh</option>
        </Select>
      </Field>
      <Field label="Cofactor" hint="Arcsinh scaling. Lower values expand the region near zero.">
        <NumberInput value={num} onChange={(e) => setNum(Number(e.target.value))} />
      </Field>
      <Field label="Width basis (W)" hint={`Currently ${slide.toFixed(1)} decades`}>
        <div className="flex items-center gap-3 h-[var(--h-control)]">
          <Slider value={slide} min={0} max={10} step={0.1} onChange={setSlide} />
          <span className="font-mono tnum text-2xs text-[var(--text-tertiary)] w-8 text-right shrink-0">
            {slide.toFixed(1)}
          </span>
        </div>
      </Field>
      <Field label="Invalid input" error="Cofactor must be greater than zero.">
        <NumberInput value={0} onChange={() => {}} invalid />
      </Field>
      <Field label="With unit">
        <TextInput value="4 194 304" onChange={() => {}} mono suffix="a.u." />
      </Field>
      {/* Checkbox and Switch are inline-flex by design (they can sit mid-sentence),
          so a stacked demo has to establish the column itself. */}
      <div className="flex flex-col items-start gap-2.5">
        <p className="eyebrow">Checkbox</p>
        <Checkbox checked={check} onChange={setCheck} label="Apply compensation" />
        <Checkbox checked={mixed} indeterminate={!mixed} onChange={setMixed} label="Include raw detectors" />
        <Checkbox checked={false} onChange={() => {}} label="Disabled option" disabled />
      </div>
      <div className="flex flex-col items-start gap-2.5">
        <p className="eyebrow">Switch</p>
        <Switch checked={sw} onChange={setSw} label="Extract autofluorescence" />
        <Switch checked={!sw} onChange={() => setSw(!sw)} label="Show dimmed events" size="sm" />
      </div>
      <div className="sm:col-span-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-base)] overflow-hidden">
        <PanelSection title="Inspector section" dense>
          <MetaRow label="Cytometer" value="Aurora" mono={false} />
          <MetaRow label="Serial" value="SN0001" />
          <MetaRow label="Acquired" value="2025-07-28 15:35" />
          <MetaRow label="Events" value="15 333" />
        </PanelSection>
        <PanelSection title="Collapsed by default" defaultOpen={false} dense>
          <MetaRow label="Hidden" value="—" />
        </PanelSection>
      </div>
    </div>
  );
}

function NavDemo() {
  const [seg, setSeg] = useState<'scatter' | 'density' | 'hist' | 'spectrum'>('density');
  const [mode, setMode] = useState<'raw' | 'unmixed'>('unmixed');
  const [tab, setTab] = useState<'samples' | 'gates' | 'stats'>('gates');
  return (
    <div className="space-y-5 max-w-[640px]">
      <Row label="Segments">
        <SegmentedControl
          value={seg}
          onChange={setSeg}
          segments={[
            { value: 'scatter', label: 'Scatter' },
            { value: 'density', label: 'Density' },
            { value: 'hist', label: 'Histogram' },
            { value: 'spectrum', label: 'Spectrum', icon: <Waves size={11} /> },
          ]}
        />
      </Row>
      <Row label="Two-up">
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={setMode}
          segments={[
            { value: 'raw', label: 'Raw detectors' },
            { value: 'unmixed', label: 'Unmixed' },
          ]}
        />
      </Row>
      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-base)] overflow-hidden">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'samples', label: 'Samples', badge: <Badge mono>6</Badge> },
            { value: 'gates', label: 'Gates', badge: <Badge mono>14</Badge> },
            { value: 'stats', label: 'Statistics' },
          ]}
        />
        <div className="p-4 text-xs text-[var(--text-tertiary)]">Panel body for “{tab}”.</div>
      </div>
    </div>
  );
}

function MotionDemo() {
  const [on, setOn] = useState(true);
  return (
    <div className="space-y-3">
      <Button variant="secondary" size="md" onClick={() => setOn((o) => !o)} icon={<Sparkles size={13} />}>
        Replay
      </Button>
      {on && (
        <div key={String(on)} className="grid sm:grid-cols-3 gap-2.5">
          <div className="anim-fade p-3.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
            <p className="text-xs font-medium text-[var(--text-primary)]">Fade</p>
            <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">Content swaps inside a panel.</p>
          </div>
          <div className="anim-rise p-3.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
            <p className="text-xs font-medium text-[var(--text-primary)]">Rise</p>
            <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">A row enters a list.</p>
          </div>
          <div className="anim-scale p-3.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
            <p className="text-xs font-medium text-[var(--text-primary)]">Scale</p>
            <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">A menu or tooltip appears.</p>
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 pt-1">
        <div className="skeleton h-3 w-32" />
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-3 w-44" />
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Plot chrome — the visual contract for every rendered figure                 */
/* ========================================================================== */

function PlotChromeDemo() {
  const W = 460, H = 300, M = { l: 48, r: 12, t: 12, b: 38 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const decades = [2, 3, 4, 5, 6];

  // A deterministic pseudo-cloud so the demo is stable across renders.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < 1400; i++) {
    const cluster = rnd();
    const [cx, cy, s] = cluster < 0.55 ? [0.35, 0.32, 0.10] : cluster < 0.85 ? [0.66, 0.62, 0.08] : [0.5, 0.85, 0.06];
    const g = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2;
    pts.push([cx + g() * s, cy + g() * s, cluster]);
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-plot)] p-3 inline-block">
      <svg width={W} height={H} className="block" shapeRendering="geometricPrecision">
        {/* gridlines — subtle, only at decade boundaries */}
        {decades.map((d, i) => {
          const x = M.l + (i / (decades.length - 1)) * pw;
          const y = M.t + ph - (i / (decades.length - 1)) * ph;
          return (
            <g key={d}>
              <line x1={x} y1={M.t} x2={x} y2={M.t + ph} stroke="var(--plot-grid)" strokeWidth="1" />
              <line x1={M.l} y1={y} x2={M.l + pw} y2={y} stroke="var(--plot-grid)" strokeWidth="1" />
            </g>
          );
        })}

        {/* events */}
        <g>
          {pts.map(([x, y, c], i) => (
            <circle
              key={i}
              cx={M.l + x * pw}
              cy={M.t + ph - y * ph}
              r="1.15"
              fill={c < 0.55 ? 'var(--pop-01)' : c < 0.85 ? 'var(--pop-03)' : 'var(--plot-dimmed-event)'}
              fillOpacity={c < 0.85 ? 0.62 : 1}
            />
          ))}
        </g>

        {/* a polygon gate with vertex handles */}
        <polygon
          points={`${M.l + 0.52 * pw},${M.t + ph - 0.5 * ph} ${M.l + 0.8 * pw},${M.t + ph - 0.53 * ph} ${M.l + 0.84 * pw},${M.t + ph - 0.74 * ph} ${M.l + 0.6 * pw},${M.t + ph - 0.79 * ph} ${M.l + 0.5 * pw},${M.t + ph - 0.66 * ph}`}
          fill="var(--pop-03)"
          fillOpacity="0.07"
          stroke="var(--pop-03)"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        {[[0.52, 0.5], [0.8, 0.53], [0.84, 0.74], [0.6, 0.79], [0.5, 0.66]].map(([x, y], i) => (
          <rect
            key={i}
            x={M.l + x! * pw - 2.5}
            y={M.t + ph - y! * ph - 2.5}
            width="5" height="5"
            fill="var(--surface-plot)" stroke="var(--pop-03)" strokeWidth="1.25"
          />
        ))}
        <text
          x={M.l + 0.67 * pw} y={M.t + ph - 0.84 * ph}
          textAnchor="middle" fontSize="10" fontWeight="500"
          fill="var(--pop-03)" fontFamily="var(--font-ui)"
        >
          CD3+  22.4%
        </text>

        {/* axes */}
        <line x1={M.l} y1={M.t + ph} x2={M.l + pw} y2={M.t + ph} stroke="var(--plot-axis)" strokeWidth="1" />
        <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + ph} stroke="var(--plot-axis)" strokeWidth="1" />

        {decades.map((d, i) => {
          const x = M.l + (i / (decades.length - 1)) * pw;
          const y = M.t + ph - (i / (decades.length - 1)) * ph;
          return (
            <g key={d} fontFamily="var(--font-mono)" fontSize="9" fill="var(--plot-label)">
              <line x1={x} y1={M.t + ph} x2={x} y2={M.t + ph + 4} stroke="var(--plot-tick)" strokeWidth="1" />
              <text x={x} y={M.t + ph + 14} textAnchor="middle">10{sup(d)}</text>
              <line x1={M.l - 4} y1={y} x2={M.l} y2={y} stroke="var(--plot-tick)" strokeWidth="1" />
              <text x={M.l - 7} y={y + 3} textAnchor="end">10{sup(d)}</text>
            </g>
          );
        })}

        <text
          x={M.l + pw / 2} y={H - 4} textAnchor="middle"
          fontSize="10.5" fill="var(--plot-label)" fontFamily="var(--font-ui)"
        >
          CD3 BV421 :: V1-A
        </text>
        <text
          x={11} y={M.t + ph / 2} textAnchor="middle"
          transform={`rotate(-90 11 ${M.t + ph / 2})`}
          fontSize="10.5" fill="var(--plot-label)" fontFamily="var(--font-ui)"
        >
          CD4 FITC :: B2-A
        </text>
      </svg>
      <div className="flex items-center gap-3 px-1 pt-2 hairline-t mt-1">
        <span className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
          <ColorChip color="var(--pop-01)" /> Lymphocytes
        </span>
        <span className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
          <ColorChip color="var(--pop-03)" /> CD3+
        </span>
        <span className="ml-auto text-2xs font-mono text-[var(--text-disabled)]">logicle · logicle</span>
      </div>
    </div>
  );
}

function sup(n: number) {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  return String(n).split('').map((c) => map[c] ?? c).join('');
}

/* ========================================================================== */
/* Gating tree                                                                */
/* ========================================================================== */

const DEMO_STATS = [
  { pop: 'All events', count: 15333, parent: 100, total: 100, mfi: 1204, color: '01', depth: 0 },
  { pop: 'Cells', count: 13981, parent: 91.18, total: 91.18, mfi: 1310, color: '02', depth: 1 },
  { pop: 'Single cells', count: 13102, parent: 93.71, total: 85.45, mfi: 1288, color: '03', depth: 2 },
  { pop: 'Live', count: 11744, parent: 89.63, total: 76.59, mfi: 1422, color: '04', depth: 3 },
  { pop: 'CD3+', count: 3438, parent: 29.27, total: 22.42, mfi: 9871, color: '05', depth: 4 },
  { pop: 'CD4+', count: 2071, parent: 60.24, total: 13.51, mfi: 21044, color: '06', depth: 5 },
  { pop: 'CD8+', count: 1194, parent: 34.73, total: 7.79, mfi: 18320, color: '07', depth: 5 },
];

function GateTreeDemo() {
  const [sel, setSel] = useState('CD4+');
  return (
    <div className="space-y-px">
      {DEMO_STATS.map((n) => {
        const active = n.pop === sel;
        return (
          <button
            key={n.pop}
            onClick={() => setSel(n.pop)}
            style={{ paddingLeft: 6 + n.depth * 13 }}
            className={cn(
              'group flex items-center gap-1.5 w-full h-[var(--h-row)] pr-2 rounded-[var(--radius-xs)] text-left',
              'transition-colors duration-[var(--dur-instant)]',
              active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
            )}
          >
            <ChevronRight
              size={11}
              className={cn(
                'shrink-0 text-[var(--text-disabled)] transition-transform duration-[var(--dur-fast)]',
                n.depth < 5 ? 'rotate-90' : 'opacity-0',
              )}
            />
            <ColorChip color={`var(--pop-${n.color})`} />
            <span className={cn('text-xs truncate', active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]')}>
              {n.pop}
            </span>
            <span className="ml-auto flex items-baseline gap-2.5 shrink-0 font-mono tnum text-2xs">
              <span className="text-[var(--text-disabled)]">{n.count.toLocaleString()}</span>
              <span className={cn('w-11 text-right', active ? 'text-[var(--text-accent)]' : 'text-[var(--text-tertiary)]')}>
                {n.parent.toFixed(2)}%
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
