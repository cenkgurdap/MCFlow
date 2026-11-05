import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, MouseEvent, SelectHTMLAttributes, ReactNode } from 'react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from './cn';

/* ---------------------------------------------------------------------------
   Field — the label/hint/error wrapper every control sits in.
   Keeps vertical rhythm identical across the whole inspector panel.
   ------------------------------------------------------------------------ */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  inline,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  /** Label on the left, control on the right — for dense property lists. */
  inline?: boolean;
  className?: string;
}) {
  if (inline) {
    return (
      <div className={cn('flex items-center justify-between gap-3 min-h-[var(--h-control)]', className)}>
        {label && (
          /*
             `min-w-0`, not `shrink-0`.

             A row whose label and control together exceed the container used to
             squeeze the control — which is an `inline-flex` of buttons and
             cannot shrink — so it overflowed back across the label and the two
             rendered on top of each other. That is the Smoothing row's reported
             overlap (2026-08-04, Item 4), and while that particular row is fixed
             by not being inline any more, the failure mode was the wrapper's.
             Letting the label wrap instead makes a too-narrow row taller, which
             is legible; nothing changes for a row that fits, since flex-shrink
             only applies once there is an overflow to distribute.
          */
          <label htmlFor={htmlFor} className="text-xs text-[var(--text-secondary)] select-none min-w-0">
            {label}
          </label>
        )}
        <div className="min-w-0 flex-1 flex justify-end shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-[var(--text-secondary)] select-none">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-2xs text-[var(--status-err)]">{error}</p>
      ) : hint ? (
        <p className="text-2xs text-[var(--text-tertiary)] leading-snug">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL_BASE =
  'w-full h-[var(--h-control)] px-2 bg-[var(--surface-input)] text-[var(--text-primary)] ' +
  'border border-[var(--border-default)] rounded-[var(--radius-sm)] text-xs ' +
  'transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-standard)] ' +
  'placeholder:text-[var(--text-disabled)] ' +
  'hover:border-[var(--border-strong)] ' +
  'focus:outline-none focus:border-[var(--border-accent)] focus:ring-2 focus:ring-[var(--accent-500)]/22 ' +
  'disabled:text-[var(--text-disabled)] disabled:bg-transparent disabled:cursor-not-allowed';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Small glyph or unit rendered inside the right edge (e.g. "µm", "%"). */
  suffix?: ReactNode;
  mono?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, suffix, mono, className, ...rest },
  ref,
) {
  const input = (
    <input
      ref={ref}
      className={cn(
        CONTROL_BASE,
        mono && 'font-mono tnum',
        suffix != null && suffix !== false && 'pr-8',
        invalid && 'border-[var(--status-err)] focus:border-[var(--status-err)] focus:ring-[var(--status-err)]/22',
        className,
      )}
      {...rest}
    />
  );
  if (!suffix) return input;
  return (
    <div className="relative">
      {input}
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-[var(--text-tertiary)]">
        {suffix}
      </span>
    </div>
  );
});

/** Numeric input. Always monospace + tabular so digits don't shift on edit. */
export const NumberInput = forwardRef<HTMLInputElement, TextInputProps>(function NumberInput(
  { className, ...rest },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      type="number"
      mono
      className={cn(
        'text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
        className,
      )}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          CONTROL_BASE,
          'appearance-none pr-7 cursor-pointer',
          invalid && 'border-[var(--status-err)]',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={13}
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
      />
    </div>
  );
});

/* ---------------------------------------------------------------------------
   Checkbox — custom mark. Supports indeterminate for tree/table headers.
   ------------------------------------------------------------------------ */

/**
 * The box and its mark, with no click target of its own.
 *
 * For rows that are already one hit target — a whole list row that toggles when
 * clicked anywhere — where a second focusable control inside it is not just
 * redundant but actively harmful. See the note on `Checkbox` below.
 */
export function CheckboxGlyph({
  checked,
  indeterminate,
  disabled,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid place-items-center h-3.5 w-3.5 shrink-0 rounded-[var(--radius-xs)] border',
        'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
        checked || indeterminate
          ? 'bg-[var(--accent-500)] border-[var(--accent-500)] text-[var(--action-primary-fg)]'
          : 'bg-[var(--surface-input)] border-[var(--border-strong)]',
        disabled && 'opacity-40',
        className,
      )}
    >
      {indeterminate ? <Minus size={10} strokeWidth={3} /> : checked ? <Check size={10} strokeWidth={3.25} /> : null}
    </span>
  );
}

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  ariaLabel,
  disabled,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  /**
   * The originating click is handed back as a second argument.
   *
   * A list that offers a Shift-range needs the modifier state, and when the box
   * itself is the thing under the pointer this button is the only element that
   * sees the real event. Every caller that does not care simply ignores it.
   */
  onChange: (next: boolean, e: MouseEvent) => void;
  label?: ReactNode;
  /** For a row that draws its own name instead of passing one as `label`. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={ariaLabel}
        disabled={disabled}
        /*
           `preventDefault`, and it is load-bearing rather than tidiness.

           Nesting this inside a `<label>` — which reads as the obvious way to
           make a whole row clickable — makes the row toggle twice and therefore
           not at all. A `<label>` forwards a click to its labelable descendant,
           and a `<button>` is labelable; Chromium suppresses that forwarding
           when the click landed on interactive content, but the check mark
           inside the button is an `<svg>`, which is a foreign element and is not
           interactive content. So a press on the glyph ran this handler *and*
           was forwarded back to this button by the label. Measured on the
           Unmixing sample list: a 9 px band across the middle of the box in
           which ticking worked and unticking did nothing, because the mark only
           exists once the box is ticked.

           A cancelled event has no activation behaviour, so this stops the
           forward at its source. `CheckboxGlyph` above is the structural answer
           for a row that wants one hit target; this is the guard for everywhere
           else, so the mistake cannot be made again silently.

           The other half of the same trap, for a row that offers a Shift-range:
           a click forwarded by a `<label>` is a *simulated* click, and nothing
           guarantees it carries the modifier keys of the click that caused it.
           So a row wanting the gesture draws its own name as a plain span and
           lets the row own the click — never passes it as `label`. That is why
           `ariaLabel` exists above; see `PopulationPicker`.
        */
        onClick={(e) => { e.preventDefault(); onChange(!checked, e); }}
        className={cn(
          'grid place-items-center h-3.5 w-3.5 shrink-0 rounded-[var(--radius-xs)] border',
          'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
          checked || indeterminate
            ? 'bg-[var(--accent-500)] border-[var(--accent-500)] text-[var(--action-primary-fg)]'
            : 'bg-[var(--surface-input)] border-[var(--border-strong)] hover:border-[var(--accent-500)]',
          disabled && 'opacity-40 cursor-not-allowed',
        )}
      >
        {indeterminate ? <Minus size={10} strokeWidth={3} /> : checked ? <Check size={10} strokeWidth={3.25} /> : null}
      </button>
      {label && (
        <label
          htmlFor={id}
          className={cn('text-xs select-none cursor-pointer', disabled ? 'text-[var(--text-disabled)]' : 'text-[var(--text-secondary)]')}
        >
          {label}
        </label>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Switch — for binary modes that take effect immediately (comp on/off,
   dark mode). Checkbox is for selection; switch is for state.
   ------------------------------------------------------------------------ */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = 'md',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  const dims = size === 'sm' ? { w: 24, h: 14, k: 10 } : { w: 30, h: 17, k: 13 };
  return (
    <label className={cn('inline-flex items-center gap-2', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{ width: dims.w, height: dims.h }}
        className={cn(
          'relative shrink-0 rounded-[var(--radius-full)] border transition-colors duration-[var(--dur-normal)] ease-[var(--ease-standard)]',
          checked
            ? 'bg-[var(--accent-500)] border-[var(--accent-500)]'
            // The off track has to stay visible against a light surface, where
            // --surface-active is only ~7% ink and the white knob would vanish.
            : 'bg-[var(--border-default)] border-[var(--border-strong)]',
          disabled && 'opacity-40',
        )}
      >
        <span
          style={{
            width: dims.k,
            height: dims.k,
            transform: `translateX(${checked ? dims.w - dims.k - 3 : 1}px)`,
          }}
          className={cn(
            'absolute top-1/2 left-0 -translate-y-1/2 rounded-full bg-white',
            'shadow-[0_1px_2px_rgb(0_0_0/0.28)] transition-transform duration-[var(--dur-normal)] ease-[var(--ease-emphasis)]',
          )}
        />
      </button>
      {label && (
        <span className={cn('text-xs select-none', disabled ? 'text-[var(--text-disabled)]' : 'text-[var(--text-secondary)]')}>
          {label}
        </span>
      )}
    </label>
  );
}

/* ---------------------------------------------------------------------------
   Slider — used for transform parameters where live scrubbing matters more
   than exact entry. Always paired with a NumberInput for precise values.
   ------------------------------------------------------------------------ */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        background: `linear-gradient(to right, var(--accent-500) 0%, var(--accent-500) ${pct}%, var(--surface-active) ${pct}%, var(--surface-active) 100%)`,
      }}
      className={cn(
        'w-full h-1 appearance-none rounded-[var(--radius-full)] cursor-pointer outline-none',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        // WebKit thumb
        '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3',
        '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
        '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-[var(--border-strong)]',
        '[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:transition-transform',
        '[&::-webkit-slider-thumb]:duration-[var(--dur-fast)] hover:[&::-webkit-slider-thumb]:scale-115',
        // Firefox thumb
        '[&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full',
        '[&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-[var(--border-strong)]',
        className,
      )}
    />
  );
}
