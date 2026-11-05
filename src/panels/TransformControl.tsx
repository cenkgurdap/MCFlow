import { useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import {
  autoSpec, IMPLEMENTED_TRANSFORMS, TRANSFORM_LABELS,
  type TransformKind, type TransformSpec,
} from '@/core/transform';
import type { TransformOverrides } from '@/state/plotStore';
import { Field, NumberInput, Slider } from '@/ui/Field';
import { Popover } from '@/ui/Popover';
import { InfoHint } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

const DESCRIPTION: Record<TransformKind, string> = {
  linear: 'Equal spacing per unit. Right for scatter and time.',
  log: 'Decades of equal width. Cannot represent zero or negatives — they stack on the axis floor.',
  biexponential: 'FlowJo-style. Linear near zero, logarithmic beyond, with the width set by a data value.',
  logicle: 'Log-like above the noise, linear through zero. The default for fluorescence.',
  hyperlog: 'Like logicle but with a linear term instead of a second exponential.',
  arcsinh: '',
  asinh: 'inverse hyperbolic sine. Simple and symmetric; standard for mass cytometry.',
} as Record<TransformKind, string>;

/**
 * Transform picker plus its parameters, opened from the axis.
 *
 * Kept on the plot rather than in a settings dialog, and editing any parameter
 * updates the plot live — width basis in particular is only meaningful when you
 * can see what it does to the negative population.
 */
export function TransformControl({
  transform, overrides, resolved, onTransform, onOverride, onReset,
}: {
  transform: TransformKind;
  overrides: TransformOverrides;
  /** The spec actually in use, after data-derived defaults and overrides. */
  resolved: TransformSpec;
  onTransform: (k: TransformKind) => void;
  onOverride: (key: keyof TransformOverrides, value: number | undefined) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const dirty = Object.keys(overrides).length > 0;

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        title={`Axis scale — ${TRANSFORM_LABELS[transform]}. Click to change.`}
        className={cn(
          'px-1.5 h-5 rounded-[var(--radius-xs)] text-[10px] font-mono whitespace-nowrap',
          'transition-colors duration-[var(--dur-fast)]',
          open
            ? 'bg-[var(--surface-hover)] text-[var(--text-accent)]'
            : 'text-[var(--text-disabled)] hover:text-[var(--text-accent)] hover:bg-[var(--surface-hover)]',
        )}
      >
        {TRANSFORM_LABELS[transform].toLowerCase()}
        {dirty && <span className="text-[var(--text-accent)]"> *</span>}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={252} align="center">
        <div className="p-1 hairline-b">
          {IMPLEMENTED_TRANSFORMS.map((k) => (
            <button
              key={k}
              onClick={() => onTransform(k)}
              className={cn(
                'flex items-center gap-2 w-full h-6 px-1.5 rounded-[var(--radius-xs)] text-left',
                'transition-colors duration-[var(--dur-instant)]',
                k === transform ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
              )}
            >
              <Check size={11} className={cn('shrink-0', k === transform ? 'text-[var(--text-accent)]' : 'opacity-0')} />
              <span className="text-2xs text-[var(--text-primary)]">{TRANSFORM_LABELS[k]}</span>
            </button>
          ))}
        </div>

        <div className="p-2.5 space-y-2.5 overflow-y-auto">
          <p className="text-[10px] leading-snug text-[var(--text-tertiary)]">{DESCRIPTION[transform]}</p>
          <TransformParameters transform={transform} resolved={resolved} onOverride={onOverride} />
          {dirty && (
            <button
              onClick={onReset}
              className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-accent)] hover:underline"
            >
              <RotateCcw size={10} />
              Reset to auto-estimated
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

/** One line about what a transform does, for wherever it is being chosen. */
export function transformDescription(k: TransformKind): string {
  return DESCRIPTION[k] ?? '';
}

/**
 * The parameters a transform exposes, and nothing else.
 *
 * Split out of the popover above because the axis settings panel needs exactly
 * these fields and the same behaviour — editing one updates the plot live —
 * without the popover, the transform list or the button that opens it. Two
 * copies of "which fields does logicle have" would drift the first time a
 * transform gained one, and the drift would be invisible until someone opened
 * the surface that had been forgotten.
 */
export function TransformParameters({
  transform, resolved, onOverride,
}: {
  transform: TransformKind;
  resolved: TransformSpec;
  onOverride: (key: keyof TransformOverrides, value: number | undefined) => void;
}) {
  return (
    <>
      {transform === 'linear' && (
        <p className="text-[10px] text-[var(--text-disabled)]">A linear axis has nothing to configure.</p>
      )}

      {transform === 'asinh' && (
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Cofactor
              <InfoHint content="Sets the width of the near-linear region. Values well below the cofactor stay roughly linear; values well above become logarithmic. Lower it to expand the region around zero." />
            </span>
          }
        >
          <NumberInput
            value={resolved.cofactor ?? 1000}
            min={1}
            step={100}
            onChange={(e) => onOverride('cofactor', Number(e.target.value) || 1)}
          />
        </Field>
      )}

      {(transform === 'logicle' || transform === 'hyperlog') && (
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Width basis (W) — {(resolved.width ?? 0.5).toFixed(2)} decades
              <InfoHint content="How many decades around zero are displayed linearly. Estimated from this channel's negative events. Raise it to spread a dense negative population; lower it to keep more of the axis logarithmic." />
            </span>
          }
        >
          <Slider
            value={resolved.width ?? 0.5}
            min={0}
            max={(resolved.decades ?? 4.5) / 2}
            step={0.05}
            onChange={(v) => onOverride('width', v)}
          />
        </Field>
      )}

      {transform === 'biexponential' && (
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Width basis
              <InfoHint content="The negative data value the linear region should reach — FlowJo's parameterisation, so an imported workspace keeps its author's intent. Estimated from this channel's negative events." />
            </span>
          }
          hint="Negative data value, not decades."
        >
          <NumberInput
            value={resolved.width ?? -10}
            max={-1}
            step={10}
            onChange={(e) => onOverride('width', Math.min(-1, Number(e.target.value) || -10))}
          />
        </Field>
      )}

      {transform !== 'linear' && (
        <Field label={`Decades (M) — ${(resolved.decades ?? 4.5).toFixed(1)}`}>
          <Slider
            value={resolved.decades ?? 4.5}
            min={1}
            max={7}
            step={0.1}
            onChange={(v) => onOverride('decades', v)}
          />
        </Field>
      )}

      {/*
         **Extra negative decades (A) is gone (2026-08-19), and it never did
         anything.**

         It was a slider from 0 to 2 offering "additional display space below
         zero", and it was reported as having no visible effect at any value.
         That is exactly right, and it is not a wiring fault — the override
         reached `TransformSpec`, `initLogicle` read it, and every number in the
         transform changed. Swept over a real unmixed column, the population did not move by a tenth of a
         percent of the square at any setting.

         The reason is arithmetic. The logicle puts `A` decades below zero by
         making the whole display scale `M + A` decades wide: `b = (M+A)·ln10`
         and `a ≈ T·10^-(M+A)`, so a data value's position measured *in decades
         below T* comes out independent of `A` — `A` only rescales the display
         coordinate. A plot that framed itself on the transform's full [0,1]
         would see the difference; this one frames itself on its data and
         renormalises, which cancels `A` exactly.

         `spec.negativeDecades` stays. It is the GatingML parameter, `logicle.ts`
         and `hyperlog.ts` implement it correctly, and a transform arriving from
         a file may state it. What is removed is the *control*, because the thing
         somebody reached for it to do — move a population off the edge — is what
         the Range fields and the new shift buttons in the Axes panel do, in
         units the axis is labelled in.
      */}
    </>
  );
}

/** Merge user overrides onto the data-derived defaults. */
export function resolveSpec(
  kind: TransformKind,
  range: number,
  values: Float32Array | undefined,
  overrides: TransformOverrides,
): TransformSpec {
  return { ...autoSpec(kind, range, values), ...overrides };
}
