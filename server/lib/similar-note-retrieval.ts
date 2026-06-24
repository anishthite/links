import { noteSearchText } from '../../src/lib/link-note';

export type SimilarNoteRow = {
  uuid: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceDescription?: string | null;
  sourceSiteName?: string | null;
  sourceContentText?: string | null;
};

export type SimilarQuery = {
  text: string;
  tags?: string[];
  excludeUuid?: string | null;
};

export type SimilarRetrievalMethod = 'overlap' | 'bm25' | 'chargram' | 'hybrid_rrf' | 'hybrid_weighted';

export type SimilarRankedNote = SimilarNoteRow & {
  score: number;
  reason: string;
  matchedTags: string[];
  matchedTerms: string[];
};

type PreparedNote = SimilarNoteRow & {
  normalizedText: string;
  terms: string[];
  termSet: Set<string>;
  termFreq: Map<string, number>;
  grams: Set<string>;
  tagSet: Set<string>;
  length: number;
};

export type SimilarCorpus = {
  notes: PreparedNote[];
  docFreq: Map<string, number>;
  avgLength: number;
  byUuid: Map<string, PreparedNote>;
};

type PreparedQuery = {
  rawText: string;
  normalizedText: string;
  terms: string[];
  termSet: Set<string>;
  grams: Set<string>;
  tags: string[];
  tagSet: Set<string>;
  excludeUuid: string | null;
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'about', 'into', 'note', 'notes', 'idea', 'thing',
  'what', 'when', 'where', 'which', 'would', 'could', 'should', 'have', 'been', 'your', 'you', 'them',
  'they', 'their', 'there', 'then', 'than', 'just', 'also', 'really', 'some', 'more', 'very', 'much',
  'over', 'under', 'like', 'want', 'make', 'made', 'need', 'needs', 'using', 'used', 'user', 'users',
]);

export const SIMILAR_RETRIEVAL_METHODS: SimilarRetrievalMethod[] = [
  'overlap',
  'bm25',
  'chargram',
  'hybrid_rrf',
  'hybrid_weighted',
];

// Set after the offline bakeoff in scripts/eval-similar-notes.ts.
export const BEST_SIMILAR_RETRIEVAL_METHOD: SimilarRetrievalMethod = 'chargram';

export function normalizeSimilarTag(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase();
}

export function extractSimilarTerms(text: string): string[] {
  const terms = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  return [...new Set(terms.filter((term) => !STOP_WORDS.has(term)))].slice(0, 30);
}

export function hasUsefulSimilarQuery(text: string, tags: string[] = []): boolean {
  if (tags.some((tag) => normalizeSimilarTag(tag))) return true;
  return extractSimilarTerms(text).length > 0;
}

export function buildSimilarCorpus(rows: SimilarNoteRow[]): SimilarCorpus {
  const notes = rows.map(prepareNote);
  const docFreq = new Map<string, number>();
  const byUuid = new Map<string, PreparedNote>();
  let lengthSum = 0;
  for (const note of notes) {
    byUuid.set(note.uuid, note);
    lengthSum += note.length;
    for (const term of note.termSet) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return {
    notes,
    docFreq,
    avgLength: notes.length ? lengthSum / notes.length : 0,
    byUuid,
  };
}

export function rankSimilarNotes(
  corpus: SimilarCorpus,
  queryInput: SimilarQuery,
  method: SimilarRetrievalMethod,
  limit = 8,
): SimilarRankedNote[] {
  const query = prepareQuery(queryInput);
  const scored = corpus.notes
    .filter((note) => note.uuid !== query.excludeUuid)
    .map((note) => scorePreparedNote(corpus, note, query, method))
    .filter((note): note is SimilarRankedNote => !!note)
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.uuid.localeCompare(b.uuid));
  return scored.slice(0, limit);
}

function prepareQuery(query: SimilarQuery): PreparedQuery {
  const rawText = query.text.trim();
  const normalizedText = normalizeFreeText(rawText);
  const terms = extractSimilarTerms(rawText);
  const tags = [...new Set((query.tags ?? []).map(normalizeSimilarTag).filter(Boolean))].slice(0, 12);
  return {
    rawText,
    normalizedText,
    terms,
    termSet: new Set(terms),
    grams: charGrams(normalizedText),
    tags,
    tagSet: new Set(tags),
    excludeUuid: query.excludeUuid ?? null,
  };
}

function prepareNote(note: SimilarNoteRow): PreparedNote {
  const text = noteSearchText(note) || note.text || '';
  const normalizedText = normalizeFreeText(text);
  const terms = extractSimilarTerms(text);
  const tags = [...new Set(note.tags.map(normalizeSimilarTag).filter(Boolean))];
  const termFreq = new Map<string, number>();
  for (const term of terms) termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  for (const tag of tags) termFreq.set(tag, (termFreq.get(tag) ?? 0) + 2);
  const mergedText = `${normalizedText} ${tags.map((tag) => `tag ${tag}`).join(' ')}`.trim();
  return {
    ...note,
    normalizedText,
    terms,
    termSet: new Set([...terms, ...tags]),
    termFreq,
    grams: charGrams(mergedText),
    tagSet: new Set(tags),
    length: Math.max(1, terms.length + tags.length * 2),
  };
}

function scorePreparedNote(
  corpus: SimilarCorpus,
  note: PreparedNote,
  query: PreparedQuery,
  method: SimilarRetrievalMethod,
): SimilarRankedNote | null {
  const matchedTags = query.tags.filter((tag) => note.tagSet.has(tag));
  const matchedTerms = query.terms.filter((term) => note.termSet.has(term)).slice(0, 4);
  const reason = buildReason(matchedTags, matchedTerms, note.tags);
  const score = method === 'overlap'
    ? overlapScore(note, query, matchedTags, matchedTerms)
    : method === 'bm25'
      ? bm25Score(corpus, note, query, matchedTags)
      : method === 'chargram'
        ? chargramScore(note, query, matchedTags)
        : method === 'hybrid_rrf'
          ? hybridRrfScore(corpus, note, query, matchedTags, matchedTerms)
          : hybridWeightedScore(corpus, note, query, matchedTags, matchedTerms);
  if (score <= 0) return null;
  return {
    uuid: note.uuid,
    text: note.text,
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    score,
    reason,
    matchedTags,
    matchedTerms,
  };
}

function overlapScore(note: PreparedNote, query: PreparedQuery, matchedTags: string[], matchedTerms: string[]): number {
  const phrase = query.normalizedText.length >= 12 && note.normalizedText.includes(query.normalizedText) ? 6 : 0;
  return matchedTags.length * 12 + matchedTerms.length * 3 + phrase;
}

function bm25Score(corpus: SimilarCorpus, note: PreparedNote, query: PreparedQuery, matchedTags: string[]): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of query.terms) {
    const tf = note.termFreq.get(term) ?? 0;
    if (tf <= 0) continue;
    const df = corpus.docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (corpus.notes.length - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (note.length / Math.max(1, corpus.avgLength)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score + matchedTags.length * 2.5;
}

function chargramScore(note: PreparedNote, query: PreparedQuery, matchedTags: string[]): number {
  if (!query.grams.size || !note.grams.size) return matchedTags.length * 0.35;
  let intersection = 0;
  for (const gram of query.grams) if (note.grams.has(gram)) intersection++;
  const dice = (2 * intersection) / (query.grams.size + note.grams.size);
  return dice + matchedTags.length * 0.35;
}

function hybridWeightedScore(
  corpus: SimilarCorpus,
  note: PreparedNote,
  query: PreparedQuery,
  matchedTags: string[],
  matchedTerms: string[],
): number {
  const overlap = overlapScore(note, query, matchedTags, matchedTerms);
  const bm25 = bm25Score(corpus, note, query, matchedTags);
  const chargram = chargramScore(note, query, matchedTags);
  const overlapNorm = overlap / Math.max(1, query.tags.length * 12 + query.terms.length * 3 + 6);
  const bm25Norm = Math.tanh(bm25 / 4);
  const charNorm = Math.min(1, chargram);
  return overlapNorm * 0.4 + bm25Norm * 0.4 + charNorm * 0.2;
}

function hybridRrfScore(
  corpus: SimilarCorpus,
  note: PreparedNote,
  query: PreparedQuery,
  matchedTags: string[],
  matchedTerms: string[],
): number {
  const overlap = overlapScore(note, query, matchedTags, matchedTerms);
  const bm25 = bm25Score(corpus, note, query, matchedTags);
  const chargram = chargramScore(note, query, matchedTags);
  if (overlap <= 0 && bm25 <= 0 && chargram <= 0) return 0;
  return rrfFromScore(overlap) + rrfFromScore(bm25) + rrfFromScore(chargram);
}

function rrfFromScore(score: number): number {
  return score <= 0 ? 0 : 1 / (60 + Math.max(1, Math.round(100 / score)));
}

function normalizeFreeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charGrams(text: string): Set<string> {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return new Set();
  const padded = `  ${compact}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function buildReason(matchedTags: string[], matchedTerms: string[], noteTags: string[]): string {
  if (matchedTags.length) return `matched #${matchedTags.join(', #')}`;
  if (matchedTerms.length) return `matched ${matchedTerms.join(', ')}`;
  if (noteTags.length) return `similar phrasing · #${noteTags.slice(0, 2).join(', #')}`;
  return 'similar phrasing';
}
