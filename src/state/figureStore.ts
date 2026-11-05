import { create } from 'zustand';
import {
  defaultStyleFor, FIGURE_KINDS, normaliseStyle,
  type FigureKind, type FigurePreset, type FigureStyle,
} from '@/core/figure/style';

/**
 * How figures are exported, on this machine.
 *
 * ## Why it is a store, and why it is not workspace state (2026-10-22)
 *
 * Every exporter in the application — plots, the Compare chart, UMAP, the
 * spectrum and signature plots — draws in one `FigureStyle`, and that style is
 * a statement about where the figure is going (this journal's column, this
 * typeface), not about the experiment. It is kept in `localStorage`, like the
 * theme and the zoom: per machine, not saved in a workspace, not synced between
 * windows, not undoable. A workspace opened by a colleague exports in their
 * journal's style, which is the right answer.
 *
 * Three things live here:
 *
 *   - **one style per figure type** (`FIGURE_KINDS`, 0.35), each persisted under
 *     its own key, so a setting changed for a density plot never reaches the
 *     Compare chart. Only the typeface and the width are shared: changing
 *     either writes it into every type (`SHARED`);
 *   - the **user's presets** — named styles, applied to the type being exported;
 *   - **condition colours** the user has overridden, keyed by the category's
 *     name. A category is coloured by its position in the order shown
 *     (`panels/groupColors.ts`) unless its name has an entry here, so a colour
 *     given to *condition B* follows *condition B* into every figure that draws it.
 *
 * Every read goes through `normaliseStyle`, so a preset written by an older
 * build — or edited by hand — opens as close to what was saved as it can be and
 * never as something a composer cannot draw.
 */

/** The 0.34 single style — read once, as every type's starting point. */
const LEGACY_STYLE_KEY = 'mcflow.figure.style';
const styleKey = (kind: FigureKind) => `mcflow.figure.style.${kind}`;
const PRESETS_KEY = 'mcflow.figure.presets';
const COLORS_KEY = 'mcflow.figure.conditionColors';

/** A CSS hex colour, the only kind an override may hold. */
const HEX = /^#[0-9a-f]{6}$/i;

function read(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Blocked storage or a hand-edited value that is not JSON: the defaults
    // are the honest answer, and the export panel still works.
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable — the setting lasts for this session */ }
}

function readPresets(): FigurePreset[] {
  const raw = read(PRESETS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { name: string; style: unknown } => !!p && typeof p.name === 'string' && p.name.trim() !== '')
    .map((p) => ({ name: p.name.trim().slice(0, 80), style: normaliseStyle(p.style) }));
}

function readColors(): Record<string, string> {
  const raw = read(COLORS_KEY);
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && HEX.test(value)) out[name] = value.toLowerCase();
  }
  return out;
}

type Section<K extends keyof FigureStyle> = Partial<FigureStyle[K]>;

/** The settings every figure type shares; everything else is per type. */
function withShared(style: FigureStyle, from: FigureStyle): FigureStyle {
  return {
    ...style,
    font: { ...style.font, family: from.font.family },
    size: { ...style.size, widthMm: from.size.widthMm },
  };
}

function readStyles(): Record<FigureKind, FigureStyle> {
  const legacy = read(LEGACY_STYLE_KEY);
  const out = {} as Record<FigureKind, FigureStyle>;
  for (const kind of FIGURE_KINDS) {
    const raw = read(styleKey(kind)) ?? legacy;
    out[kind] = raw ? normaliseStyle(raw) : defaultStyleFor(kind);
  }
  return out;
}

interface FigureState {
  /** One style per figure type. */
  styles: Record<FigureKind, FigureStyle>;
  presets: FigurePreset[];
  conditionColors: Record<string, string>;

  /** Change one section of one type's style; the typeface and width reach every type. */
  updateStyle<K extends keyof FigureStyle>(kind: FigureKind, section: K, patch: Section<K>): void;
  setStyle(kind: FigureKind, style: FigureStyle): void;
  /** One type back to its defaults, keeping the shared typeface and width. */
  resetStyle(kind: FigureKind): void;
  /** The same section patch on every type — for harnesses setting up a known state. */
  updateAll<K extends keyof FigureStyle>(section: K, patch: Section<K>): void;
  /** Every type back to its defaults, shared settings included. */
  resetAll(): void;
  applyPreset(kind: FigureKind, name: string): boolean;
  savePreset(kind: FigureKind, name: string): void;
  deletePreset(name: string): void;
  /** Give a category a colour of its own, or `null` to return it to its position's. */
  setConditionColor(name: string, color: string | null): void;
}

export const useFigure = create<FigureState>((set, get) => {
  const commit = (styles: Record<FigureKind, FigureStyle>, changed: readonly FigureKind[]) => {
    for (const k of changed) write(styleKey(k), styles[k]);
    set({ styles });
  };
  return {
    styles: readStyles(),
    presets: readPresets(),
    conditionColors: readColors(),

    updateStyle(kind, section, patch) {
      const cur = get().styles[kind];
      const next = normaliseStyle({ ...cur, [section]: { ...cur[section], ...patch } });
      const shared = (section === 'font' && 'family' in patch) || (section === 'size' && 'widthMm' in patch);
      const styles = { ...get().styles, [kind]: next };
      if (shared) for (const k of FIGURE_KINDS) styles[k] = withShared(styles[k], next);
      commit(styles, shared ? FIGURE_KINDS : [kind]);
    },

    setStyle(kind, style) {
      commit({ ...get().styles, [kind]: withShared(normaliseStyle(style), get().styles[kind]) }, [kind]);
    },

    resetStyle(kind) {
      commit({ ...get().styles, [kind]: withShared(defaultStyleFor(kind), get().styles[kind]) }, [kind]);
    },

    updateAll(section, patch) {
      for (const k of FIGURE_KINDS) get().updateStyle(k, section, patch);
    },

    resetAll() {
      const styles = {} as Record<FigureKind, FigureStyle>;
      for (const k of FIGURE_KINDS) styles[k] = defaultStyleFor(k);
      commit(styles, FIGURE_KINDS);
    },

    applyPreset(kind, name) {
      const found = get().presets.find((p) => p.name === name);
      if (!found) return false;
      get().setStyle(kind, found.style);
      return true;
    },

    savePreset(kind, name) {
      const clean = name.trim().slice(0, 80);
      if (!clean) return;
      const presets = [...get().presets.filter((p) => p.name !== clean), { name: clean, style: get().styles[kind] }];
      write(PRESETS_KEY, presets);
      set({ presets });
    },

    deletePreset(name) {
      const presets = get().presets.filter((p) => p.name !== name);
      write(PRESETS_KEY, presets);
      set({ presets });
    },

    setConditionColor(name, color) {
      const next = { ...get().conditionColors };
      if (color && HEX.test(color)) next[name] = color.toLowerCase();
      else delete next[name];
      write(COLORS_KEY, next);
      set({ conditionColors: next });
    },
  };
});
