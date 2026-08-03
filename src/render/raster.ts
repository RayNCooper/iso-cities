/**
 * A tiny software rasteriser producing hard-edged, un-antialiased pixels.
 *
 * All drawing goes through integer pixel writes. Shapes are filled with a
 * scanline algorithm sampling at pixel centres, which is what gives the output
 * its crisp pixel-art staircase instead of blurry edges.
 */

import type { RGB } from './color.js';

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Returns the colour for a pixel, or null to leave it untouched. */
export type Shader = (x: number, y: number) => RGB | null;

export function solid(color: RGB): Shader {
  return () => color;
}

export class Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, background?: RGB) {
    if (width <= 0 || height <= 0) throw new Error(`Raster: invalid size ${width}x${height}`);
    this.width = Math.floor(width);
    this.height = Math.floor(height);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    if (background) this.clear(background);
  }

  clear(color: RGB, alpha = 255): void {
    const { data } = this;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = alpha;
    }
  }

  set(x: number, y: number, color: RGB): void {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const i = (py * this.width + px) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = 255;
  }

  /** Source-over blend with a constant alpha in [0, 1]. */
  blend(x: number, y: number, color: RGB, alpha: number): void {
    if (alpha >= 1) return this.set(x, y, color);
    if (alpha <= 0) return;
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const i = (py * this.width + px) * 4;
    const d = this.data;
    d[i] = d[i]! + (color[0] - d[i]!) * alpha;
    d[i + 1] = d[i + 1]! + (color[1] - d[i + 1]!) * alpha;
    d[i + 2] = d[i + 2]! + (color[2] - d[i + 2]!) * alpha;
    d[i + 3] = 255;
  }

  get(x: number, y: number): RGB {
    const px = x | 0;
    const py = y | 0;
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return [0, 0, 0];
    const i = (py * this.width + px) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }

  fillRect(x: number, y: number, w: number, h: number, color: RGB): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.set(px, py, color);
    }
  }

  /**
   * Scanline-fills a path made of one or more rings using the even-odd rule,
   * so inner rings punch holes (courtyards, islands in lakes).
   */
  fillPath(rings: ScreenPoint[][], shader: Shader): void {
    const edges: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    let minY = Infinity;
    let maxY = -Infinity;

    for (const ring of rings) {
      const n = ring.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % n]!;
        if (a.y === b.y) continue;
        edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
      }
    }
    if (edges.length === 0) return;

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const crossings: number[] = [];

    for (let py = yStart; py <= yEnd; py++) {
      const sy = py + 0.5;
      crossings.length = 0;
      for (const e of edges) {
        const { y0, y1 } = e;
        if (sy >= y0 === sy >= y1) continue;
        const t = (sy - y0) / (y1 - y0);
        crossings.push(e.x0 + t * (e.x1 - e.x0));
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const xa = crossings[i]!;
        const xb = crossings[i + 1]!;
        const px0 = Math.max(0, Math.ceil(xa - 0.5));
        const px1 = Math.min(this.width - 1, Math.floor(xb - 0.5));
        for (let px = px0; px <= px1; px++) {
          const c = shader(px, py);
          if (c) this.set(px, py, c);
        }
      }
    }
  }

  fillPolygon(ring: ScreenPoint[], shader: Shader): void {
    this.fillPath([ring], shader);
  }

  /** Bresenham line, one pixel wide. */
  line(x0: number, y0: number, x1: number, y1: number, color: RGB): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    // Bounded so a pathological input can never spin forever.
    const limit = dx - dy + 4;
    for (let guard = 0; guard <= limit; guard++) {
      this.set(ax, ay, color);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Draws the closed outline of a ring. */
  outline(ring: ScreenPoint[], color: RGB): void {
    const n = ring.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      this.line(a.x, a.y, b.x, b.y, color);
    }
  }

  fillDisc(cx: number, cy: number, radius: number, color: RGB): void {
    if (radius <= 0.5) {
      this.set(Math.round(cx), Math.round(cy), color);
      return;
    }
    const r2 = radius * radius;
    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const y0 = Math.floor(cy - radius);
    const y1 = Math.ceil(cy + radius);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(px, py, color);
      }
    }
  }

  /**
   * Draws a polyline with a given pixel width by filling one quad per
   * segment plus a disc at each interior joint. Good enough for roads, and it
   * keeps corners from developing notches.
   */
  strokePolyline(points: ScreenPoint[], width: number, color: RGB): void {
    if (points.length < 2) {
      if (points.length === 1) this.fillDisc(points[0]!.x, points[0]!.y, width / 2, color);
      return;
    }
    const half = Math.max(0.5, width / 2);
    const shader = solid(color);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      this.fillPath(
        [
          [
            { x: a.x + nx, y: a.y + ny },
            { x: b.x + nx, y: b.y + ny },
            { x: b.x - nx, y: b.y - ny },
            { x: a.x - nx, y: a.y - ny },
          ],
        ],
        shader,
      );
    }
    if (half > 1) {
      for (let i = 1; i < points.length - 1; i++) {
        this.fillDisc(points[i]!.x, points[i]!.y, half, color);
      }
    }
  }

  /** Nearest-neighbour upscale — the only correct way to enlarge pixel art. */
  scaleUp(factor: number): Raster {
    const f = Math.max(1, Math.floor(factor));
    if (f === 1) return this;
    const out = new Raster(this.width * f, this.height * f);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const si = (y * this.width + x) * 4;
        const r = this.data[si]!;
        const g = this.data[si + 1]!;
        const b = this.data[si + 2]!;
        const a = this.data[si + 3]!;
        for (let dy = 0; dy < f; dy++) {
          let di = ((y * f + dy) * out.width + x * f) * 4;
          for (let dx = 0; dx < f; dx++) {
            out.data[di] = r;
            out.data[di + 1] = g;
            out.data[di + 2] = b;
            out.data[di + 3] = a;
            di += 4;
          }
        }
      }
    }
    return out;
  }
}
