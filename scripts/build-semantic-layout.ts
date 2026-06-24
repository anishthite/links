// Build the semantic layout JSON consumed by server/lib/semantic-layout.ts.
//
//   tsx scripts/build-semantic-layout.ts            # local D1
//   tsx scripts/build-semantic-layout.ts --remote   # production D1
//
// Pipeline:
//   1. wrangler d1 execute → pull {uuid, text} for every note
//   2. @xenova/transformers bge-small-en-v1.5 → 384-dim embeddings
//   3. umap-js with seeded RNG → 2D coords
//   4. affine scale & center → board-space pixels
//   5. write db/semantic-layout.json
//
// PROBE — see implementation-notes/2026-06-10-semantic-layout-probe.html.
// First run downloads ~30MB of model weights into node_modules cache.

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { UMAP } from 'umap-js';
// transformers.js ships as ESM-only; tsx handles it.
import { pipeline } from '@xenova/transformers';

const REMOTE = process.argv.includes('--remote');
const TARGET = REMOTE ? '--remote' : '--local';
const OUT_PATH = resolve('db/semantic-layout.json');

// Mirrors server/routes/ai.ts. Keep in sync (or, later, import).
const CELL_W = 280;
const CELL_H = 220;
const GAP = 24;

type Row = { uuid: string; text: string };

function fetchRows(): Row[] {
  process.stderr.write(`[semantic] reading notes from ${REMOTE ? 'remote' : 'local'} D1…\n`);
  const out = execSync(
    `wrangler d1 execute board-db ${TARGET} --json --command "SELECT uuid, text FROM notes ORDER BY created_at ASC"`,
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 },
  );
  // wrangler emits `[{results: [...], success, meta}]`
  const parsed = JSON.parse(out) as Array<{ results: Row[] }>;
  const rows = parsed[0]?.results ?? [];
  return rows.filter(r => typeof r.text === 'string' && r.text.trim().length > 0);
}

async function embedAll(rows: Row[]): Promise<Float32Array[]> {
  process.stderr.write(`[semantic] loading bge-small-en-v1.5 (first run downloads ~30MB)…\n`);
  const extract = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');

  const vectors: Float32Array[] = [];
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    // Cap input length — bge-small has a 512-token context. ~2000 chars is safe.
    const text = rows[i]!.text.slice(0, 2000);
    const out = await extract(text, { pooling: 'mean', normalize: true });
    vectors.push(new Float32Array(out.data as Float32Array));
    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stderr.write(`[semantic]   embedded ${i + 1}/${rows.length}  (${elapsed}s)\n`);
    }
  }
  return vectors;
}

function project(vectors: Float32Array[]): number[][] {
  process.stderr.write(`[semantic] projecting ${vectors.length} vectors → 2D with UMAP…\n`);
  // Mulberry32 PRNG with a fixed seed so re-runs produce identical coords.
  let s = 0x9E3779B9;
  const rng = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: 15,
    minDist: 0.1,
    spread: 1.0,
    random: rng,
  });
  // umap-js wants number[][] not Float32Array[]
  const asArrays = vectors.map(v => Array.from(v));
  return umap.fit(asArrays);
}

/** Estimate a note's rendered height from its text. Width is fixed by CSS
 *  at CELL_W; height grows with line count + wrapping. Calibrated to the
 *  sticky-note CSS (Inter ~13px, ~32 chars per line at 280px). Clamped to
 *  keep one giant note from dominating the layout. */
function estimateNoteSize(text: string): { w: number; h: number } {
  const CHARS_PER_LINE = 32;
  const LINE_PX = 20;
  const PADDING_PX = 56;
  const MIN_H = 90;
  const MAX_H = 900;
  const lines = text.split('\n');
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
  }
  const h = Math.min(MAX_H, Math.max(MIN_H, total * LINE_PX + PADDING_PX));
  return { w: CELL_W, h };
}

/** Force-directed overlap relaxation, anchored to UMAP targets.
 *  Each note is a rigid (w, h) box — width fixed, height estimated from text.
 *  For ITERS iterations:
 *    - find any neighbours whose boxes overlap (via uniform spatial grid)
 *    - push the pair apart by half the overlap on the *minor* axis
 *    - apply a weak spring pulling each note back toward its UMAP target
 *  Topology preserved; clusters stay clusters, just unstacked. */
function relaxOverlaps(xy: number[][], sizes: { w: number; h: number }[]): number[][] {
  const ITERS = 200;
  const SPRING = 0.02;              // pull toward UMAP target (weaker → more room)
  const PUSH = 0.6;                 // fraction of overlap resolved per iter
  const PAD = GAP;                  // extra spacing buffer between boxes

  const n = xy.length;
  const target = xy.map(([x, y]) => [x!, y!] as [number, number]);
  const pos = xy.map(([x, y]) => [x!, y!] as [number, number]);

  // Grid cell must be at least as big as the largest box (else a tall note
  // could overlap a neighbour two cells away and we'd miss it).
  let maxBox = 0;
  for (const s of sizes) {
    if (s.w + PAD > maxBox) maxBox = s.w + PAD;
    if (s.h + PAD > maxBox) maxBox = s.h + PAD;
  }
  const CELL = maxBox;

  for (let it = 0; it < ITERS; it++) {
    const grid = new Map<string, number[]>();
    const key = (gx: number, gy: number) => `${gx},${gy}`;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(pos[i]![0] / CELL);
      const gy = Math.floor(pos[i]![1] / CELL);
      const k = key(gx, gy);
      const bucket = grid.get(k);
      if (bucket) bucket.push(i);
      else grid.set(k, [i]);
    }

    let maxOverlap = 0;

    for (let i = 0; i < n; i++) {
      const [xi, yi] = pos[i]!;
      const gx = Math.floor(xi / CELL);
      const gy = Math.floor(yi / CELL);
      const wi = sizes[i]!.w + PAD;
      const hi = sizes[i]!.h + PAD;

      for (let dgx = -1; dgx <= 1; dgx++) {
        for (let dgy = -1; dgy <= 1; dgy++) {
          const bucket = grid.get(key(gx + dgx, gy + dgy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const dx = pos[j]![0] - xi;
            const dy = pos[j]![1] - yi;
            // Two boxes overlap when their separation on each axis is less
            // than half the SUM of their sizes (not just one box's size).
            const wj = sizes[j]!.w + PAD;
            const hj = sizes[j]!.h + PAD;
            const minDx = (wi + wj) / 2;
            const minDy = (hi + hj) / 2;
            const overlapX = minDx - Math.abs(dx);
            const overlapY = minDy - Math.abs(dy);
            if (overlapX <= 0 || overlapY <= 0) continue;
            if (overlapX > maxOverlap) maxOverlap = overlapX;
            if (overlapY > maxOverlap) maxOverlap = overlapY;
            if (overlapX < overlapY) {
              const shove = overlapX * PUSH * 0.5;
              if (dx >= 0) { pos[j]![0] += shove; pos[i]![0] -= shove; }
              else         { pos[j]![0] -= shove; pos[i]![0] += shove; }
            } else {
              const shove = overlapY * PUSH * 0.5;
              if (dy >= 0) { pos[j]![1] += shove; pos[i]![1] -= shove; }
              else         { pos[j]![1] -= shove; pos[i]![1] += shove; }
            }
          }
        }
      }
    }

    for (let i = 0; i < n; i++) {
      pos[i]![0] += (target[i]![0] - pos[i]![0]) * SPRING;
      pos[i]![1] += (target[i]![1] - pos[i]![1]) * SPRING;
    }

    if ((it + 1) % 25 === 0 || it === ITERS - 1) {
      process.stderr.write(`[semantic]   relax iter ${it + 1}/${ITERS}  maxOverlap=${maxOverlap.toFixed(1)}px\n`);
    }
    if (maxOverlap === 0) {
      process.stderr.write(`[semantic]   relax converged at iter ${it + 1}\n`);
      break;
    }
  }

  return pos.map(([x, y]) => [x, y]);
}

/** Translate so the bounding box is centred on (0,0). */
function recenter(xy: number[][]): number[][] {
  if (xy.length === 0) return xy;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    if (x! < minX) minX = x!;
    if (x! > maxX) maxX = x!;
    if (y! < minY) minY = y!;
    if (y! > maxY) maxY = y!;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  process.stderr.write(`[semantic] recentered (offset ${(-cx).toFixed(0)}, ${(-cy).toFixed(0)}; span ${(maxX-minX).toFixed(0)}x${(maxY-minY).toFixed(0)})\n`);
  return xy.map(([x, y]) => [x! - cx, y! - cy]);
}

/** Scale UMAP output (~[-10, 10]) into board-space pixels. */
function scaleAndCenter(xy: number[][]): number[][] {
  const n = xy.length;
  if (n === 0) return xy;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    if (x! < minX) minX = x!;
    if (x! > maxX) maxX = x!;
    if (y! < minY) minY = y!;
    if (y! > maxY) maxY = y!;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Target span ≈ sqrt(n) cells. Generous spacing — the relaxation pass
  // still needs room to spread tall notes apart without yanking everything
  // back to the centroid via the spring.
  const targetSpan = Math.sqrt(n) * (CELL_W + GAP) * 2.4;
  const rawSpan = Math.max(maxX - minX, maxY - minY) || 1;
  const k = targetSpan / rawSpan;
  return xy.map(([x, y]) => [(x! - cx) * k, (y! - cy) * k]);
}

async function main() {
  const rows = fetchRows();
  if (rows.length === 0) {
    process.stderr.write('[semantic] no notes found; aborting\n');
    process.exit(1);
  }
  const vectors = await embedAll(rows);
  const xyRaw = project(vectors);
  const xyScaled = scaleAndCenter(xyRaw);
  const sizes = rows.map(r => estimateNoteSize(r.text));
  const hs = sizes.map(s => s.h);
  hs.sort((a, b) => a - b);
  const p50 = hs[Math.floor(hs.length / 2)] ?? 0;
  const p95 = hs[Math.floor(hs.length * 0.95)] ?? 0;
  process.stderr.write(`[semantic] relaxing overlaps (${xyScaled.length} notes; height p50=${p50}px p95=${p95}px max=${hs[hs.length - 1]}px)…\n`);
  const relaxed = relaxOverlaps(xyScaled, sizes);
  // Recenter the *bounding box* on origin so the user's camera (which sits
  // at 0,0 by default) lands inside the layout instead of in the void the
  // relaxation pass tends to open up in the middle.
  const xy = recenter(relaxed);

  const coords: Record<string, [number, number]> = {};
  rows.forEach((r, i) => {
    const p = xy[i]!;
    coords[r.uuid] = [Math.round(p[0]!), Math.round(p[1]!)];
  });

  const payload = {
    meta: {
      builtAt: new Date().toISOString(),
      source: REMOTE ? 'remote' : 'local',
      count: rows.length,
      model: 'Xenova/bge-small-en-v1.5',
      projector: 'umap-js',
      umap: { nNeighbors: 15, minDist: 0.1, seed: 0x9E3779B9 },
      relax: { iters: 200, spring: 0.02, push: 0.6, perNoteHeight: true },
    },
    coords,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload));
  process.stderr.write(`[semantic] wrote ${OUT_PATH}  (${rows.length} notes)\n`);
}

main().catch((err) => {
  console.error('[semantic] failed:', err);
  process.exit(1);
});
