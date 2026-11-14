// Joint Speaker — neon glyph field.
//
// A dense field of tiny monospace characters drawn over the artwork, in neon
// pink with violet and cyan accents. A slowly drifting noise "map" decides
// where glyphs appear: a solid core, a speckled coastline around it, and a few
// strays scattered elsewhere. Each character re-rolls about once a second.
//
// Nothing here uses Math.random(): every value is a hash of the cell position
// and the shared party clock, so every phone draws the exact same frame at the
// same moment, the same way the colours already stay in sync.

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&*+=?:;';
const FPS = 12; // glyph noise reads as alive well below 60 fps, and costs far less

// Bands, strongest first: sparkles inside the core, the core, the speckled
// coastline, and lone strays. Colours come from the app (they follow the
// artwork's palette); these are the default colours and the opacity per band.
const DEFAULT_COLORS = ['#FFFFFF', '#FF4FB8', '#C77DFF', '#5CF2FF'];
const ALPHA = [0.95, 0.95, 0.85, 0.8];

/** Deterministic 0..1 hash of three integers. */
function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth 2D value noise, 0..1. */
function noise(x, y, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export class GlyphField {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'glyphs';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.append(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.tick = -1;
    this.dirty = true;
    this.buckets = ALPHA.map(() => []);
    this.colors = DEFAULT_COLORS;
    this.ro = new ResizeObserver(() => (this.dirty = true));
    this.ro.observe(host);
  }

  layout() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.cell = Math.max(10, Math.min(15, w / 42));
    this.cols = Math.ceil(w / this.cell);
    this.rows = Math.ceil(h / this.cell);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = `500 ${Math.round(this.cell * 0.78)}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.dirty = false;
    return true;
  }

  /**
   * t: shared clock in seconds. energy: 0..1 music level.
   * colors: [sparkle, core, coastline, strays]. Redraws at most FPS times a second.
   */
  update(t, energy = 0, colors = DEFAULT_COLORS) {
    const tt = t % 100000; // keep the numbers small; still identical on every phone
    const tick = Math.floor(tt * FPS);
    if (tick === this.tick && !this.dirty) return;
    if (this.dirty && !this.layout()) return;
    this.tick = tick;
    this.colors = colors;
    this.draw(tt, energy);
  }

  draw(t, energy) {
    const { g, cols, rows, cell, buckets } = this;
    for (const b of buckets) b.length = 0;

    // Noise scaled to the box, so the "map" looks the same on any screen size,
    // with round features whether the box is wide or tall.
    const aspect = this.w / this.h;
    const fx = 2.6 * aspect;
    const fy = 2.6;
    const ox = t * 0.045;
    const oy = t * -0.03;
    const swell = energy * 0.08; // the shapes grow a little with the beat

    for (let r = 0; r < rows; r++) {
      const ny = ((r + 0.5) / rows) * fy + oy;
      for (let c = 0; c < cols; c++) {
        const nx = ((c + 0.5) / cols) * fx + ox;
        const f =
          0.62 * noise(nx, ny, 11) +
          0.38 * noise(nx * 2.1 - oy * 1.7, ny * 2.1 + ox * 1.3, 23) +
          swell;
        const pick = hash(c, r, 5);
        let band = -1;
        if (f > 0.6) band = pick < 0.06 ? 0 : 1;
        else if (f > 0.52) band = pick < (f - 0.52) / 0.08 ? 2 : -1;
        else if (pick < 0.012) band = 3;
        if (band < 0) continue;

        // Each cell re-rolls its character on its own staggered beat.
        const rate = 0.6 + hash(c, r, 9) * 0.9;
        const step = Math.floor(t * rate + hash(c, r, 13) * 10);
        buckets[band].push(c, r, (hash(c, r, step) * CHARS.length) | 0);
      }
    }

    g.clearRect(0, 0, this.w, this.h);
    for (let b = 0; b < ALPHA.length; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      g.fillStyle = this.colors[b];
      g.globalAlpha = ALPHA[b];
      for (let i = 0; i < list.length; i += 3) {
        g.fillText(CHARS[list[i + 2]], (list[i] + 0.5) * cell, (list[i + 1] + 0.5) * cell);
      }
    }
    g.globalAlpha = 1;
  }
}
