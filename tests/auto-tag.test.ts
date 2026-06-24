import { describe, expect, it } from 'vitest';

import { coverageBoostTags } from '../server/lib/auto-tag';

describe('coverageBoostTags', () => {
  it('adds closed-set recall tags for AI product ideas', () => {
    expect(coverageBoostTags('simulate users on your website (usability testing)', ['idea'])).toEqual(['idea', 'ai']);
  });

  it('does not treat URL query strings as questions', () => {
    expect(coverageBoostTags('https://twitter.com/FarzaTV/status/1?t=abc', [])).toEqual(['link', 'tweet']);
  });

  it('keeps explicit questions as question/thought', () => {
    expect(coverageBoostTags('what am i working on? what do I care about?', [])).toEqual(['question', 'thought']);
  });
});
