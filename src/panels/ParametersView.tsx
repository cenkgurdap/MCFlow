import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Pencil, Plus, Search, Sigma, Trash2, X } from 'lucide-react';
import { validateDefinition, type DerivedParameterDef } from '@/core/derived';
import { clampCaret, insertToken, tokenForName, OPERATOR_BUTTONS } from '@/core/equationInsert';
import { groupParameters } from '@/core/paramGroups';
import { PARAMETER_PRESETS, describePresetChannels } from '@/core/parameterPresets';
import { describeDetectorFull } from '@/core/detectors';
import type { FcsParameter } from '@/core/fcs/types';
import { parametersFor, sampleColumn, useDerived } from '@/state/derivedStore';
import { gatesUsingParameter } from '@/state/gateStore';
import { panelsUsingParameter } from '@/state/plotStore';
import { useSpectral } from '@/state/spectralStore';
import { selectedSample, useWorkspace, type Sample } from '@/state/workspaceStore';
import { Button, IconButton } from '@/ui/Button';
import { Field, TextInput } from '@/ui/Field';
import { Badge, Callout, EmptyState, StatTile } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

/* ==========================================================================
   Parameters — the file's own, and the ones the user computes.

   A derived parameter is arithmetic over existing parameters, FCS Express-style:
   `(FITC-A - APC-A) / (FITC-A + APC-A)`. The machinery has existed since the
   worksheet pass — `core/derived.ts` for the language, `state/derivedStore.ts`
   for the virtual parameter index that lets every consumer keep taking a plain
   number — but the only way to reach it was a collapsed section inside the
   inspector, behind a sample selection, which is not a feature anybody finds.

   So it is a section of its own, between Analysis and Unmixing: gate the data,
   compute whatever the panel needs computing, then unmix. The view does three
   things the inspector row could not:

     - it shows the expression being *checked against real data* rather than only
       against the parameter names, so a definition that resolves everywhere and
       one that resolves on four samples of six are visibly different;
     - it lists the file's own parameters beside the editor, because the names an
       expression has to use are the hard part and they are 71 of them here;
     - it exists with no sample selected, which is when someone setting up a
       panel actually writes these.
   ========================================================================== */

export function ParametersView() {
  const defs = useDerived((s) => s.defs);
  const { addDef, updateDef, removeDef } = useDerived();
  const samples = useWorkspace((s) => s.samples);
  const sample = useWorkspace(selectedSample);

  const [editing, setEditing] = useState<{ id: string | null; name: string; expression: string } | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  /**
   * The equation field, so the name list and the operator buttons can type into
   * it.
   *
   * A ref rather than lifting the caret into state: the caret belongs to the
   * input, React does not track it, and mirroring it into state means every
   * keystroke re-renders the view to store a number the DOM already knows.
   */
  const equationRef = useRef<HTMLInputElement>(null);

  /**
   * The caret, as the field last had it.
   *
   * This is the whole of the "everything lands at the end" bug, and the cause is
   * one line further out than it looks. The insert used to read
   * `input.selectionStart` **only when `document.activeElement === input`** — and
   * by the time an insert runs, it never is: pressing an operator button or
   * double-clicking a name moves focus to that button, which is what a press on a
   * focusable element does. So every insert took the `current.length` fallback and
   * appended, which is right for a caret at the end and wrong for every other
   * caret, including the mid-expression one that makes the fallback matter.
   *
   * Two fixes, and both are needed. The clickable surfaces `preventDefault` their
   * `mousedown` so focus never leaves the field in the first place — that is the
   * one that makes the live selection readable, and it also stops the field
   * visibly losing its caret when a button is pressed. And the caret is recorded
   * here on every selection change as the fallback for anything that does move
   * focus anyway: a keyboard-driven insert, or a browser that treats
   * `preventDefault` on `mousedown` differently.
   */
  const caret = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  /** Record the field's selection. Bound to every event that can move it. */
  const noteCaret = () => {
    const el = equationRef.current;
    if (!el) return;
    caret.current = {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.selectionStart ?? el.value.length,
    };
  };

  /**
   * Where the caret should be put once React has written the new value.
   *
   * Applied from a layout effect rather than `requestAnimationFrame`, which is
   * what this used to use. Chromium throttles rAF to about 1 Hz in a hidden or
   * background window — the trap PROGRESS.md records for the gate-naming field —
   * so the caret would sit unmoved for up to a second, and a second insert
   * arriving in that window would compute its position from the pre-move caret. A
   * layout effect runs synchronously after the commit that wrote the value and
   * before paint, which is exactly the moment wanted and is not tied to frames.
   */
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const el = equationRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
    caret.current = { start: at, end: at };
  });

  /**
   * Put text into the equation at the caret.
   *
   * Shared by every insertion route — a double-clicked parameter name and an
   * operator button — so the spacing rules cannot differ between them. If no
   * definition is open, one is started: double-clicking a name is an unambiguous
   * statement of intent, and answering it with nothing would read as the list
   * being inert.
   *
   * A highlighted range is **replaced**, the way typing would replace it, because
   * that is what a selection means everywhere else and `insertToken` already takes
   * a range rather than a point.
   */
  const insert = (text: string) => {
    const input = equationRef.current;
    const current = editing?.expression ?? '';
    // The live selection when the field still holds it — `preventDefault` on the
    // button's mousedown is what makes that the normal case — and the recorded one
    // otherwise. Both are clamped: the recorded caret can outlive the string it
    // was measured in, if the expression was edited or the editor reopened.
    const live = !!input && document.activeElement === input;
    const from = live ? input!.selectionStart : caret.current.start;
    const to = live ? input!.selectionEnd : caret.current.end;
    const start = clampCaret(from, current.length);
    const end = Math.max(start, clampCaret(to, current.length));

    const next = insertToken(current, start, end, text);
    // Set before the state write, so the layout effect that runs off this render
    // finds it. The next insert then continues from just past this one, which is
    // what consecutive clicks have to do to build an expression left to right.
    pendingCaret.current = next.caret;
    caret.current = { start: next.caret, end: next.caret };

    setEditing((e) => (e ? { ...e, expression: next.expression } : { id: null, name: '', expression: next.expression }));
  };

  /** Open the editor on a definition, with the caret at the end of it. */
  const openEditor = (v: { id: string | null; name: string; expression: string }) => {
    caret.current = { start: v.expression.length, end: v.expression.length };
    pendingCaret.current = null;
    setEditing(v);
  };

  /**
   * Fill both fields from a preset.
   *
   * A replace rather than an insert, and that is the difference between this and
   * everything else that writes into the equation: a preset is a whole
   * definition, so splicing it at the caret would produce an expression that is
   * half one idea and half another. The caret lands at the end of what was
   * written, so an operator button pressed straight afterwards continues from
   * there rather than from wherever the caret happened to be before.
   */
  const applyPreset = (name: string, expression: string) => {
    caret.current = { start: expression.length, end: expression.length };
    pendingCaret.current = expression.length;
    setEditing((e) => ({ id: e?.id ?? null, name, expression }));
  };

  /**
   * Names an expression may reference.
   *
   * Taken from the selected sample, or the first loaded one when nothing is
   * selected — a definition is a property of the workspace, so it has to be
   * writable before anyone has clicked a file in the sidebar.
   */
  const reference = sample ?? samples[0] ?? null;
  const realNames = useMemo(
    () => (reference
      ? reference.parsed.metadata.parameters.filter((p) => p.isDataChannel || p.type === 'Time').map((p) => p.name)
      : []),
    [reference],
  );

  const check = editing
    ? validateDefinition(
        { id: editing.id ?? '__new__', name: editing.name, expression: editing.expression },
        realNames,
        defs,
      )
    : null;

  const commit = () => {
    if (!editing || !check?.ok) return;
    if (editing.id) updateDef(editing.id, { name: editing.name, expression: editing.expression });
    else addDef(editing.name, editing.expression);
    setEditing(null);
  };

  const filtering = query.trim().length > 0;
  // The signal that a matrix has been applied — see `PlotCanvas`.
  const unmixedResults = useSpectral((s) => s.unmixed);
  const listed = useMemo(() => {
    if (!reference) return [] as FcsParameter[];
    const all = parametersFor(reference.parsed, defs);
    const q = query.trim().toLowerCase();
    return q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.stain.toLowerCase().includes(q)) : all;
  }, [reference, defs, query, unmixedResults]);

  // Grouped over the *filtered* list, so a group's count is how many of its
  // parameters match — an empty group disappears rather than inviting a click
  // that reveals nothing.
  const groups = useMemo(() => groupParameters(listed), [listed]);

  return (
    <Panel className="h-full">
      <PanelHeader
        title="Parameters"
        icon={<Sigma size={12} />}
        count={reference ? `${listed.length} shown` : undefined}
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus size={11} />}
            onClick={() => openEditor({ id: null, name: '', expression: '' })}
            disabled={!!editing}
          >
            New parameter
          </Button>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-3 space-y-3 max-w-[980px]">
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Detectors" value={reference ? reference.parsed.metadata.parameterCount : '—'} />
            <StatTile label="Derived" value={defs.length} />
            <StatTile label="Applies to" value={`${samples.length} sample${samples.length === 1 ? '' : 's'}`} />
          </div>

          <p className="text-2xs text-[var(--text-tertiary)] leading-relaxed max-w-[76ch]">
            A derived parameter is arithmetic over the detectors — a ratio, a difference, a sum — and behaves like
            any other channel once defined: selectable on either axis, gateable, reported in statistics and saved
            with the workspace. It is defined once for the workspace and applied to every sample that carries the
            parameters it references.
          </p>

          {editing && (
            <DefinitionEditor
              editing={editing}
              check={check}
              samples={samples}
              defs={defs}
              equationRef={equationRef}
              onInsert={insert}
              onNoteCaret={noteCaret}
              onChange={setEditing}
              onPreset={applyPreset}
              onCommit={commit}
              onCancel={() => setEditing(null)}
            />
          )}

          {defs.length === 0 && !editing ? (
            <EmptyState
              size="sm"
              className="my-8"
              icon={<Sigma size={17} />}
              title="No derived parameters yet"
              description="Define one to plot a ratio, a difference or a normalised index alongside the detectors it is computed from."
              action={
                <Button size="sm" variant="secondary" icon={<Plus size={11} />} onClick={() => openEditor({ id: null, name: '', expression: '' })}>
                  New derived parameter
                </Button>
              }
            />
          ) : (
            <div className="space-y-1">
              {defs.map((d) => (
                <DefinitionRow
                  key={d.id}
                  def={d}
                  realNames={realNames}
                  siblings={defs}
                  samples={samples}
                  onEdit={() => openEditor({ id: d.id, name: d.name, expression: d.expression })}
                  usage={() => derivedUsage(d.id, defs, samples)}
                  onRemove={() => removeDef(d.id)}
                />
              ))}
              {/*
                 The add affordance, **under the list, and it never goes away**
                 (2026-08-11, Item 7).

                 Nothing ever limited the count. `addDef` appends, `parametersFor`
                 maps the whole array onto virtual indices, the statistics picker
                 and the export's computed columns both walk it, and the workspace
                 saves all of it — three definitions round-trip today exactly as
                 one does. What was missing is a way to *ask* for the second one.

                 An empty panel offered a centred `EmptyState` with a prominent
                 "New derived parameter" button; the moment a definition existed
                 that empty state was replaced by the list, and the only remaining
                 entry point was a small secondary button in the panel header,
                 forty pixels from the top-right corner and past the stat tiles.
                 A control that is present for the first item and gone for the
                 second reads exactly as "one is all you get", which is what was
                 reported. So the list ends with the same invitation it began
                 with.
              */}
              {!editing && (
                <button
                  type="button"
                  data-add-parameter=""
                  onClick={() => openEditor({ id: null, name: '', expression: '' })}
                  className={cn(
                    'flex items-center gap-2 w-full px-2 py-1.5 rounded-[var(--radius-sm)]',
                    'border border-dashed border-[var(--border-default)] text-left',
                    'text-2xs text-[var(--text-tertiary)]',
                    'hover:border-[var(--accent-500)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                    'transition-colors duration-[var(--dur-fast)]',
                  )}
                >
                  <Plus size={12} className="shrink-0" />
                  Add another parameter
                </button>
              )}
            </div>
          )}

          {/* The names, right where the equation is being written. Detector
              names contain the minus sign, so getting one slightly wrong is the
              likeliest way to write an equation that will not resolve — and
              double-clicking one spells it correctly by construction. */}
          {reference && (
            <section className="hairline-t pt-3 space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="eyebrow">Available names</h3>
                <span className="text-2xs text-[var(--text-disabled)] truncate">
                  from {reference.name} · double-click to insert
                </span>
                <div className="ml-auto relative w-[200px]">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)] pointer-events-none" />
                  <TextInput
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter parameters…"
                    className="pl-6 h-6 text-2xs"
                  />
                </div>
              </div>

              {/* Grouped by excitation line rather than listed flat.
                  A spectral file here has 71 parameters in one undifferentiated
                  column, and the names already carry the structure — `UV1-A`
                  through `UV16-A` is a block of the instrument, and an analyst
                  looking for a violet detector is looking for a block, not for
                  entry 34. See `core/paramGroups.ts` for why the grouping is
                  derived from the names and why an unrecognised name is left in
                  *Other* rather than being guessed into a laser it may not
                  belong to. */}
              {groups.map((g) => {
                // A filter searches the whole list. A collapsed group that
                // matches opens itself rather than hiding the answer — a filter
                // that silently excludes what you are filtering for is worse
                // than no filter.
                const open = !collapsed[g.key] || filtering;
                return (
                  <div key={g.key}>
                    <button
                      onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
                      className="flex items-center gap-1.5 w-full h-6 px-1 rounded-[var(--radius-xs)] hover:bg-[var(--surface-hover)] transition-colors duration-[var(--dur-fast)]"
                    >
                      <ChevronRight
                        size={11}
                        className={cn('shrink-0 text-[var(--text-disabled)] transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')}
                      />
                      <span className="eyebrow truncate">{g.label}</span>
                      <span className="text-2xs font-mono tnum text-[var(--text-disabled)]">{g.items.length}</span>
                    </button>
                    {open && (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-px pl-4">
                        {g.items.map((i) => {
                          const p = listed[i]!;
                          return (
                            <button
                              key={`${p.index}-${p.name}`}
                              type="button"
                              // The press is swallowed so the equation field keeps
                              // focus and its caret: a name is inserted **where the
                              // caret is**, and a press on a focusable element would
                              // have taken the caret away first. `dblclick` still
                              // fires — `preventDefault` on `mousedown` suppresses
                              // the default focus and text-selection behaviour, not
                              // the click events that follow it.
                              onMouseDown={(e) => e.preventDefault()}
                              onDoubleClick={() => insert(tokenForName(p.name))}
                              title={`${p.name}${p.stain ? ` — ${p.stain}` : ''}\nDouble-click to insert at the cursor`}
                              className="flex items-baseline gap-2 h-[21px] px-1 rounded-[var(--radius-xs)] text-left hover:bg-[var(--surface-hover)] select-none"
                            >
                              <span className="font-mono text-[10px] text-[var(--text-disabled)] w-6 shrink-0 text-right">{p.index}</span>
                              <span
                                className={cn(
                                  'font-mono text-2xs truncate flex-1 min-w-0',
                                  p.type === 'Derived' ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]',
                                )}
                              >
                                {p.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {listed.length === 0 && (
                <p className="text-2xs text-[var(--text-tertiary)] px-1 py-2">No parameter matches “{query}”.</p>
              )}
            </section>
          )}

          {!reference && (
            <Callout tone="info">
              No samples are loaded. Definitions written now apply to whatever is imported afterwards, but the
              parameter names cannot be checked until a file is open.
            </Callout>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ========================================================================== */

/*
   `PARAMETER_PRESETS` now lives in `core/parameterPresets.ts` (2026-08-14).

   It was defined here, which was right while this panel was the only thing that
   could create a derived parameter. The Biophysics pipeline creates the
   membrane-order parameter on the user's behalf, and it has to be **the same
   parameter this panel would have made** — same name, same equation, same
   object — or a workspace ends up with two definitions of one measurement.
   Moving the list rather than importing a copy is what makes that true by
   construction. Nothing about the values or the reasoning changed; both are in
   that file.

   Presented here exactly as before: double-click, matching the parameter list
   below — a single click on either would replace whatever is half-typed in the
   fields, which is not what a pointer brushing past a row should do.
*/

/**
 * Name and expression, validated as it is typed.
 *
 * Validation is a sentence rather than a failure: an expression is invalid for
 * most of the time it is being typed, so the error only appears once there is
 * something to be wrong about, and the reference list below it says what the
 * expression resolved to rather than merely that it parsed.
 */
function DefinitionEditor({
  editing, check, samples, defs, equationRef, onInsert, onNoteCaret, onChange, onPreset, onCommit, onCancel,
}: {
  editing: { id: string | null; name: string; expression: string };
  check: ReturnType<typeof validateDefinition> | null;
  samples: Sample[];
  defs: DerivedParameterDef[];
  /** Owned by the view, because the name list types into it too. */
  equationRef: React.RefObject<HTMLInputElement | null>;
  onInsert: (text: string) => void;
  /** Record the caret, so an insert can splice rather than append. */
  onNoteCaret: () => void;
  onChange: (v: { id: string | null; name: string; expression: string }) => void;
  /** Fill both fields from a preset, replacing whatever is in them. */
  onPreset: (name: string, expression: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2.5 p-2.5 rounded-[var(--radius-sm)] border border-[var(--accent-500)]/45 bg-[var(--surface-sunken)]">
      <div className="grid grid-cols-[220px_1fr] gap-2.5">
        <Field label="Name">
          <TextInput
            data-autofocus=""
            autoFocus
            value={editing.name}
            onChange={(e) => onChange({ ...editing, name: e.target.value })}
            // Named after what a spectral panel actually computes rather than
            // after two conventional filters. `FITC/APC index` also spelled the
            // one thing the field must not contain — a slash reads as division
            // — in the grey text meant to show what a good answer looks like.
            placeholder="e.g. Membrane order"
            className="h-7 text-xs"
          />
        </Field>
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              {/* "Equation", not "Expression". The field takes arithmetic and
                  reads back as one; "expression" is what the parser calls its
                  input, which is not a reason for the label to say it. */}
              Equation
              <InfoHint content="Arithmetic over parameter names: + − × ÷ and brackets. Detector names contain the minus sign, so the tokeniser matches the longest known name at each position; wrap a name in [ ] to be explicit about it. Double-click a name below to insert it, and use the operator buttons rather than typing." />
            </span>
          }
        >
          <div className="flex items-center gap-1.5">
            <TextInput
              ref={equationRef}
              mono
              // A stable hook. The harnesses used to find this field by its
              // placeholder, so changing the example text (2026-08-11, Item 8)
              // broke two checks that had nothing to do with the example — the
              // "assert on a proxy" trap this project keeps recording, in its
              // mildest form.
              data-equation=""
              value={editing.expression}
              onChange={(e) => { onChange({ ...editing, expression: e.target.value }); onNoteCaret(); }}
              // `select` covers every way the caret moves that the browser reports
              // as a selection change — a click into the middle of the string,
              // arrow keys, a drag-select, Ctrl+A. `keyUp` and `focus` are belt and
              // braces for the cases where it does not fire, and `click` for a
              // caret placed by a click that changed nothing else.
              onSelect={onNoteCaret}
              onKeyUp={onNoteCaret}
              onClick={onNoteCaret}
              onFocus={onNoteCaret}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
              }}
              // Detector names this instrument really has, so the example can be
              // typed as it stands. `FITC-A` and `APC-A` are conventional-filter
              // names and resolve on none of the files in this project — an
              // example that would be rejected if entered is worse than none.
              placeholder="(V1-A - V7-A)/(V1-A + V7-A)"
              invalid={!!editing.expression && !check?.ok}
              className="h-7 text-xs"
            />
            {/* Operator buttons, beside the field they type into.
                The specific problem they solve: every detector name on this
                instrument contains a hyphen — `V1-A`, `YG10-A` — so a typed
                minus sign lands next to one and `V1-A - B1-A` is a sentence you
                have to parse character by character to be sure of. A clicked
                operator arrives spaced and deliberate, and the glyphs are the
                mathematical `−` and `×` so the button cannot be mistaken for
                the hyphen it disambiguates. What they insert is plain ASCII. */}
            <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Insert operator">
              {OPERATOR_BUTTONS.map((op) => (
                <button
                  key={op.insert}
                  type="button"
                  title={`${op.title} — inserts “${op.insert}” at the cursor`}
                  aria-label={op.title}
                  data-operator={op.insert}
                  // Same reason as the name list: the field must not lose its
                  // caret to the button that is about to insert at it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onInsert(op.insert)}
                  className={cn(
                    'h-7 w-7 grid place-items-center shrink-0 rounded-[var(--radius-xs)]',
                    'font-mono text-xs text-[var(--text-secondary)]',
                    'border border-[var(--border-subtle)] bg-[var(--surface-raised)]',
                    'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                    'transition-colors duration-[var(--dur-fast)]',
                  )}
                >
                  {op.glyph}
                </button>
              ))}
            </div>
          </div>
        </Field>
      </div>

      {/* Presets, under the two fields they fill and above the channel list.
          A row rather than a dropdown: there are three of them, each is two
          short strings, and a `<select>` would hide the equation — which is the
          half a reader has to see in order to recognise the pattern and write a
          fourth of their own. */}
      <div className="space-y-1">
        <p className="text-[10px] text-[var(--text-tertiary)]">
          Presets · double-click to fill both fields
        </p>
        <div className="flex flex-wrap gap-1.5" data-parameter-presets="">
          {PARAMETER_PRESETS.map((p) => {
            /* What each detector collects, under the equation it appears in.
               Nothing in the file says what V1 is — `$PnS`, `$PnF` and `$PnL`
               are all absent — so a preset naming two of them is asking the
               reader to know a filter chart by heart. This is that chart, for
               the two channels in front of them. It annotates and never
               decides; a name with no published band simply gets no line, which
               is what happens on any instrument that is not a Cytek Aurora. */
            const bands = describePresetChannels(p);
            return (
              <button
                key={p.name}
                type="button"
                data-parameter-preset={p.name}
                // Same reason as the parameter list and the operator buttons: the
                // equation field must not lose its caret to a control that is
                // about to write into it.
                onMouseDown={(e) => e.preventDefault()}
                onDoubleClick={() => onPreset(p.name, p.expression)}
                title={`${p.expression}\n\n${p.hint}\n\nDouble-click to use`}
                className={cn(
                  'flex flex-col items-start gap-0.5 px-2 py-1 rounded-[var(--radius-xs)] text-left select-none',
                  'border border-[var(--border-subtle)] bg-[var(--surface-raised)]',
                  'hover:border-[var(--accent-500)] hover:bg-[var(--surface-hover)]',
                  'transition-colors duration-[var(--dur-fast)]',
                )}
              >
                <span className="text-2xs text-[var(--text-primary)]">{p.name}</span>
                <span className="font-mono text-[10px] text-[var(--text-tertiary)]">{p.expression}</span>
                {bands && (
                  <span className="text-[10px] text-[var(--text-disabled)] leading-tight" data-preset-bands="">
                    {bands.map((b) => (
                      <span key={b.name} className="block">
                        <span className="font-mono">{b.name}</span> · <span className="tnum">{b.band}</span>
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-[var(--text-disabled)]">
          Bands are the Cytek Aurora configuration, for reference — a detector of the same name on another
          instrument may collect something else.
        </p>
      </div>

      {editing.expression.trim() && check && !check.ok && <Callout tone="err">{check.error}</Callout>}

      {check?.ok && check.references.length > 0 && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-tertiary)]">Reads</span>
            {check.references.map((r) => <Badge key={r} mono>{r}</Badge>)}
            <Coverage names={check.references} samples={samples} defs={defs} />
          </div>
          {/* The same annotation the presets carry, for an equation typed by
              hand — which is the case where knowing what the two detectors
              collect matters most, since nothing else on screen says. */}
          <ReferenceBands names={check.references} />
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="primary" icon={<Check size={11} />} onClick={onCommit} disabled={!check?.ok}>
          {editing.id ? 'Save' : 'Add parameter'}
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={11} />} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * What each detector an expression reads actually collects.
 *
 * Only the names this build has a published band for, which is why it can render
 * nothing at all: a derived parameter, a scatter channel and every detector on an
 * instrument that is not a Cytek Aurora resolve to no band, and inventing a
 * wavelength for them would be worse than silence. See `core/detectors.ts`.
 */
function ReferenceBands({ names }: { names: string[] }) {
  const known = names
    .map((name) => ({ name, band: describeDetectorFull(name) }))
    .filter((r): r is { name: string; band: string } => r.band !== null);
  if (known.length === 0) return null;
  return (
    <p className="text-[10px] text-[var(--text-disabled)] leading-snug" data-reference-bands="">
      {known.map((r, i) => (
        <span key={r.name}>
          {i > 0 && ' · '}
          <span className="font-mono">{r.name}</span> <span className="tnum">{r.band}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * How many loaded samples carry every name the expression reads.
 *
 * Definitions are workspace-wide and a sample missing an input gets a column of
 * NaN — which plots as nothing and gates as false, deliberately. That is the
 * honest representation of "no value", but it is indistinguishable from an empty
 * population unless something says so before the plot is drawn.
 */
function Coverage({ names, samples, defs }: { names: string[]; samples: Sample[]; defs: DerivedParameterDef[] }) {
  if (samples.length === 0) return null;
  const derivedNames = new Set(defs.map((d) => d.name.toLowerCase()));
  const covered = samples.filter((s) => {
    const own = new Set(s.parsed.metadata.parameters.map((p) => p.name.toLowerCase()));
    return names.every((n) => own.has(n.toLowerCase()) || derivedNames.has(n.toLowerCase()));
  }).length;
  return (
    <Badge tone={covered === samples.length ? 'ok' : 'warn'}>
      resolves on {covered} of {samples.length}
    </Badge>
  );
}

/**
 * What still reads a definition — the gates and plots that go with it.
 *
 * Asked when *Remove* is pressed rather than kept current, because it walks
 * every gate and every worksheet and the answer only matters at that moment.
 * The definition's index is counted past the first sample's real parameters,
 * which is the reading `derivedStore` shifts by.
 */
function derivedUsage(
  id: string,
  defs: DerivedParameterDef[],
  samples: Sample[],
): { gates: string[]; plots: number } {
  const real = samples[0]?.parsed.metadata.parameters.length;
  const k = defs.findIndex((d) => d.id === id);
  if (real === undefined || k < 0) return { gates: [], plots: 0 };
  return {
    gates: gatesUsingParameter(real + k).map((g) => g.name),
    plots: panelsUsingParameter(real + k).length,
  };
}

function DefinitionRow({
  def, realNames, siblings, samples, onEdit, usage, onRemove,
}: {
  def: DerivedParameterDef;
  realNames: string[];
  siblings: DerivedParameterDef[];
  samples: Sample[];
  onEdit: () => void;
  usage: () => { gates: string[]; plots: number };
  onRemove: () => void;
}) {
  /*
     Removing a parameter something still reads asks first, and says what goes.

     Every other index moves with the removal (`state/parameterShift.ts`); the
     gates *on* this one have nothing left to be drawn on and are deleted, and
     plots of it return to their sample's default axes. Silently doing either
     would be the defect this replaced in a quieter form — a gate missing with no
     reason given.
  */
  const [confirm, setConfirm] = useState<{ gates: string[]; plots: number } | null>(null);
  const requestRemove = () => {
    const u = usage();
    if (u.gates.length === 0 && u.plots === 0) onRemove();
    else setConfirm(u);
  };

  if (confirm) {
    const what = [
      confirm.gates.length > 0
        ? `${confirm.gates.length} gate${confirm.gates.length === 1 ? '' : 's'} (${confirm.gates.slice(0, 4).join(', ')}${confirm.gates.length > 4 ? '…' : ''})`
        : null,
      confirm.plots > 0 ? `${confirm.plots} plot${confirm.plots === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' and ');
    return (
      <div className="flex items-center gap-3 px-2 py-1.5 rounded-[var(--radius-sm)] border border-[var(--status-warn)]">
        <Trash2 size={12} className="shrink-0 text-[var(--status-warn)]" />
        <p className="min-w-0 flex-1 text-xs text-[var(--text-primary)]">
          {def.name} is used by {what}. Removing it deletes those gates and resets those plots to their default axes.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
        <Button size="sm" variant="danger" onClick={() => { setConfirm(null); onRemove(); }}>Remove</Button>
      </div>
    );
  }

  // Re-validated on every render rather than stored: the detectors it references
  // belong to whichever files are loaded, so a definition that was valid when it
  // was written can stop being valid when a different set is opened. Saying so
  // here beats a column of NaN on a plot with no explanation.
  const check = validateDefinition(def, realNames, siblings);
  const range = useDerivedRange(def, siblings, samples);

  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-2 py-1.5 rounded-[var(--radius-sm)]',
        'border border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]',
      )}
    >
      <Sigma size={12} className={cn('shrink-0', check.ok ? 'text-[var(--text-accent)]' : 'text-[var(--status-err)]')} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--text-primary)] truncate">{def.name}</p>
        <p className="font-mono text-[10px] text-[var(--text-tertiary)] truncate" title={def.expression}>
          {def.expression}
        </p>
        {!check.ok && <p className="text-[10px] text-[var(--status-err)] mt-0.5">{check.error}</p>}
      </div>
      {range && (
        <span className="font-mono tnum text-[10px] text-[var(--text-tertiary)] shrink-0" title="Measured range over the selected sample">
          [{fmt(range.min)}, {fmt(range.max)}]
        </span>
      )}
      <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <Tooltip content="Edit">
          <IconButton label={`Edit ${def.name}`} size="sm" onClick={onEdit}><Pencil size={12} /></IconButton>
        </Tooltip>
        <Tooltip content="Remove">
          <IconButton label={`Remove ${def.name}`} size="sm" onClick={requestRemove}><Trash2 size={12} /></IconButton>
        </Tooltip>
      </span>
    </div>
  );
}

/**
 * Measured extent of a definition over the selected sample.
 *
 * A derived parameter has no `$PnR` to declare its range, so the axis domain
 * comes from the computed column — which means this number is exactly the one
 * the plot will frame itself with. The column is cached against the sample by
 * `derivedStore`, so reading it here costs nothing the first plot would not have
 * paid anyway.
 */
function useDerivedRange(
  def: DerivedParameterDef,
  defs: DerivedParameterDef[],
  samples: Sample[],
): { min: number; max: number } | null {
  const sample = useWorkspace(selectedSample) ?? samples[0] ?? null;
  return useMemo(() => {
    if (!sample) return null;
    const index = sample.parsed.metadata.parameters.length + defs.findIndex((d) => d.id === def.id);
    if (index < sample.parsed.metadata.parameters.length) return null;
    const col = sampleColumn(sample.parsed, index, defs);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < col.length; i++) {
      const v = col[i]!;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return Number.isFinite(min) ? { min, max } : null;
  }, [sample, def.id, defs]);
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
