// AI arrange eval — runs a fixed 20-prompt corpus through the deterministic
// intent parser and reports the auto-checkable §9 grading criteria from
// PLAN-whiteboard.md.
//
// Usage:
//   npx tsx scripts/eval-arrange.ts
//
// This script does NOT call any remote LLM. It exercises the same code path
// that POST /api/ai/arrange uses today (arrangeDeterministic). When the AI
// Gateway binding lands, swap the local synthesizer here for a real call
// and the rubric stays valid.
//
// Auto-checkable criteria (PLAN §9 "AI quality"):
//   1. Prompts that produce a non-empty `updates` array            target ≥ 18/20
//   2. Prompts mentioning a specific #tag → all matching notes moved  target ≥ 19/20
//   3. Coordinate clamp violations (|x| or |y| > 1e6)              target 0
//
// "Obvious correctness" (target ≥ 15/20) needs human grading and is reported
// as `TBD` per-prompt for the author to fill in.

import { arrangeDeterministic } from '../server/routes/ai';

const COORD_LIMIT = 1_000_000;

// Synthetic corpus shaped like the production notes table, just enough to
// exercise the strategies. Real eval against the production corpus is a
// follow-up (would require a CLI flag pointing at a wrangler-exported D1).
type Row = Parameters<typeof arrangeDeterministic>[1][number];

function row(over: Partial<Row> & Pick<Row, 'uuid'>): Row {
  return {
    uuid: over.uuid,
    text: over.text ?? '',
    tags: over.tags ?? '[]',
    color: null,
    positionX: null,
    positionY: null,
    zIndex: 0,
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    tagsUpdatedAt: null,
    contentHash: null,
  } as Row;
}

// 20-note synthetic corpus — 4 ideas, 4 recipes, 3 todos, 3 reminders, 6 untagged.
const CORPUS: Row[] = [
  ...Array.from({ length: 4 }, (_, i) => row({ uuid: `idea-${i}`, tags: '["idea"]', createdAt: 1000 + i })),
  ...Array.from({ length: 4 }, (_, i) => row({ uuid: `recipe-${i}`, tags: '["recipe"]', createdAt: 2000 + i })),
  ...Array.from({ length: 3 }, (_, i) => row({ uuid: `todo-${i}`, tags: '["todo"]', createdAt: 3000 + i })),
  ...Array.from({ length: 3 }, (_, i) => row({ uuid: `rem-${i}`, tags: '["reminder"]', createdAt: 4000 + i })),
  ...Array.from({ length: 6 }, (_, i) => row({ uuid: `plain-${i}`, tags: '[]', createdAt: 5000 + i })),
];

type Prompt = {
  id: string;
  prompt: string;
  /** When set, every note whose primary tag equals this MUST appear in updates. */
  expectsTag?: string;
  /** When set, updates.length is expected to be 0 (parser rejects). */
  expectsEmpty?: boolean;
};

const PROMPTS: Prompt[] = [
  { id: 'P1',  prompt: 'cluster by tag' },
  { id: 'P2',  prompt: 'group notes by primary tag' },
  { id: 'P3',  prompt: 'organize by tag' },
  { id: 'P4',  prompt: 'arrange in a grid' },
  { id: 'P5',  prompt: 'tidy up the board' },
  { id: 'P6',  prompt: 'line up by date' },
  { id: 'P7',  prompt: 'sort by created' },
  { id: 'P8',  prompt: 'make a timeline along the x-axis' },
  { id: 'P9',  prompt: 'arrange them in a ring' },
  { id: 'P10', prompt: 'put everything in a circle' },
  { id: 'P11', prompt: 'scatter the notes' },
  { id: 'P12', prompt: 'spread them around' },
  { id: 'P13', prompt: 'move all #idea to top-left',     expectsTag: 'idea' },
  { id: 'P14', prompt: 'put #recipe in the bottom-right', expectsTag: 'recipe' },
  { id: 'P15', prompt: 'send #todo to the right',         expectsTag: 'todo' },
  { id: 'P16', prompt: 'move #reminder to top',           expectsTag: 'reminder' },
  { id: 'P17', prompt: 'place #idea in the center',       expectsTag: 'idea' },
  { id: 'P18', prompt: 'cluster by tag please',           /* alias */ },
  { id: 'P19', prompt: 'timeline by created date' },
  { id: 'P20', prompt: 'hocus pocus',                     expectsEmpty: true },
];

function parseTags(jsonStr: string): string[] {
  try {
    const v = JSON.parse(jsonStr) as unknown;
    return Array.isArray(v) ? (v as string[]).filter(t => typeof t === 'string') : [];
  } catch { return []; }
}

function gradeOne(p: Prompt): {
  id: string;
  prompt: string;
  nonEmpty: boolean;
  tagCoverageOk: boolean | null;   // null when the prompt isn't a tag-move
  clampViolations: number;
  expectedShape: 'non-empty' | 'empty' | 'tag-coverage';
  explanation: string;
  updatesCount: number;
} {
  const result = arrangeDeterministic(p.prompt, CORPUS, []);
  const nonEmpty = result.updates.length > 0;
  const clampViolations = result.updates.filter(u =>
    Math.abs(u.x) > COORD_LIMIT || Math.abs(u.y) > COORD_LIMIT,
  ).length;

  let tagCoverageOk: boolean | null = null;
  if (p.expectsTag) {
    const moved = new Set(result.updates.map(u => u.uuid));
    const expected = CORPUS.filter(r => parseTags(r.tags).includes(p.expectsTag!));
    tagCoverageOk = expected.every(r => moved.has(r.uuid));
  }

  const expectedShape: 'non-empty' | 'empty' | 'tag-coverage' = p.expectsEmpty
    ? 'empty'
    : p.expectsTag
      ? 'tag-coverage'
      : 'non-empty';

  return {
    id: p.id,
    prompt: p.prompt,
    nonEmpty,
    tagCoverageOk,
    clampViolations,
    expectedShape,
    explanation: result.explanation,
    updatesCount: result.updates.length,
  };
}

function main(): void {
  const rows = PROMPTS.map(gradeOne);
  const nonEmptyExpected = rows.filter(r => r.expectedShape !== 'empty');
  const nonEmptyPassing = nonEmptyExpected.filter(r => r.nonEmpty).length;

  const tagPrompts = rows.filter(r => r.expectedShape === 'tag-coverage');
  const tagCoveragePassing = tagPrompts.filter(r => r.tagCoverageOk === true).length;

  const totalClampViolations = rows.reduce((n, r) => n + r.clampViolations, 0);

  const emptyExpected = rows.filter(r => r.expectedShape === 'empty');
  const emptyOk = emptyExpected.filter(r => !r.nonEmpty).length;

  // --- Per-prompt rows ---
  console.log('id   shape          updates  ok?  notes');
  console.log('---  -------------  -------  ---  -----');
  for (const r of rows) {
    let ok = '?';
    let note = '';
    if (r.expectedShape === 'empty') {
      ok = !r.nonEmpty ? 'Y' : 'N';
      note = r.nonEmpty ? 'expected empty; got updates' : 'parser rejected (as expected)';
    } else if (r.expectedShape === 'tag-coverage') {
      ok = r.tagCoverageOk ? 'Y' : 'N';
      note = r.explanation;
    } else {
      ok = r.nonEmpty ? 'Y' : 'N';
      note = r.explanation;
    }
    if (r.clampViolations > 0) {
      note += `  (CLAMP VIOLATION x${r.clampViolations})`;
      ok = 'N';
    }
    console.log(
      `${r.id.padEnd(4)} ${r.expectedShape.padEnd(13)} ${String(r.updatesCount).padStart(7)}  ${ok.padEnd(3)}  ${note}`,
    );
  }

  // --- Aggregate verdict ---
  console.log('');
  console.log('summary  (PLAN-whiteboard.md \u00a79 \"AI quality\")');
  console.log(`  non-empty updates: ${nonEmptyPassing}/${nonEmptyExpected.length}  target \u2265 18/20  -> ${nonEmptyPassing >= 18 ? 'PASS' : 'FAIL'}`);
  console.log(`  tag-coverage:      ${tagCoveragePassing}/${tagPrompts.length}   target \u2265 ${Math.min(tagPrompts.length, 19)}/20 -> ${tagCoveragePassing === tagPrompts.length ? 'PASS' : 'FAIL'}`);
  console.log(`  coord violations:  ${totalClampViolations}   target = 0    -> ${totalClampViolations === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  empty-as-expected: ${emptyOk}/${emptyExpected.length}    target = ${emptyExpected.length} -> ${emptyOk === emptyExpected.length ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log('hand-grading (target \u2265 15/20 \"obviously correct\"):  TBD by author');

  const allPass =
    nonEmptyPassing >= 18 &&
    tagCoveragePassing === tagPrompts.length &&
    totalClampViolations === 0 &&
    emptyOk === emptyExpected.length;
  process.exit(allPass ? 0 : 1);
}

main();
