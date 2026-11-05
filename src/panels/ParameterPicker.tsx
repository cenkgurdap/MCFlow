import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { FcsParameter } from '@/core/fcs/types';
import { TextInput } from '@/ui/Field';
import { Popover } from '@/ui/Popover';
import { cn } from '@/ui/cn';

const TYPE_LABEL: Record<string, string> = {
  Time: 'Time',
  Forward_Scatter: 'FSC',
  Side_Scatter: 'SSC',
  Raw_Fluorescence: 'Raw',
  Unmixed_Fluorescence: 'Unmixed',
  Compensated_Fluorescence: 'Comp',
  Derived: 'Calc',
  Other: '',
};

/**
 * Axis parameter selector.
 *
 * A native <select> is unusable at 71 parameters, which is what every file in
 * this project has — so this is a searchable, grouped, keyboard-navigable list.
 * It sits directly on the plot rather than in a settings dialog, per the brief.
 */
export function ParameterPicker({
  parameters,
  value,
  onChange,
  className,
}: {
  parameters: FcsParameter[];
  value: number;
  onChange: (index: number) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = parameters[value];

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const withIndex = parameters.map((p, i) => ({ p, i })).filter(({ p }) => p.isDataChannel || p.type === 'Time');
    if (!q) return withIndex;
    return withIndex.filter(
      ({ p }) => p.name.toLowerCase().includes(q) || p.stain.toLowerCase().includes(q) || TYPE_LABEL[p.type]?.toLowerCase().includes(q),
    );
  }, [parameters, query]);

  // Keep the highlighted row in view as the user arrows through 71 entries.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(Math.max(0, matches.findIndex((m) => m.i === value)));
    }
    // `matches` intentionally excluded: this should run on open, not on filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value]);

  const commit = (index: number) => {
    onChange(index);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(matches.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[active];
      if (m) commit(m.i);
    } else if (e.key === 'Home') {
      setActive(0);
    } else if (e.key === 'End') {
      setActive(matches.length - 1);
    }
  };

  const label = current ? current.label : '—';
  /*
     The detector name as a subtitle, **only when the label is not already it**.

     The test was `stain !== name`, which is the wrong question. What is on the
     button is `label`, and `label` is not always the stain: a *derived*
     parameter is `{ name: 'Membrane order', stain: '(A-B)/(A+B)', label:
     'Membrane order' }` — the expression is carried in `stain` because that is
     the field a description lives in, and the label is deliberately the name. So
     `stain !== name` was true, the subtitle rendered, and the button read
     "Membrane order Membrane order".

     Asking whether the label already *is* the name answers it for both cases at
     once: a marker-labelled detector still gets `B2-A` underneath, and anything
     labelled by its own name gets nothing.
  */
  const sub = current && current.stain && current.label !== current.name ? current.name : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${current.label}${sub ? ` (${sub})` : ''} — click to change axis` : 'Select a parameter'}
        className={cn(
          'group inline-flex items-center gap-1.5 max-w-full px-2 h-6 rounded-[var(--radius-sm)]',
          'text-2xs font-medium whitespace-nowrap select-none',
          'border border-transparent text-[var(--plot-label)]',
          'hover:bg-[var(--surface-hover)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]',
          'transition-colors duration-[var(--dur-fast)]',
          open && 'bg-[var(--surface-hover)] border-[var(--border-default)] text-[var(--text-primary)]',
          className,
        )}
      >
        <span className="truncate">{label}</span>
        {sub && <span className="text-[var(--text-disabled)] font-normal truncate">{sub}</span>}
        <ChevronDown size={11} className="shrink-0 opacity-40 group-hover:opacity-90 transition-opacity" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={btnRef.current} width={286} align="center">
        <div className="p-1.5 hairline-b">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)] pointer-events-none" />
            <TextInput
              // `data-autofocus`, not React's `autoFocus`: the popover is
              // `visibility: hidden` until it has been positioned, and a hidden
              // element cannot take focus, so `autoFocus` fired into nothing and
              // the picker opened needing an extra click before typing filtered
              // anything. `Popover` focuses this once it is on screen.
              data-autofocus=""
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search parameters…"
              className="pl-7 h-7"
            />
          </div>
        </div>
        <div ref={listRef} className="overflow-y-auto p-1 min-h-0">
          {matches.map((m, i) => {
            const selected = m.i === value;
            return (
              <button
                key={m.i}
                data-idx={i}
                onClick={() => commit(m.i)}
                onPointerEnter={() => setActive(i)}
                className={cn(
                  'flex items-center gap-2 w-full h-6 px-1.5 rounded-[var(--radius-xs)] text-left',
                  'transition-colors duration-[var(--dur-instant)]',
                  i === active ? 'bg-[var(--surface-hover)]' : '',
                  selected && 'bg-[var(--surface-selected)]',
                )}
              >
                <Check
                  size={11}
                  className={cn('shrink-0', selected ? 'text-[var(--text-accent)]' : 'opacity-0')}
                />
                <span className="font-mono text-2xs text-[var(--text-primary)] truncate">{m.p.name}</span>
                {m.p.stain && <span className="text-2xs text-[var(--text-tertiary)] truncate">{m.p.stain}</span>}
                <span className="ml-auto shrink-0 text-[9px] font-mono text-[var(--text-disabled)]">
                  {TYPE_LABEL[m.p.type]}
                </span>
              </button>
            );
          })}
          {matches.length === 0 && (
            <p className="text-2xs text-[var(--text-tertiary)] px-2 py-3 text-center">
              No parameter matches “{query}”.
            </p>
          )}
        </div>
        <div className="hairline-t px-2 py-1 flex items-center justify-between text-[10px] text-[var(--text-disabled)]">
          <span>{matches.length} of {parameters.length}</span>
          <span>↑↓ navigate · ⏎ select</span>
        </div>
      </Popover>
    </>
  );
}
