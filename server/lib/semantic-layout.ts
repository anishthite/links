// Semantic-layout strategy. Reads precomputed 2D UMAP coords from
// db/semantic-layout.json (built by scripts/build-semantic-layout.ts) and
// returns per-uuid {x, y} updates for the AI arrange route.
//
// PROBE — see implementation-notes/2026-06-10-semantic-layout-probe.html.
// When this graduates from probe to production, embeddings move into the
// notes table and this file deletes itself in favour of a SELECT.

import layout from '../../db/semantic-layout.json';

type Row = { uuid: string };
type Update = { uuid: string; x: number; y: number };

interface Layout {
  meta: { empty?: boolean; count?: number; builtAt?: string } & Record<string, unknown>;
  coords: Record<string, [number, number]>;
}

const data = layout as unknown as Layout;
const isEmpty = !!data.meta?.empty || Object.keys(data.coords).length === 0;


/**
 * Place every in-scope note at its precomputed semantic coordinate.
 * Notes missing from the layout (e.g. created after the build) are skipped.
 */
export function arrangeBySemantic(
  rows: Row[],
  selectedUuids: string[],
  prompt: string,
): { updates: Update[]; explanation: string } {
  if (isEmpty) {
    return {
      updates: [],
      explanation: 'semantic layout not built yet — run `npm run semantic:build`',
    };
  }
  const scope = pickScope(rows, selectedUuids, prompt);
  const updates: Update[] = [];
  let missing = 0;
  for (const r of scope) {
    const xy = data.coords[r.uuid];
    if (!xy || xy.length < 2) { missing++; continue; }
    const x = xy[0]; const y = xy[1];
    if (typeof x !== 'number' || typeof y !== 'number') { missing++; continue; }
    updates.push({ uuid: r.uuid, x, y });
  }
  const placed = updates.length;
  const meta = data.meta ?? {};
  const builtAt = typeof meta.builtAt === 'string' ? meta.builtAt.slice(0, 10) : 'unknown';
  const note = missing > 0 ? ` (${missing} new note${missing === 1 ? '' : 's'} skipped — rebuild)` : '';
  return {
    updates,
    explanation: `placed ${placed} notes by semantic similarity (UMAP @ ${builtAt})${note}`,
  };
}

function pickScope(rows: Row[], selectedUuids: string[], prompt: string): Row[] {
  if (selectedUuids.length > 0 && /(selected|these|highlighted)/i.test(prompt)) {
    const set = new Set(selectedUuids);
    return rows.filter(r => set.has(r.uuid));
  }
  return rows;
}
