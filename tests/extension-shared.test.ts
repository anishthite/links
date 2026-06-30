// @ts-nocheck
import { describe, expect, it } from 'vitest';

import { buildCreatePayload, linksApiUrl, normalizeAppUrl, parseTags } from '../extension/shared.js';

describe('extension shared helpers', () => {
  it('normalizes app URLs before appending /api/links', () => {
    expect(normalizeAppUrl('https://links.anishthite.workers.dev/')).toBe('https://links.anishthite.workers.dev');
    expect(linksApiUrl('http://127.0.0.1:8788/api/links')).toBe('http://127.0.0.1:8788/api/links');
  });

  it('normalizes comma tags like the app does', () => {
    expect(parseTags('AI, #Tools, ai, reading list, nope!, way-too-long-tag-name-that-should-be-dropped')).toEqual([
      'ai',
      'tools',
      'reading list',
    ]);
  });

  it('builds the smallest link-create payload', () => {
    expect(buildCreatePayload({ url: ' https://example.com/post ', note: '  ', tagsText: '#AI' })).toEqual({
      sourceUrl: 'https://example.com/post',
      tags: ['ai'],
    });
    expect(() => buildCreatePayload({ url: 'chrome://extensions' })).toThrow('Only http:// and https:// tabs can be saved.');
  });
});
