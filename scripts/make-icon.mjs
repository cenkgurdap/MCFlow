/**
 * Generates the application icon from `Logo.png`.
 *
 *   npm run icon
 *
 * The icon **is** the brand mark now (2026-08-03, Item 16). It used to be a
 * hand-drawn density contour written as canvas calls in this file — a stand-in,
 * and a reasonable one while there was nothing to stand in for. There is now, so
 * the drawing code is gone and this rasterises the real artwork instead.
 *
 * Two things have to happen to a logo before it can be an icon, and both are
 * done here rather than by hand so re-running this after the artwork changes
 * produces a correct result rather than a stale crop:
 *
 *   1. **Crop to the mark.** `Logo.png` is a lockup — the emblem above, the
 *      wordmark below. At 16 px a wordmark is four grey pixels, so the icon uses
 *      the emblem alone. The crop is *measured* rather than typed in: the script
 *      finds the bounding box of everything that is not the background colour,
 *      over the top of the image only. A typed crop box silently becomes wrong
 *      the first time the artwork is re-exported at a different size.
 *
 *      **It keeps the emblem's own shape and letterboxes it onto the plate**
 *      rather than squaring the crop. Squaring means reaching outside the
 *      measured box, and for a wide mark what is out there is the wordmark and
 *      the edge of the canvas — see the note at the crop itself.
 *
 *   2. **Put it on a plate.** A logo drawn straight onto transparency has no
 *      shape in a taskbar. The plate is white with a hairline edge, because that
 *      is the field the artwork is drawn for — the mark's blues and greens are
 *      chosen against white and lose most of their separation on the app's own
 *      near-black chrome.
 *
 * Electron's own Chromium does the drawing, so there is still no image-processing
 * dependency.
 */
import { app, BrowserWindow } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');
const PUBLIC = join(ROOT, 'public');
const LOGO = join(ROOT, 'Logo.png');
const LOGO_SPLASH = join(ROOT, 'LogoSplash.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();

/**
 * Load the logo, measure the emblem, and draw it at every requested size.
 *
 * Runs as one script in the page so the image is decoded once and the pixel
 * scan happens once, rather than per icon size.
 */
const RENDER = `
(async (src, sizes) => {
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = src; });

  const w = img.naturalWidth, h = img.naturalHeight;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  pg.drawImage(img, 0, 0);
  const px = pg.getImageData(0, 0, w, h).data;

  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i+1], px[i+2], px[i+3]]; };
  // The background, sampled from a corner. The artwork sits on a near-white
  // field rather than on transparency, so "not background" is a colour test.
  const bg = at(2, 2);
  const far = (c) => c[3] > 8 && Math.abs(c[0]-bg[0]) + Math.abs(c[1]-bg[1]) + Math.abs(c[2]-bg[2]) > 60;

  /*
     Where the emblem stops and the wordmark starts.

     NOTE: no backticks anywhere in this comment, for the reason given three
     times below and hit six times in this project.

     This was the top 62% of the image, which is a typed crop box wearing a
     percentage — and it went wrong the first time the artwork was re-exported at
     a different shape. The 2026-08-13 logo is square rather than 3:2, so its
     wordmark begins at about 73% and the old fraction cut straight through the
     emblem own x axis, which is exactly the failure the measured crop below it
     was written to avoid.

     What separates the two halves of a lockup is the gap between them, so that
     is what is measured: the widest run of blank rows lying strictly inside the
     artwork. Blank rows before the first mark and after the last are margin
     rather than a gap, so the search is bounded by the artwork itself. A sparse
     row inside the scatter cloud is a gap too, and a much shorter one — taking
     the widest is what tells them apart without a threshold to tune.

     An emblem with no wordmark under it has no gap at all, and then the whole
     artwork is the mark.
  */
  const rowHas = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (far(at(x, y))) { rowHas[y] = 1; break; }
    }
  }
  let top = 0;
  while (top < h && !rowHas[top]) top++;
  let bottom = h - 1;
  while (bottom > top && !rowHas[bottom]) bottom--;
  if (top >= bottom) throw new Error('found no artwork in Logo.png');

  let run = -1, splitAt = -1, splitLen = 0;
  for (let y = top; y <= bottom; y++) {
    if (!rowHas[y]) { if (run < 0) run = y; continue; }
    if (run >= 0) {
      if (y - run > splitLen) { splitLen = y - run; splitAt = run; }
      run = -1;
    }
  }
  const limit = splitAt >= 0 ? splitAt : bottom + 1;

  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = top; y < limit; y++) {
    for (let x = 0; x < w; x++) {
      if (!far(at(x, y))) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('found no artwork in the top of Logo.png');

  /*
     The emblem, padded — as a rectangle, and clamped to the band it was
     measured in.

     NOTE: no backticks in this comment. Template literal, executeJavaScript.

     This squared the box by taking the longer side and centring on it, which is
     correct only while the emblem is roughly square. The 2026-08-29 artwork is a
     wide scatter cloud: 903 across against 774 tall. Squaring to the width
     pushed the top of the crop 18 rows above the canvas and the bottom 91 rows
     past the wordmark split, so the icon rendered with the tops of M, C, F and
     l sliced across its foot. The measured crop existed to stop exactly that
     class of failure and had a typed assumption of its own hiding in it: that a
     mark can be squared by reaching outside itself.

     It cannot. A rectangle is what was measured, so a rectangle is what is
     carried, and plateOn letterboxes it into the square plate — the shortfall
     shows as plate, which is what the plate is for. Clamped as well as
     rectangular, so neither a future re-export nor a rounding error can sample
     the wordmark or the void outside the image.
  */
  const grow = Math.max(x1 - x0, y1 - y0) * 0.03;
  const cx0 = Math.max(0, x0 - grow), cy0 = Math.max(top, y0 - grow);
  const crop = {
    x: cx0,
    y: cy0,
    w: Math.min(w, x1 + 1 + grow) - cx0,
    h: Math.min(limit, y1 + 1 + grow) - cy0,
  };

  /*
     The plate and the mark on it, onto any context at any offset.

     NOTE: no backticks in this comment. Template literal, executeJavaScript.

     Separated from draw() so the installer header can put the same object into
     a wider strip. Composing it as an image would have to wait for a data URL to
     decode, and the surrounding function is synchronous.
  */
  const plateOn = (g, ox, oy, size) => {
    g.save();
    g.translate(ox, oy);

    /*
       Plate: the artwork own field colour, with a hairline so it reads against
       a white desktop too.

       NOTE: no backticks in this comment. Template literal, executeJavaScript.

       Pure white was close enough while the artwork was drawn on pure white. The
       2026-08-13 logo sits on a very slightly warm off-white, and a mark drawn
       onto a pure-white plate then shows the edge of its own background as a
       faint rectangle inside the rounded one — invisible at 16 px and plainly
       there on the 1024 px master, which is the file macOS and Linux build their
       icons from. Sampling the plate from the same corner the transparency test
       samples means there is no seam to see, whatever field the next export uses.
    */
    const r = size * 0.22;
    g.fillStyle = 'rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')';
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(size, 0, size, size, r);
    g.arcTo(size, size, 0, size, r);
    g.arcTo(0, size, 0, 0, r);
    g.arcTo(0, 0, size, 0, r);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(13,15,19,0.16)';
    g.lineWidth = Math.max(1, size * 0.02);
    g.stroke();

    /*
       The mark, inset so the plate frames it, and fitted rather than stretched.

       NOTE: no backticks in this comment. Template literal, executeJavaScript.

       The source rect is the emblem's own shape, so a wide mark is centred with
       plate above and below it instead of being squared by sampling whatever
       the artwork happens to have there — which was the wordmark.
    */
    const inset = size * 0.12;
    const box = size - inset * 2;
    const k = Math.min(box / crop.w, box / crop.h);
    const dw = crop.w * k, dh = crop.h * k;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(
      img, crop.x, crop.y, crop.w, crop.h,
      inset + (box - dw) / 2, inset + (box - dh) / 2, dw, dh,
    );
    g.restore();
  };

  const draw = (size) => {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    plateOn(c.getContext('2d'), 0, 0, size);
    return c.toDataURL('image/png');
  };

  /*
     The trimmed bounds of the whole lockup, emblem and wordmark together.

     NOTE: no backticks in this comment. Template literal, executeJavaScript.

     Measured once here because the installer sidebar wants it, and because the
     emblem crop above is measured the same way against the same background
     test — one scan, one answer. The splash used to be the third caller and is
     now cut from LogoSplash.png instead, where the background test is alpha.
  */
  const lockup = (() => {
    let sx0 = w, sx1 = -1;
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < w; x++) {
        if (!far(at(x, y))) continue;
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
      }
    }
    const pad = Math.round((sx1 - sx0) * 0.06);
    const x = Math.max(0, sx0 - pad);
    const y = Math.max(0, top - pad);
    return {
      x, y,
      w: Math.min(w - x, sx1 - sx0 + pad * 2),
      h: Math.min(h - y, bottom - top + pad * 2),
    };
  })();

  /*
     One of the installer bitmaps, as raw RGBA.

     Both are the artwork own field with something drawn on it: the sidebar takes
     the whole lockup centred, the header takes the plated mark against the right
     edge, which is where MUI2 puts it. Returned base64 rather than as an array
     of numbers because 164x314 RGBA is 206 000 of them and this crosses an IPC
     boundary as JSON.
  */
  const panel = (pw, ph, kind) => {
    const c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = 'rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')';
    g.fillRect(0, 0, pw, ph);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    if (kind === 'lockup') {
      const m = Math.round(pw * 0.1);
      const scale = Math.min((pw - m * 2) / lockup.w, (ph - m * 2) / lockup.h);
      const dw = lockup.w * scale, dh = lockup.h * scale;
      g.drawImage(img, lockup.x, lockup.y, lockup.w, lockup.h,
        (pw - dw) / 2, (ph - dh) / 2, dw, dh);
    } else {
      // The plated mark, so the header carries the same object the taskbar does
      // rather than a second treatment of the same drawing.
      const s = Math.round(ph * 0.78);
      const m = Math.round((ph - s) / 2);
      plateOn(g, pw - s - m, m, s);
    }

    const px = g.getImageData(0, 0, pw, ph).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
    }
    return { w: pw, h: ph, rgba: btoa(s) };
  };


  return {
    crop,
    source: { w, h },
    // What the emblem/wordmark split measured, so the receipt can state it and a
    // future re-export that lands somewhere surprising says so rather than
    // silently producing a cropped icon.
    split: { at: limit, gap: splitLen, artwork: { top, bottom } },
    icons: sizes.map((s) => ({ size: s, data: draw(s) })),
    /*
       The in-app header mark.

       NOTE: no backticks anywhere in this string, for the reason given twice
       below and hit twice already.

       The application's own header drew a hand-coded density contour as inline
       SVG — a stand-in from Stage 1, and the one place the 2026-08-03 branding
       work did not reach, because it is a React component rather than an asset
       and so nothing regenerated it. It is now this file's output like every
       other rendering of the mark, and specifically it is draw() at another
       size: the header, the title bar, the taskbar and the installer are the
       same function's output and cannot drift apart by construction. That is
       the property worth having, and it is the property a second hand-tuned
       asset would not have.

       64 px for a 17 px slot. The header is the only place the mark is drawn by
       CSS pixels rather than chosen by the OS from a set, so it has to carry its
       own device-pixel headroom: 64 covers 3.7x, past any display anybody runs.
    */
    mark: draw(64),
    /*
       The installer wizard's two bitmaps.

       NOTE: no backticks anywhere in this comment, for the reason given three
       times in this file and hit six times in this project.

       NSIS shows a tall image on the welcome and finish pages and a small one in
       the header strip of every page between them, and with neither supplied
       electron-builder falls back to the stock NSIS artwork — a generic blue
       metro graphic that is the first thing anybody installing MCFlow sees. It
       is not a stale logo, which is why regenerating the icons never fixed it;
       it is the absence of one.

       The sizes are NSIS's own and are not negotiable: 164x314 for the sidebar
       and 150x57 for the header, both 24-bit BMP, which is why these come back
       as raw pixels rather than as data URLs like everything else here.

       The header mark sits at the right because that is where MUI2 places it,
       and the strip is the artwork own field colour so the plate has nothing to
       sit against.
    */
    sidebar: panel(164, 314, 'lockup'),
    header: panel(150, 57, 'mark'),
    /*
       The macOS and Linux source, at 1024 rather than 512.

       NOTE: no backticks anywhere in this string. It is a template literal
       handed to executeJavaScript, and one inside a comment terminates it at
       parse time — the trap recorded three times above, and hit again here on
       2026-08-04 by the person who wrote that warning.

       electron-builder derives icon.icns from this file, and an .icns carries a
       1024 px variant for Retina — handed a 512 it either upscales or omits the
       largest slot, and a soft app icon is the first thing anybody sees. Linux
       AppImage and deb take the same file. Windows does not use it at all; the
       .ico above tops out at 256, which is the largest size the Windows shell
       asks for.
    */
    big: draw(1024),
    /*
       Every size an .icns carries, drawn rather than resampled from one master.

       NOTE: no backticks anywhere in this comment — same trap as above.

       macOS picks a slot by the point size and the display scale, and a missing
       slot is filled by scaling the nearest one, so an .icns built from a single
       image is soft in the Dock at exactly the size most people see it. These
       are draw() at each size, which is the same guarantee the .ico gets.

       See buildIcns for which OSType each one is packed under.
    */
    mac: [16, 32, 64, 128, 256, 512, 1024].map((s) => ({ size: s, data: draw(s) })),
  };
})(${JSON.stringify(pathToFileURL(LOGO).href)}, ${JSON.stringify(SIZES)})
`;

/**
 * The splash asset, cut from the *other* artwork.
 *
 * `Logo.png` is the lockup on a white plate, and the plate is not incidental:
 * a mark drawn straight onto transparency has no shape in a taskbar, and these
 * blues and purples are chosen against white. The splash is the one surface
 * with the opposite requirement — a near-black field and no container — so it
 * is cut from `LogoSplash.png`, the same lockup exported on transparency.
 *
 * **Two artworks because neither can be derived from the other.** Compositing
 * the transparent one onto white loses the plate's rounded corner and hairline;
 * keying white out of the plated one eats the wordmark's antialiasing and
 * leaves a halo on exactly the near-black field this is for. So the receipt
 * names both digests.
 *
 * The trim is by **alpha** rather than by distance from a sampled corner, which
 * is why this is a second script rather than a flag on the first.
 */
const SPLASH_RENDER = `
(async (src) => {
  const img = new Image();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = src; });

  const w = img.naturalWidth, h = img.naturalHeight;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pg = probe.getContext('2d', { willReadFrequently: true });
  pg.drawImage(img, 0, 0);
  const px = pg.getImageData(0, 0, w, h).data;

  // NOTE: no backticks anywhere in this string. Template literal,
  // executeJavaScript — one inside a comment ends it at parse time.
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('LogoSplash.png has no opaque pixels');

  /*
     Trimmed tight, with 2 percent of slack rather than the 6 the plated splash
     took. That margin existed to hold the artwork off the edge of its own white
     card. There is no card here — what surrounds the mark is the splash field
     itself, and the space around it is set in CSS, against the progress strip
     below it, where it can actually be judged. The slack is only so rounding
     cannot clip the outermost scatter dot.
  */
  const pad = Math.round((x1 - x0) * 0.02);
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.min(w - bx, x1 - x0 + 1 + pad * 2);
  const bh = Math.min(h - by, y1 - y0 + 1 + pad * 2);

  const c = document.createElement('canvas');
  c.width = bw; c.height = bh;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, bx, by, bw, bh, 0, 0, bw, bh);

  /*
     WebP, which is what the note on the old JPEG was asking for and could not
     have. The artwork is tens of thousands of individually antialiased dots —
     PNG's worst case, and a lossless encode of it is over a megabyte, which
     would arrive after the bundle the splash exists to cover for. JPEG solved
     the size and cost the alpha channel, and alpha is the whole point of this
     variant. WebP is lossy and has alpha.

     Emitted at the trimmed source size rather than resampled to a target. The
     mark is drawn around 510 CSS px wide, so this is already about the 2x
     asset, and upsampling to reach exactly 2x would only add bytes.
  */
  return {
    data: c.toDataURL('image/webp', 0.92),
    width: bw, height: bh,
    source: { w: w, h: h },
    ink: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  };
})(${JSON.stringify(pathToFileURL(LOGO_SPLASH).href)})
`;

/** Pack PNG buffers into a multi-resolution .ico. */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((e, i) => {
    const o = i * 16;
    // 256 is encoded as 0 in the directory — the field is a single byte.
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);      // palette count
    dir.writeUInt8(0, o + 3);      // reserved
    dir.writeUInt16LE(1, o + 4);   // colour planes
    dir.writeUInt16LE(32, o + 6);  // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/**
 * Which `.icns` slots each pixel size fills.
 *
 * An icns entry is tagged with a four-character OSType that names a *point* size
 * and a scale, not a pixel count — so 32 px is both "32 pt at 1x" (`icp5`) and
 * "16 pt at 2x" (`ic11`), and macOS looks for whichever of the two the display
 * calls for. Writing one and not the other is how an icon ends up crisp in the
 * Finder list and blurred in the Dock on the same machine.
 *
 * The identical PNG under both tags is what Apple's own `iconutil` produces from
 * an `.iconset` naming the same file twice, so this is the format's shape rather
 * than duplication worth removing.
 */
const ICNS_TYPES = {
  16: ['icp4'],
  32: ['icp5', 'ic11'],
  64: ['ic12'],
  128: ['ic07'],
  256: ['ic08', 'ic13'],
  512: ['ic09', 'ic14'],
  1024: ['ic10'],
};

/**
 * Pack PNG buffers into an `.icns`.
 *
 * Written here rather than shelled out to `iconutil` for the reason the `.ico`
 * writer exists: `iconutil` is macOS-only, and the icon has to be regenerable on
 * the machine the artwork is edited on. The format is simple enough that this is
 * ~15 lines — a magic word, a total length, then a flat list of length-prefixed
 * chunks — and every modern slot takes a PNG verbatim, so nothing is re-encoded.
 *
 * All lengths are **big-endian** and **include their own 8-byte header**, which
 * are the two things a writer gets wrong; a file violating either is rejected by
 * the Finder with no message at all.
 */
function buildIcns(entries) {
  const chunks = [];
  for (const e of entries) {
    for (const type of ICNS_TYPES[e.size] ?? []) {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'ascii');
      head.writeUInt32BE(e.png.length + 8, 4);
      chunks.push(head, e.png);
    }
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const bytes = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

/**
 * Pack RGBA pixels into a 24-bit BMP.
 *
 * NSIS reads nothing else for its wizard images — not PNG, not a BMP with an
 * alpha channel — so this is a format requirement rather than a choice. Rows run
 * **bottom-up** and each is padded to a multiple of four bytes, which are the two
 * things a BMP writer gets wrong; a file that violates either is accepted by some
 * viewers and produces a sheared or upside-down image in the installer.
 *
 * The alpha channel is dropped rather than composited, which is exact here: both
 * panels are painted onto an opaque field before anything else is drawn on them.
 */
function buildBmp({ w, h, rgba }) {
  const px = Buffer.from(rgba, 'base64');
  const stride = Math.ceil((w * 3) / 4) * 4;
  const body = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    let o = y * stride;
    for (let x = 0; x < w; x++) {
      const i = src + x * 4;
      body[o++] = px[i + 2];
      body[o++] = px[i + 1];
      body[o++] = px[i];
    }
  }

  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + body.length, 2);
  head.writeUInt32LE(54, 10);          // pixel data offset
  head.writeUInt32LE(40, 14);          // BITMAPINFOHEADER
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);           // colour planes
  head.writeUInt16LE(24, 28);          // bits per pixel
  head.writeUInt32LE(0, 30);           // BI_RGB, uncompressed
  head.writeUInt32LE(body.length, 34);
  head.writeInt32LE(2835, 38);         // 72 dpi, in pixels per metre
  head.writeInt32LE(2835, 42);
  return Buffer.concat([head, body]);
}

app.whenReady().then(async () => {
  await mkdir(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 600, height: 600, show: false, webPreferences: { webSecurity: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const result = await win.webContents.executeJavaScript(RENDER);
  const splashArt = await win.webContents.executeJavaScript(SPLASH_RENDER);

  await writeFile(
    join(OUT, 'icon.ico'),
    buildIco(result.icons.map((e) => ({ size: e.size, png: bytes(e.data) }))),
  );
  // 1024px PNG for Linux, and the source electron-builder would fall back to.
  // See `big` in RENDER.
  await writeFile(join(OUT, 'icon.png'), bytes(result.big));

  /*
     The macOS icon, written rather than left to be derived.

     electron-builder will convert `icon.png` to an .icns itself, but only on a
     machine that can run its converter, and it produces the slots it chooses
     from one image. Committing a real .icns makes the mac icon the same kind of
     artefact as the Windows one: generated here, from `Logo.png`, covered by the
     receipt below, and identical whichever machine ran the build.
  */
  const icns = buildIcns(result.mac.map((e) => ({ size: e.size, png: bytes(e.data) })));
  await writeFile(join(OUT, 'icon.icns'), icns);

  // The splash asset goes to `public/`, which Vite copies verbatim into `dist/`
  // — so `index.html` can reference it by a plain path and the browser fetches
  // it alongside the document rather than after the bundle has run.
  const splash = bytes(splashArt.data);
  await mkdir(PUBLIC, { recursive: true });
  await writeFile(join(PUBLIC, 'splash.webp'), splash);
  // `logo.jpg` was this file until 2026-08-21 and nothing loads it now. Removed
  // here rather than by hand: a tree that still has one ships it, because Vite
  // copies whatever is in `public/` and asks no questions.
  await rm(join(PUBLIC, 'logo.jpg'), { force: true });

  // The header mark, beside the splash and for the same reason: `public/` ships
  // verbatim, so `AppShell` references it by a plain path. PNG rather than JPEG
  // — it is 64 px of hard-edged plate where JPEG's ringing would be visible and
  // its saving would be a few kilobytes.
  const mark = bytes(result.mark);
  await writeFile(join(PUBLIC, 'mark.png'), mark);

  /*
     The installer wizard's images, under the names electron-builder looks for.

     `buildResources` is `build/`, and electron-builder picks these up by
     filename with no configuration — which is also why they are written here
     rather than named in `electron-builder.yml`. `uninstallerSidebar.bmp` is not
     written: it falls back to the installer's own, and one image is right for
     both pages.
  */
  const sidebar = buildBmp(result.sidebar);
  const header = buildBmp(result.header);
  await writeFile(join(OUT, 'installerSidebar.bmp'), sidebar);
  await writeFile(join(OUT, 'installerHeader.bmp'), header);

  /*
     A receipt naming the artwork these were cut from.

     "The logo in the app is an old version" is a report that cannot be checked
     by looking at the files — every generated asset is a crop, a resample and a
     re-encode of the source, so none of them can be compared against it by eye
     with any confidence, and a timestamp only says when a file was written,
     which is not the same as what it was written from. A digest of `Logo.png`
     written beside the output settles it: re-run this, and if the digest is
     unchanged then whatever is stale is downstream — a packaged build, or the
     Windows shell's icon cache — and not these files.
  */
  const digest = createHash('sha256').update(await readFile(LOGO)).digest('hex');
  const splashDigest = createHash('sha256').update(await readFile(LOGO_SPLASH)).digest('hex');
  await writeFile(
    join(OUT, 'icon.source.txt'),
    [
      '# Generated by scripts/make-icon.mjs — do not edit.',
      '# Two artworks, because the plate is required for an icon and fatal for',
      '# the splash. Logo.png (the lockup on white) is cut into build/icon.ico,',
      '# build/icon.icns, build/icon.png, build/installerSidebar.bmp,',
      '# build/installerHeader.bmp and public/mark.png. LogoSplash.png (the same',
      '# lockup on transparency) is cut into public/splash.webp and nothing else.',
      `source     Logo.png`,
      `sha256     ${digest}`,
      `size       ${result.source.w}x${result.source.h}`,
      `emblem     ${Math.round(result.crop.w)}x${Math.round(result.crop.h)} at ${Math.round(result.crop.x)},${Math.round(result.crop.y)}`,
      `wordmark   split at y=${result.split.at} on a ${result.split.gap}px gap`
        + ` (artwork ${result.split.artwork.top}…${result.split.artwork.bottom})`,
      '',
      `splash     LogoSplash.png`,
      `sha256     ${splashDigest}`,
      `size       ${splashArt.source.w}x${splashArt.source.h}`,
      `ink        ${splashArt.ink.w}x${splashArt.ink.h} at ${splashArt.ink.x},${splashArt.ink.y}`,
      `trimmed    ${splashArt.width}x${splashArt.height} WebP`,
      '',
      `generated  ${new Date().toISOString()}`,
      '',
    ].join('\n'),
  );

  console.log(`source       Logo.png ${result.source.w}x${result.source.h}  sha256 ${digest.slice(0, 16)}…`);
  console.log(`splash src   LogoSplash.png ${splashArt.source.w}x${splashArt.source.h}  sha256 ${splashDigest.slice(0, 16)}…`);
  console.log(`emblem       ${Math.round(result.crop.w)}x${Math.round(result.crop.h)} at ${Math.round(result.crop.x)},${Math.round(result.crop.y)}`);
  console.log(`wordmark     split at y=${result.split.at} on a ${result.split.gap}px gap`
    + `  (artwork rows ${result.split.artwork.top}…${result.split.artwork.bottom})`);
  console.log(`icon.ico     ${SIZES.join(', ')} px`);
  console.log(`icon.icns    ${result.mac.map((e) => e.size).join(', ')} px in `
    + `${result.mac.reduce((n, e) => n + (ICNS_TYPES[e.size]?.length ?? 0), 0)} slots, `
    + `${(icns.length / 1024).toFixed(0)} kB  (macOS)`);
  console.log('icon.png     1024 px  (Linux)');
  console.log(`splash.webp  ${splashArt.width}x${splashArt.height} px, ${(splash.length / 1024).toFixed(0)} kB  (public/, from LogoSplash.png, on transparency)`);
  console.log(`mark.png     64 px, ${(mark.length / 1024).toFixed(0)} kB  (public/, for the app header)`);
  console.log(`installerSidebar.bmp  ${result.sidebar.w}x${result.sidebar.h}, ${(sidebar.length / 1024).toFixed(0)} kB  (NSIS welcome and finish pages)`);
  console.log(`installerHeader.bmp   ${result.header.w}x${result.header.h}, ${(header.length / 1024).toFixed(0)} kB  (NSIS page header strip)`);
  console.log('icon.source.txt  receipt naming the artwork above');
  app.exit(0);
});
