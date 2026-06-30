// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { createHeader } from '../src/header';

function createTestHeader(onOpenResurface = vi.fn()) {
  return createHeader({
    onSearch: () => {},
    onAddNote: () => null,
    onUpdateNote: () => null,
    onFilterChange: () => {},
    onViewChange: () => {},
    onOpenResurface,
    initialView: 'masonry',
    getAllTags: () => [],
  });
}

describe('header resurfacing entry point', () => {
  it('opens resurfacing from the former random reader button slot', () => {
    const onOpenResurface = vi.fn();
    const header = createTestHeader(onOpenResurface);

    header.el.querySelector<HTMLButtonElement>('[data-resurface-view]')?.click();

    expect(header.el.querySelector('[data-read-view]')).toBeNull();
    expect(onOpenResurface).toHaveBeenCalledTimes(1);
  });
});
