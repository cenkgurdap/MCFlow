import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  Moon,
  PanelLeft,
  PanelRight,
  Sun,
} from 'lucide-react';
import { useUI } from '@/state/uiStore';
import { useZoom } from '@/state/zoomStore';
import { platform } from '@/platform';
import { windowControlsInset } from '@/core/layout/windowControls';
import { IconButton } from '@/ui/Button';
import { Splitter } from '@/ui/Splitter';
import { Tooltip, Kbd } from '@/ui/Tooltip';
import { VDivider } from '@/ui/Panel';
import { cn } from '@/ui/cn';
import { CommandPalette } from './CommandPalette';
import { ZoomControl } from './ZoomControl';
import { useNativeEvents } from './useNativeEvents';
import { useUndoRedo } from './useUndoRedo';

/**
 * The application frame: top bar / left sidebar / center canvas / right
 * inspector / status bar. Regions are flush and separated by hairlines so the
 * whole window reads as one instrument rather than a set of floating windows.
 */
export function AppShell({
  topBarCenter,
  topBarRight,
  sidebar,
  center,
  inspector,
  statusLeft,
  statusRight,
}: {
  topBarCenter?: ReactNode;
  topBarRight?: ReactNode;
  sidebar: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
  statusLeft?: ReactNode;
  statusRight?: ReactNode;
}) {
  const {
    theme, toggleTheme,
    sidebarWidth, inspectorWidth,
    sidebarCollapsed, inspectorCollapsed,
    setSidebarWidth, setInspectorWidth,
    toggleSidebar, toggleInspector,
    setCommandPaletteOpen,
  } = useUI();

  const rootRef = useRef<HTMLDivElement>(null);

  /*
     The strip macOS paints its traffic lights into — see
     `core/layout/windowControls.ts`. Zero on Windows, on Linux and in a browser
     tab, so the header below is unchanged there; it is subscribed to the zoom
     because the buttons are AppKit's and do not scale with Chromium's.
  */
  const zoom = useZoom((s) => s.zoom);
  const controlsInset = windowControlsInset(platform().overlaysWindowControls, zoom);

  // Native menu items and shell file-opens drive the same store actions.
  useNativeEvents();
  // Ctrl+Z / Ctrl+Shift+Z, plus the Edit menu's route to the same functions.
  useUndoRedo();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        if (e.shiftKey) toggleInspector();
        else toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCommandPaletteOpen, toggleSidebar, toggleInspector]);

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col overflow-hidden bg-[var(--surface-base)]">
      {/* ---------------- Top bar ---------------- */}
      <header
        className="flex items-center gap-2 shrink-0 px-2 hairline-b bg-[var(--surface-base)]"
        style={{ height: 'var(--h-topbar)' }}
      >
        {/*
            Reserved rather than padded onto the header, and draggable.

            A spacer keeps the reservation visible in the DOM — `data-window-
            controls` is what a harness measures, and `width: 0` is the honest
            statement of "this OS reserves nothing" rather than an absent element
            that has to be distinguished from a broken one. `drag-region` because
            `hiddenInset` removes the native title bar along with the strip you
            drag a window by: without it the reserved gap is a dead zone next to
            the buttons, which is the one place on a Mac a window is always
            dragged from. Every control in this header is a sibling, so none of
            them inherits it.
        */}
        <div
          data-window-controls=""
          aria-hidden
          className="shrink-0 self-stretch drag-region"
          style={{ width: controlsInset }}
        />
        <Wordmark />
        <VDivider className="mx-1" />
        <Tooltip content={<span className="flex items-center gap-1.5">Toggle sample browser <Kbd>Ctrl</Kbd><Kbd>\</Kbd></span>}>
          <IconButton label="Toggle sample browser" size="md" active={!sidebarCollapsed} onClick={toggleSidebar}>
            <PanelLeft size={15} />
          </IconButton>
        </Tooltip>

        <div className="flex-1 min-w-0 flex items-center justify-center gap-2">{topBarCenter}</div>

        <div className="flex items-center gap-1 shrink-0">
          {topBarRight}
          {/*
              Label, then shortcut. Nothing else.

              This carried a `Command` glyph on the left and a `⌘K` chip on the
              right, which is two problems in 28 pixels. The glyph is the macOS
              command symbol and this is a Windows application, so it named a key
              that is not on the keyboard; and it sat where an icon-button's icon
              sits, so the control read as an icon with a caption rather than as
              the labelled button it is. The chip said `⌘K` for the same reason
              and had the same problem — the accelerator is **Ctrl+K**, which is
              what the Edit menu shows and what the key handler above listens
              for.

              `hidden md:inline` is gone with the icon: it was the fallback for a
              narrow window, and a button whose only remaining content is its
              label cannot afford to hide it.
          */}
          <Tooltip content={<span className="flex items-center gap-1.5">Search <Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>}>
            <button
              onClick={() => setCommandPaletteOpen(true)}
              data-search-button=""
              className={cn(
                'flex items-center gap-2 h-[var(--h-control)] pl-2.5 pr-1.5 rounded-[var(--radius-sm)]',
                'border border-[var(--border-default)] bg-[var(--surface-sunken)]',
                'text-2xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border-strong)]',
                'transition-colors duration-[var(--dur-fast)]',
              )}
            >
              <span>Search</span>
              <Kbd className="ml-2">Ctrl+K</Kbd>
            </button>
          </Tooltip>
          <VDivider className="mx-1" />
          <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {/* "Switch theme", not "Toggle theme" — the same words the View menu
                uses, since they are two routes to one action. */}
            <IconButton label="Switch theme" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </IconButton>
          </Tooltip>
          <Tooltip content={<span className="flex items-center gap-1.5">Toggle inspector <Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>\</Kbd></span>}>
            <IconButton label="Toggle inspector" active={!inspectorCollapsed} onClick={toggleInspector}>
              <PanelRight size={15} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      {/* ---------------- Body ---------------- */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!sidebarCollapsed && (
          <>
            <aside
              className="flex flex-col min-h-0 shrink-0 bg-[var(--surface-sunken)]"
              style={{ width: sidebarWidth }}
            >
              {sidebar}
            </aside>
            <Splitter side="left" onResize={(x) => setSidebarWidth(x)} />
          </>
        )}

        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--surface-base)]">{center}</main>

        {!inspectorCollapsed && (
          <>
            <Splitter
              side="right"
              onResize={(x) => setInspectorWidth(window.innerWidth - x)}
            />
            <aside
              className="flex flex-col min-h-0 shrink-0 bg-[var(--surface-sunken)]"
              style={{ width: inspectorWidth }}
            >
              {inspector}
            </aside>
          </>
        )}
      </div>

      {/* ---------------- Status bar ---------------- */}
      <footer
        className="flex items-center gap-3 shrink-0 px-2.5 hairline-t bg-[var(--surface-sunken)] text-2xs text-[var(--text-tertiary)] select-none"
        style={{ height: 'var(--h-statusbar)' }}
      >
        <div className="flex items-center gap-3 min-w-0">{statusLeft}</div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {statusRight}
          <VDivider />
          {/* Last thing in the bottom-right corner, which is where a window
              zoom lives in every desktop application including the one this
              app is compared against. */}
          <ZoomControl />
        </div>
      </footer>

      <CommandPalette />
    </div>
  );
}

/**
 * Wordmark — the real brand mark, and the same asset the OS shows.
 *
 * This used to be a hand-coded SVG density contour written inline here: a
 * Stage 1 stand-in, drawn in the accent colour, and a reasonable one while
 * there was nothing to stand in for. `Logo.png` arrived on 2026-08-03 and the
 * branding work that followed regenerated every *asset* from it — the .ico, the
 * 1024 px master, the splash — and missed this one, because it was not an asset.
 * It was a component, so nothing that regenerates assets could have caught it,
 * and re-running `npm run icon` reported everything current while the mark at
 * the top left of the window was still the placeholder.
 *
 * So the header now draws `public/mark.png`, which `make-icon.mjs` emits from
 * the same `draw()` call as the icon it hands the operating system. The header
 * mark, the title-bar icon, the taskbar icon and the installer's icon are one
 * function's output at four sizes; they cannot disagree, and re-running the
 * script is what updates all four.
 *
 * Fixed 17 px rather than a CSS size on an intrinsically-64 px image: the plate
 * has a 1 px hairline that goes soft if the browser resamples to a fractional
 * box, and `--h-topbar` is fixed anyway.
 */
function Wordmark() {
  return (
    <div className="flex items-center gap-2 pl-1 pr-1 shrink-0 select-none">
      <img
        src="./mark.png"
        alt=""
        aria-hidden
        width={17}
        height={17}
        data-app-mark=""
        className="shrink-0 rounded-[3px]"
        style={{ width: 17, height: 17 }}
      />
      <span className="text-sm font-semibold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
        MCFlow
      </span>
    </div>
  );
}

/** A status-bar cell. Keeps spacing and colour consistent across items. */
export function StatusItem({
  icon,
  children,
  tone,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: 'ok' | 'warn' | 'err' | 'accent';
  title?: string;
}) {
  const color =
    tone === 'ok' ? 'text-[var(--status-ok)]'
      : tone === 'warn' ? 'text-[var(--status-warn)]'
        : tone === 'err' ? 'text-[var(--status-err)]'
          : tone === 'accent' ? 'text-[var(--text-accent)]'
            : '';
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', color)}>
      {icon}
      {children}
    </span>
  );
}
