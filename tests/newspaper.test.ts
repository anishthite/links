// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { createNewspaperView, filterEditionNotes } from '../src/newspaper';
import type { Note } from '../src/lib/types';

const now = new Date(2026, 5, 24, 12, 0, 0).getTime();

function note(uuid: string, title: string, updatedAt: number): Note {
  return {
    uuid,
    text: title,
    tags: ['reading'],
    color: null,
    createdAt: updatedAt,
    updatedAt,
    sourceUrl: `https://example.com/${uuid}`,
    sourceTitle: title,
    sourceSiteName: 'Example',
  };
}

const today = note('today', 'Today Link', new Date(2026, 5, 24, 9, 0, 0).getTime());
const yesterday = note('yesterday', 'Yesterday Link', new Date(2026, 5, 23, 18, 0, 0).getTime());
const old = note('old', 'Old Link', new Date(2026, 5, 14, 9, 0, 0).getTime());

beforeEach(() => {
  window.localStorage.clear();
});

describe('newspaper view', () => {
  it('defaults to a weekly rolling edition', () => {
    expect(filterEditionNotes([old, yesterday, today], 'weekly', now).map((n) => n.uuid))
      .toEqual(['today', 'yesterday']);
  });

  it('rolls daily editions at local midnight', () => {
    expect(filterEditionNotes([old, yesterday, today], 'daily', now).map((n) => n.uuid))
      .toEqual(['today']);
  });

  it('renders weekly by default and lets the user switch to daily', () => {
    const view = createNewspaperView({ now: () => now });
    view.render([old, yesterday, today]);

    expect(view.getPeriod()).toBe('weekly');
    expect(view.el.textContent).toContain('Today Link');
    expect(view.el.textContent).toContain('Yesterday Link');
    expect(view.el.textContent).not.toContain('Old Link');

    view.el.querySelector<HTMLButtonElement>('[data-paper-period="daily"]')?.click();

    expect(view.getPeriod()).toBe('daily');
    expect(view.el.textContent).toContain('Today Link');
    expect(view.el.textContent).not.toContain('Yesterday Link');
  });
});
