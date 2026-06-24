// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createStickyNote } from '../src/sticky-note';
import type { Note } from '../src/lib/types';

const baseNote: Note = {
  uuid: 'note-1',
  text: 'Saved body that should stay in the editor',
  tags: [],
  color: null,
  createdAt: 1,
  updatedAt: 1,
  sourceUrl: 'https://example.com/post',
  sourceTitle: 'Visible title',
};

describe('createStickyNote', () => {
  it('shows the title instead of the saved body on the card', () => {
    const el = createStickyNote(baseNote, new Set());

    expect(el.querySelector('.text')?.textContent).toBe('Visible title');
    expect(el.textContent).not.toContain('Saved body');
  });
});
