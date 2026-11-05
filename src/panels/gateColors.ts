/**
 * The colours a gate outline can be set to.
 *
 * **Curated, not a picker.** A full RGB well lets somebody choose a colour that
 * cannot be seen on this plot surface, and the whole reason the default follows
 * the theme is that legibility on `#0a0c10` and on `#ffffff` is not something a
 * user should have to reason about mid-analysis. Sixteen swatches is enough to
 * tell a dozen gates apart and few enough that every one of them has been looked
 * at against both themes.
 *
 * ## How these were chosen
 *
 * Two neutrals first, because they are the honest answer most of the time: the
 * default is the theme's own ink, and the two explicit neutrals are there for
 * someone who wants to pin a gate to black or white regardless of theme — for a
 * figure that will be printed, say.
 *
 * The rest are the population palette's hues, lifted in value and pulled off
 * their gamut corners. A gate outline is a 1.75 px line with a casing behind it,
 * which is a much smaller area than a tree chip: the palette colours that read
 * fine as an 8 px square are too dark to follow as a hairline over a dense
 * plot. Every one of these has a relative luminance above 0.28, which is what
 * keeps it distinguishable from the dark theme's plot surface, and each carries
 * enough saturation to stay distinct from the neutrals on the light one.
 */
export interface GateSwatch {
  /** CSS colour written onto `Gate.color`. */
  value: string;
  label: string;
}

/**
 * `null` is the default and is offered first: the theme's ink, black on the
 * light theme and near-white on the dark one, which is the only entry that is
 * correct on both without being chosen.
 */
export const GATE_COLOR_SWATCHES: GateSwatch[] = [
  { value: '#f2f5f8', label: 'White' },
  { value: '#0b0f16', label: 'Black' },
  { value: '#ff5a5a', label: 'Red' },
  { value: '#ff8f3f', label: 'Orange' },
  { value: '#ffc53d', label: 'Amber' },
  { value: '#ffe95c', label: 'Yellow' },
  { value: '#9ede4f', label: 'Lime' },
  { value: '#4fd67c', label: 'Green' },
  { value: '#3fd9c0', label: 'Teal' },
  { value: '#45cdd9', label: 'Cyan' },
  { value: '#4fa8ff', label: 'Blue' },
  { value: '#7d8cff', label: 'Indigo' },
  { value: '#b07dff', label: 'Violet' },
  { value: '#e070d8', label: 'Magenta' },
  { value: '#ff6fa8', label: 'Pink' },
  { value: '#c9a27a', label: 'Tan' },
];

/** The label for a stored colour, for a tooltip. Unknown values keep their hex. */
export function gateColorLabel(color: string | undefined): string {
  if (!color) return 'Follows the theme';
  return GATE_COLOR_SWATCHES.find((s) => s.value.toLowerCase() === color.toLowerCase())?.label ?? color;
}
