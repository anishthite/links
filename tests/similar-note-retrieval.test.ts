import { describe, expect, it } from 'vitest';

import {
  BEST_SIMILAR_RETRIEVAL_METHOD,
  buildSimilarCorpus,
  hasUsefulSimilarQuery,
  rankSimilarNotes,
  type SimilarRetrievalMethod,
} from '../server/lib/similar-note-retrieval';

const corpus = buildSimilarCorpus([
  { uuid: 'ar-1', text: 'Augmented reality research plan for headset calibration', tags: ['ar', 'hardware'], createdAt: 1, updatedAt: 10 },
  { uuid: 'robot-1', text: 'Robotics hand prototype and tactile sensors', tags: ['robotics'], createdAt: 2, updatedAt: 20 },
  { uuid: 'cook-1', text: 'Sourdough starter feeding notes and oven timings', tags: ['cooking'], createdAt: 3, updatedAt: 30 },
  { uuid: 'physics-1', text: 'supersymmetry and graviton reading list', tags: ['physics', 'to-learn'], createdAt: 4, updatedAt: 40 },
]);

describe('similar note retrieval', () => {
  it('finds the AR note across the live-safe ranked methods', () => {
    const methods: SimilarRetrievalMethod[] = ['overlap', 'bm25', 'hybrid_rrf', 'hybrid_weighted'];
    for (const method of methods) {
      const ranked = rankSimilarNotes(corpus, { text: 'AR headset calibration idea', tags: ['ar'] }, method, 3);
      expect(ranked[0]?.uuid, method).toBe('ar-1');
      expect(ranked.map((note) => note.uuid), method).not.toContain('cook-1');
    }
  });

  it('excludes the query note when asked', () => {
    const ranked = rankSimilarNotes(corpus, { text: 'Augmented reality research plan for headset calibration', tags: ['ar'], excludeUuid: 'ar-1' }, BEST_SIMILAR_RETRIEVAL_METHOD, 3);
    expect(ranked.map((note) => note.uuid)).not.toContain('ar-1');
  });

  it('lets chargram salvage typo-heavy short queries', () => {
    const ranked = rankSimilarNotes(corpus, { text: 'suppersymmetry gravitron', tags: ['physics'] }, 'chargram', 2);
    expect(ranked[0]?.uuid).toBe('physics-1');
  });

  it('detects empty similar-note queries', () => {
    expect(hasUsefulSimilarQuery('the and this', [])).toBe(false);
    expect(hasUsefulSimilarQuery('the and this', ['idea'])).toBe(true);
  });
});
