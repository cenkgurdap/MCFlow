/**
 * Viridis, as a 256-entry lookup table.
 *
 * Transcribed from matplotlib's `_viridis_data` (lib/matplotlib/_cm_listed.py),
 * the reference implementation of the colormap Smith & van der Walt designed
 * for the 2015 SciPy talk. Embedded verbatim rather than re-derived: viridis is
 * perceptually uniform in CIELAB, and that property comes from the exact
 * sampling of the path through colour space. A seven-stop hand-tuned
 * approximation interpolated in sRGB — which is what the bespoke ramps here are
 * — reproduces the hues and loses the uniformity, which is the only reason to
 * use viridis in the first place.
 *
 * Packed as hex bytes because 256 numeric triples in source are no more
 * readable than this and far easier to corrupt in an edit. The anchors
 * (#440154, #21918c, #fde725) and monotonic lightness are asserted in
 * render.test.ts, so a damaged table fails the suite rather than shipping.
 */

const VIRIDIS_HEX =
  '44015444025645045745055946075a46085c460a5d460b5e470d60470e6147106347116447136548146748166848176948186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a' +
  '472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f854240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b' +
  '3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e' +
  '2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d' +
  '21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f881fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad81' +
  '28ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc743fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc863' +
  '5ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32' +
  'addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21ad8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725';

/** Unpack a table of six-hex-digit sRGB triples. Shared with `cividis.ts`. */
export function decodeHexLut(hex: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < hex.length; i += 6) {
    out.push([
      Number.parseInt(hex.slice(i, i + 2), 16),
      Number.parseInt(hex.slice(i + 2, i + 4), 16),
      Number.parseInt(hex.slice(i + 4, i + 6), 16),
    ]);
  }
  return out;
}

/** 256 sRGB triples, dark purple through teal and green to yellow. */
export const VIRIDIS: Array<[number, number, number]> = decodeHexLut(VIRIDIS_HEX);

/**
 * Relative luminance, 0–1, per WCAG 2.x — sRGB gamma removed, then weighted.
 *
 * Used to check a ramp rises monotonically in lightness. A ramp that dips
 * partway reads as two populations where the data holds one, which is exactly
 * the failure viridis was designed to avoid and the reason it is worth
 * asserting rather than assuming.
 */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
