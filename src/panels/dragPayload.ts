/**
 * What a drag carries, and what is in flight right now.
 *
 * **Mechanism: native HTML5 drag-and-drop**, reusing what the app already does
 * rather than adding a second drag implementation. Two precedents settled it:
 * `GateTree`'s rows are already `draggable` with `onDragStart`/`onDrop` for
 * reparenting, and `SampleBrowser` already accepts native drops for OS file
 * import. The pointer-capture dragging in `GateLayer` is deliberately *not* the
 * model here — that is continuous manipulation of a shape inside one canvas,
 * where every intermediate coordinate matters. Moving an item between two panes
 * is a transfer, and the platform already implements transfer: cross-element
 * hit-testing, the drop-effect cursor, and Escape-to-cancel all come free and
 * all behave the way the OS does elsewhere.
 *
 * Two things the native API does badly, handled here:
 *
 * 1. `dataTransfer.getData()` returns nothing during `dragover` — only on drop.
 *    A drop target that wants to highlight itself mid-drag therefore cannot read
 *    the payload. Distinct MIME types make the *kind* readable from
 *    `dataTransfer.types`, and `useDragState` holds the detail for anything that
 *    needs more than the kind.
 * 2. The default drag image is a washed-out screenshot of the source row.
 *    `setDragImage` with a purpose-built element replaces it.
 */

import { create } from 'zustand';

/** Distinct types so `dragover` can discriminate without reading data. */
export const SAMPLE_MIME = 'application/x-mcflow-sample';
export const GATE_MIME = 'application/x-mcflow-gate';

/** Dragging one or more samples out of the sidebar. */
export interface SampleDrag {
  kind: 'sample';
  /** Every sample in the drag. A multi-selection drops as one panel each. */
  sampleIds: string[];
}

/** Dragging a population out of the gate tree. */
export interface GateDrag {
  kind: 'gate';
  /**
   * Which sample's tree this gate belongs to.
   *
   * Carried explicitly rather than resolved at drop time: the same strategy can
   * be copied across a group, so a bare gate id is ambiguous. The tree that
   * started the drag knows which sample it is showing, and that is the one the
   * user meant.
   */
  sampleId: string;
  gateId: string;
  gateName: string;
  /** Palette index, so the drag ghost carries the population's own colour. */
  colorIndex: number;
  /**
   * The plot this gate was dragged off, when it was dragged off one.
   *
   * A drop opens the new plot on this panel's axes (2026-08-12, Item 10).
   * Absent from a drag that started in the sidebar's gate tree, which names a
   * population and no plot — the active panel answers for those.
   */
  sourcePanelId?: string | null;
}

export type DragPayload = SampleDrag | GateDrag;

const MIME_FOR: Record<DragPayload['kind'], string> = {
  sample: SAMPLE_MIME,
  gate: GATE_MIME,
};

/* -------------------------------------------------------------------------
   Encoding
   ------------------------------------------------------------------------- */

/**
 * Attach a payload to a native drag.
 *
 * Also written as `text/plain`, so dragging a population into a text field or
 * another application produces its name rather than nothing.
 */
export function setDragPayload(dt: DataTransfer, payload: DragPayload, label: string): void {
  dt.effectAllowed = 'copy';
  try {
    dt.setData(MIME_FOR[payload.kind], JSON.stringify(payload));
    dt.setData('text/plain', label);
  } catch {
    // Some environments lock dataTransfer outside a real user gesture; the
    // in-flight store below still carries the drag, so this is not fatal.
  }
}

/** Read a payload back on drop. Returns null when the drag is not ours. */
export function readDragPayload(dt: DataTransfer): DragPayload | null {
  for (const mime of [SAMPLE_MIME, GATE_MIME]) {
    const raw = dt.getData(mime);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as DragPayload;
      if (parsed?.kind === 'sample' && Array.isArray(parsed.sampleIds)) return parsed;
      if (parsed?.kind === 'gate' && typeof parsed.gateId === 'string') return parsed;
    } catch {
      // Malformed payload: treat as a foreign drag rather than throwing inside
      // a drop handler, where the exception would be invisible.
    }
  }
  return null;
}

/**
 * Is this drag one of ours?
 *
 * Type list only, so it works during `dragover` where the data is unreadable.
 * Used to keep the sidebar's file-import overlay from firing on an internal
 * drag, and to light up drop targets.
 */
export function isInternalDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return [...dt.types].some((t) => t === SAMPLE_MIME || t === GATE_MIME);
}

/* -------------------------------------------------------------------------
   In-flight state
   ------------------------------------------------------------------------- */

interface DragState {
  /** The drag currently in progress, or null. */
  payload: DragPayload | null;
  begin(p: DragPayload): void;
  end(): void;
}

/**
 * The drag in flight.
 *
 * Exists because drop targets have to decide how to render *before* the drop —
 * and `dragover` cannot read the payload. Cleared on `dragend`, which the
 * browser fires for a cancelled drag (Escape, or a release over nothing) just as
 * it does for a completed one, so a cancel leaves no residue.
 */
export const useDragState = create<DragState>((set) => ({
  payload: null,
  begin: (payload) => set({ payload }),
  end: () => set({ payload: null }),
}));

/* -------------------------------------------------------------------------
   Drag ghost
   ------------------------------------------------------------------------- */

/**
 * Replace the browser's default drag image with a small labelled chip.
 *
 * The element has to be in the document for `setDragImage` to rasterise it, so
 * it is parked off-screen and removed on the next tick — by which point the
 * browser has taken its snapshot.
 */
export function setDragGhost(dt: DataTransfer, label: string, color?: string, count?: number): void {
  if (typeof document === 'undefined') return;

  const chip = document.createElement('div');
  chip.setAttribute('data-drag-ghost', '');
  chip.style.cssText = [
    'position:fixed', 'top:-1000px', 'left:-1000px',
    'display:flex', 'align-items:center', 'gap:6px',
    'padding:5px 9px',
    'border-radius:var(--radius-sm)',
    'border:1px solid var(--border-strong)',
    'background:var(--surface-overlay)',
    'box-shadow:var(--shadow-overlay)',
    'font:500 11px/1 var(--font-sans, system-ui)',
    'color:var(--text-primary)',
    'white-space:nowrap',
    'pointer-events:none',
  ].join(';');

  if (color) {
    const swatch = document.createElement('span');
    swatch.style.cssText = `width:8px;height:8px;border-radius:2px;background:${color};flex:none`;
    chip.appendChild(swatch);
  }

  chip.appendChild(document.createTextNode(label));

  if (count && count > 1) {
    const badge = document.createElement('span');
    badge.textContent = `+${count - 1}`;
    badge.style.cssText = [
      'padding:1px 4px', 'border-radius:3px',
      'background:var(--accent-500)', 'color:#fff',
      'font-size:9px', 'font-variant-numeric:tabular-nums',
    ].join(';');
    chip.appendChild(badge);
  }

  document.body.appendChild(chip);
  // Offset from the cursor so the chip trails it rather than sitting under it.
  dt.setDragImage(chip, -12, -6);
  setTimeout(() => chip.remove(), 0);
}
