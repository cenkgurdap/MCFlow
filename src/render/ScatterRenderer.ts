/**
 * WebGL2 point renderer for event scatter plots.
 *
 * Receives **display-space** coordinates (transforms already applied on the CPU
 * — see src/core/transform) and maps them to clip space with a plain
 * scale-and-offset, so the shader stays trivial regardless of which transform
 * is active.
 *
 * Overplotting is the real problem at flow-cytometry scale: 170 000 events drawn
 * opaque is a solid blob. Alpha is derived from the event count so density reads
 * through accumulation, which is the conventional dot-plot appearance.
 */

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface DrawOptions {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Base colour as [r, g, b] in 0..1. */
  color: [number, number, number];
  /** Point diameter in CSS pixels. */
  pointSize: number;
  /** 0..1. When omitted, derived from the event count. */
  alpha?: number;
  /** Background clear colour [r,g,b,a] in 0..1. */
  background: [number, number, number, number];
  /**
   * Colour for events **inside** the highlighted population.
   *
   * The emphasis runs this way round deliberately. It used to be the other one —
   * a `dimColor` applied to everything outside the selected gate — and a plot
   * that fades most of itself the moment a gate is selected reads as though the
   * data has gone away. Marking the population in its own colour says the same
   * thing additively: the rest of the plot is drawn exactly as it would be with
   * nothing selected.
   */
  highlightColor?: [number, number, number];
  highlightAlpha?: number;
}

const VERTEX_SHADER = `#version 300 es
in float aX;
in float aY;
in float aIn;          // 1 = inside the highlighted population

uniform vec2 uMin;     // display-space viewport minimum
uniform vec2 uSpan;    // display-space viewport size
uniform float uPointSize;

out float vIn;

void main() {
  vec2 t = (vec2(aX, aY) - uMin) / uSpan;   // -> 0..1
  gl_Position = vec4(t * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vIn = aIn;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 uColor;
uniform vec4 uHiColor;   // colour for events inside the highlighted population
uniform float uSoften;   // 0 = hard square, 1 = antialiased disc
uniform float uHasMask;  // 0 = draw everything in uColor

in float vIn;
out vec4 fragColor;

void main() {
  // Additive emphasis: members of the selected population take its own colour,
  // everything else is drawn exactly as it would be with nothing selected. Back-
  // gating still works — the parent cloud is fully visible — without the plot
  // appearing to lose most of its data the moment a gate is clicked.
  vec4 base = (uHasMask > 0.5 && vIn > 0.5) ? uHiColor : uColor;

  // Below ~2 device pixels a disc mask eats most of the point and the plot
  // looks washed out, so small points are drawn as plain squares instead.
  if (uSoften > 0.5) {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = dot(c, c);
    if (r > 1.0) discard;
    float edge = 1.0 - smoothstep(0.55, 1.0, r);
    fragColor = vec4(base.rgb, base.a * edge);
  } else {
    fragColor = base;
  }
}`;

/** Above this, display is subsampled. Statistics always use the full data. */
export const MAX_RENDERED_POINTS = 1_200_000;

export class ScatterRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private bufX: WebGLBuffer | null = null;
  private bufY: WebGLBuffer | null = null;
  private bufIn: WebGLBuffer | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private pointCount = 0;
  private hasMask = false;
  private dpr = 1;
  private contextLost = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.init();
  }

  /** True when a GL context could not be created — the caller should fall back. */
  get unavailable(): boolean {
    return this.gl === null;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = () => {
    this.contextLost = false;
    this.program = null;
    this.vao = null;
    this.bufX = null;
    this.bufY = null;
    this.bufIn = null;
    this.hasMask = false;
    this.init();
  };

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false, // points are masked in the fragment shader instead
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // required for canvas export
      powerPreference: 'high-performance',
    });
    if (!gl) {
      this.gl = null;
      return;
    }
    this.gl = gl;

    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) {
      this.gl = null;
      return;
    }
    this.program = program;

    for (const name of ['uMin', 'uSpan', 'uPointSize', 'uColor', 'uHiColor', 'uSoften', 'uHasMask']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.vao = gl.createVertexArray();
    this.bufX = gl.createBuffer();
    this.bufY = gl.createBuffer();
    this.bufIn = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    const locX = gl.getAttribLocation(program, 'aX');
    const locY = gl.getAttribLocation(program, 'aY');
    const locIn = gl.getAttribLocation(program, 'aIn');

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufX);
    gl.enableVertexAttribArray(locX);
    gl.vertexAttribPointer(locX, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufY);
    gl.enableVertexAttribArray(locY);
    gl.vertexAttribPointer(locY, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIn);
    gl.enableVertexAttribArray(locIn);
    // Normalised unsigned byte: the mask is 0/1 per event, so a byte per point
    // is a quarter the bandwidth of a float and needs no conversion pass.
    gl.vertexAttribPointer(locIn, 1, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Upload display-space coordinates. `x` and `y` must be the same length.
   *
   * The arrays are uploaded as-is — because parsed data is stored column-major,
   * a parameter's values are already contiguous and need no repacking.
   */
  setData(x: Float32Array, y: Float32Array): void {
    const gl = this.gl;
    if (!gl || !this.bufX || !this.bufY) return;
    if (x.length !== y.length) {
      throw new Error(`ScatterRenderer: x has ${x.length} values but y has ${y.length}.`);
    }
    this.pointCount = x.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufX);
    gl.bufferData(gl.ARRAY_BUFFER, x, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufY);
    gl.bufferData(gl.ARRAY_BUFFER, y, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    // A stale mask from the previous dataset would mis-colour these points.
    this.hasMask = false;
  }

  /**
   * Mark which events belong to the highlighted population.
   * Pass null to draw everything in the base colour.
   */
  setMask(mask: Uint8Array | null): void {
    const gl = this.gl;
    if (!gl || !this.bufIn) return;
    if (!mask || mask.length !== this.pointCount) {
      this.hasMask = false;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIn);
    gl.bufferData(gl.ARRAY_BUFFER, mask, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.hasMask = true;
  }

  draw(viewport: Viewport, opts: DrawOptions): void {
    const gl = this.gl;
    if (!gl || !this.program || this.contextLost) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(opts.width * dpr));
    const h = Math.max(1, Math.round(opts.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.dpr = dpr;
    }
    gl.viewport(0, 0, w, h);

    const [br, bg, bb, ba] = opts.background;
    gl.clearColor(br, bg, bb, ba);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.pointCount === 0) return;

    const spanX = viewport.xMax - viewport.xMin;
    const spanY = viewport.yMax - viewport.yMin;
    // A zero span would divide by zero in the shader and blank the plot.
    if (!(spanX > 0) || !(spanY > 0)) return;

    const sizeDevice = Math.max(1, opts.pointSize * dpr);
    const alpha = opts.alpha ?? alphaForCount(this.pointCount);

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms['uMin']!, viewport.xMin, viewport.yMin);
    gl.uniform2f(this.uniforms['uSpan']!, spanX, spanY);
    gl.uniform1f(this.uniforms['uPointSize']!, sizeDevice);
    gl.uniform4f(this.uniforms['uColor']!, opts.color[0], opts.color[1], opts.color[2], alpha);
    const hi = opts.highlightColor ?? [1, 0.72, 0.2];
    // Highlighted events are drawn more opaquely than the base cloud, not less:
    // they are the subset being pointed at, and at the base alpha a few hundred
    // of them sitting inside a hundred thousand others do not read at all.
    gl.uniform4f(this.uniforms['uHiColor']!, hi[0], hi[1], hi[2], opts.highlightAlpha ?? Math.min(1, alpha * 2.2));
    gl.uniform1f(this.uniforms['uSoften']!, sizeDevice >= 2.5 ? 1 : 0);
    gl.uniform1f(this.uniforms['uHasMask']!, this.hasMask ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
    gl.bindVertexArray(null);
  }

  /**
   * Capture the current framebuffer as a PNG data URL.
   *
   * Works because the context is created with `preserveDrawingBuffer: true` —
   * without it the buffer is undefined after the compositor has consumed it and
   * this returns a blank image.
   */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gl = this.gl;
    if (!gl) return;
    if (this.bufX) gl.deleteBuffer(this.bufX);
    if (this.bufY) gl.deleteBuffer(this.bufY);
    if (this.bufIn) gl.deleteBuffer(this.bufIn);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.gl = null;
  }
}

/**
 * Per-point alpha for a readable dot plot.
 *
 * A 1/sqrt(n) falloff is the intuitive choice but overshoots badly: at 170 000
 * events it lands near 0.14 and the plot washes out, because events spread over
 * the plot area rather than piling into the same pixels. In practice alpha needs to fall roughly as n^-0.14 to keep a 15 k and a 170 k
 * sample looking comparably dense.
 */
export function alphaForCount(n: number): number {
  if (n <= 0) return 1;
  return Math.min(0.85, Math.max(0.12, 1.55 / Math.pow(n, 0.14)));
}

/**
 * Indices to render when a sample exceeds `MAX_RENDERED_POINTS`.
 *
 * Returns null when everything fits, which is the common case — the largest
 * test file is 170 264 events, well under the cap.
 *
 * Uses a golden-ratio stride rather than a contiguous block or a plain every-Nth
 * step: events are stored in acquisition order, so a plain stride can alias with
 * periodic acquisition artefacts, and a contiguous block would only show one
 * slice of the run.
 */
export function subsampleIndices(total: number, cap = MAX_RENDERED_POINTS): Uint32Array | null {
  if (total <= cap) return null;
  const out = new Uint32Array(cap);
  const phi = 0.618033988749895;
  for (let i = 0; i < cap; i++) {
    out[i] = Math.floor(((i * phi) % 1) * total);
  }
  return out;
}

/** Gather `values[indices[i]]` into a new array. */
export function gather(values: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = values[indices[i]!]!;
  return out;
}

/* -------------------------------------------------------------------------
   Shader plumbing
   ------------------------------------------------------------------------- */

function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('ScatterRenderer: program link failed —', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('ScatterRenderer: shader compile failed —', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Parse a `#rrggbb` or `rgb()` colour into 0..1 components for GL. */
export function parseColor(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const short = /^#([0-9a-f]{3})$/i.exec(css.trim());
  if (short) {
    const s = short[1]!;
    return [
      parseInt(s[0]! + s[0]!, 16) / 255,
      parseInt(s[1]! + s[1]!, 16) / 255,
      parseInt(s[2]! + s[2]!, 16) / 255,
    ];
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return [1, 1, 1];
}
