import { describe, expect, it } from 'vitest';
import { estimateTextWidth, LABEL_MARGIN, placeGateLabel } from './gateLabelPlacement';

/*
   The property every one of these is really asserting: **no part of the caption
   is outside the plot.** So each case computes the text's own left and right
   edges from the returned anchor and checks the pair, rather than checking that
   `x` happens to equal a particular number — which is the "assert on a proxy"
   trap this project keeps recording. `x` is not what the reader sees; the glyphs
   are.
*/
function edges(lines: string[], place: ReturnType<typeof placeGateLabel>, fontSize = 10) {
  const w = Math.max(0, ...lines.map((l) => estimateTextWidth(l, fontSize)));
  if (place.anchor === 'middle') return { left: place.x - w / 2, right: place.x + w / 2 };
  if (place.anchor === 'end') return { left: place.x - w, right: place.x };
  return { left: place.x, right: place.x + w };
}

describe('placeGateLabel', () => {
  const plotW = 340;

  it('centres a caption with room either side', () => {
    const lines = ['CD4 RB744 +', '20.0%'];
    const place = placeGateLabel({ center: 170, plotW, lines });
    expect(place.anchor).toBe('middle');
    expect(place.x).toBe(170);
  });

  it('pins to the right edge rather than letting the text overflow it', () => {
    // The real case: an unbounded positive gate, whose visible band runs from
    // the threshold to the right-hand edge, so its middle is far right.
    const lines = ['CD4 RB744 +', '20.0%'];
    const place = placeGateLabel({ center: 320, plotW, lines });
    expect(place.anchor).toBe('end');
    expect(edges(lines, place).right).toBeLessThanOrEqual(plotW - LABEL_MARGIN);
  });

  it('pins to the left edge for a band against the left-hand side', () => {
    const lines = ['CD4 RB744 −', '80.0%'];
    const place = placeGateLabel({ center: 6, plotW, lines });
    expect(place.anchor).toBe('start');
    expect(edges(lines, place).left).toBeGreaterThanOrEqual(0);
  });

  it('keeps every caption inside the plot at every band position', () => {
    const lines = ['LiveDead Live or Dye 750-777 +', '12.3%'];
    for (let center = -60; center <= plotW + 60; center += 4) {
      const place = placeGateLabel({ center, plotW, lines });
      const { left, right } = edges(lines, place);
      expect(left).toBeGreaterThanOrEqual(-0.001);
      expect(right).toBeLessThanOrEqual(plotW + 0.001);
    }
  });

  it('start-aligns a caption too wide for the plot, so the name survives', () => {
    const lines = ['A very long fluorophore identity indeed that will not fit'];
    const place = placeGateLabel({ center: 170, plotW: 120, lines });
    expect(place.anchor).toBe('start');
    expect(place.x).toBe(LABEL_MARGIN);
  });

  it('measures the widest line, not the last one', () => {
    const wide = ['CCR7 APC-Fire 810 +', '4.1%'];
    const narrow = ['CD3 +', '4.1%'];
    // Same centre: the wider caption has to give way sooner.
    expect(placeGateLabel({ center: 300, plotW, lines: wide }).anchor).toBe('end');
    expect(placeGateLabel({ center: 300, plotW, lines: narrow }).anchor).toBe('middle');
  });
});
