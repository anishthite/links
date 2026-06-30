import { describe, expect, it } from 'vitest';

import { buildResurfaceModel } from '../src/resurface-page';
import type { Note } from '../src/lib/types';

const now = new Date('2026-06-24T12:00:00Z').getTime();

function note(input: Partial<Note> & Pick<Note, 'uuid' | 'text'>): Note {
  return {
    tags: [],
    color: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

describe('buildResurfaceModel', () => {
  it('prefers old source-backed notes with stronger extracted content', () => {
    const notes = [
      note({
        uuid: 'fresh-long',
        text: 'Fresh launch writeup',
        updatedAt: now - 2 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://example.com/fresh',
        sourceTitle: 'Fresh launch writeup',
        sourceContentText: 'launch '.repeat(900),
        tags: ['launch'],
      }),
      note({
        uuid: 'old-short',
        text: 'Old short note',
        updatedAt: now - 90 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://example.com/short',
        sourceTitle: 'Old short note',
        sourceContentText: 'tiny',
      }),
      note({
        uuid: 'old-rich',
        text: 'Old rich research',
        updatedAt: now - 80 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://research.example/deep',
        sourceTitle: 'Old rich research',
        sourceContentText: 'research systems memory resurfacing '.repeat(400),
        tags: ['research', 'memory'],
      }),
    ];

    const model = buildResurfaceModel(notes, now);

    expect(model.sourcePreferred).toBe(true);
    expect(model.picks[0]?.note.uuid).toBe('old-rich');
    expect(model.picks.map((pick) => pick.note.uuid)).toContain('old-short');
  });

  it('builds trails from shared tags and terms', () => {
    const notes = [
      note({
        uuid: 'a',
        text: 'Agent memory systems for resurfacing useful saved links',
        updatedAt: now - 60 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://a.example',
        sourceTitle: 'Agent memory systems',
        sourceContentText: 'agent memory retrieval resurfacing '.repeat(120),
        tags: ['agents', 'memory'],
      }),
      note({
        uuid: 'b',
        text: 'Retrieval design for agent memory and source grounding',
        updatedAt: now - 58 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://b.example',
        sourceTitle: 'Retrieval design',
        sourceContentText: 'agent memory retrieval sources '.repeat(120),
        tags: ['agents', 'memory'],
      }),
      note({
        uuid: 'c',
        text: 'Link trails and resurfacing for personal knowledge',
        updatedAt: now - 55 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://c.example',
        sourceTitle: 'Link trails',
        sourceContentText: 'resurfacing links memory trail '.repeat(120),
        tags: ['links', 'memory'],
      }),
      note({
        uuid: 'd',
        text: 'Sourdough oven temperature notes',
        updatedAt: now - 54 * 24 * 60 * 60 * 1000,
        sourceUrl: 'https://d.example',
        sourceTitle: 'Sourdough temperature',
        sourceContentText: 'starter flour oven crust '.repeat(120),
        tags: ['cooking'],
      }),
    ];

    const model = buildResurfaceModel(notes, now);

    expect(model.trails.length).toBeGreaterThan(0);
    expect(model.trails[0]?.steps.length).toBeGreaterThanOrEqual(2);
    expect(model.trails[0]?.shared.join(' ')).toContain('memory');
  });

  it('rotates refresh variants through the high-signal pool', () => {
    const notes = Array.from({ length: 9 }, (_, index) => note({
      uuid: `old-rich-${index}`,
      text: `Old rich link ${index}`,
      updatedAt: now - (90 - index) * 24 * 60 * 60 * 1000,
      sourceUrl: `https://host-${index}.example/deep`,
      sourceTitle: `Old rich link ${index}`,
      sourceContentText: `research memory trail ${index} `.repeat(220),
      tags: [`tag-${index}`, 'research'],
    }));

    const first = buildResurfaceModel(notes, now, 0);
    const second = buildResurfaceModel(notes, now, 1);

    expect(first.variant).toBe(0);
    expect(second.variant).toBe(1);
    expect(second.picks.map((pick) => pick.note.uuid)).not.toEqual(first.picks.map((pick) => pick.note.uuid));
    expect(second.picks).toHaveLength(3);
  });
});
