/**
 * What colour a population is drawn in — read from the gate it is.
 *
 * ## Why (2026-10-22)
 *
 * The fit chart, the worksheet's fit overlay, the Step 4 legend and the gates
 * themselves each worked out a population's colour on their own: the charts
 * from the population's index, the gate band from its `colorIndex`, the gate's
 * boundary line from the theme's ink. On a three-population histogram that was
 * three renderings of one region in three colours — a grey-looking 5% tint, a
 * caption in the population hue and a thick black boundary — and nothing a
 * reader could match to the legend.
 *
 * The rule now: **a region has one hue, and it is its gate's.** `gateHue` is
 * the colour a gate was given in the tree, or its population palette entry when
 * it was given none, and every surface that draws a population asks for it
 * through here. Recolouring a gate recolours it on every chart, and a
 * workspace made before Biophysics assigned colours by role keeps the colours
 * its gates were made in.
 */
import { populationColor } from '@/core/biophysics/properties';
import type { BiophysicsSample } from '@/core/biophysics/pipeline';
import type { Gate } from '@/core/gating/types';

/** A population palette entry, as the custom property each theme defines it by. */
export function popVar(index: number): string {
  return `var(--pop-${String((Math.max(0, Math.floor(index)) % 12) + 1).padStart(2, '0')})`;
}

/** A gate's one hue: the colour it was given, or its population palette entry. */
export function gateHue(g: Pick<Gate, 'color' | 'colorIndex'>): string {
  return g.color ?? popVar(g.colorIndex);
}

/**
 * Each of a fit's populations, in the colour of the gate it became — or, where
 * there is no gate to ask (a fit not yet turned into gates), the colour such a
 * gate would be created in.
 */
export function populationColors(
  record: Pick<BiophysicsSample, 'populationGateIds'> | undefined,
  gates: readonly Gate[],
  count: number,
): string[] {
  return Array.from({ length: count }, (_, i) => {
    const id = record?.populationGateIds[i];
    const g = id ? gates.find((x) => x.id === id) : undefined;
    return g ? gateHue(g) : populationColor(i, count);
  });
}
