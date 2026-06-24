import { desc, eq } from 'drizzle-orm';

import { db, schema } from '../../db/client';

export const WIKI_KINDS = ['topic', 'project', 'person', 'pattern', 'synthesis'] as const;
export type WikiKind = typeof WIKI_KINDS[number];

export type WikiSourceRef = { uuid: string; updatedAt: number; excerpt: string };
export type WikiPageWire = {
  slug: string;
  title: string;
  kind: WikiKind;
  contentMd: string;
  sourceRefs: WikiSourceRef[];
  relatedSlugs: string[];
  createdAt: number;
  updatedAt: number;
};

const MAX_TITLE = 160;
const MAX_CONTENT = 80_000;
const MAX_SOURCE_REFS = 80;
const MAX_EXCERPT = 500;
const MAX_RELATED = 80;
const KIND_SET = new Set<string>(WIKI_KINDS);

export function normalizeWikiSlug(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const slug = input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || null;
}

export function normalizeWikiKind(input: unknown): WikiKind | null {
  return typeof input === 'string' && KIND_SET.has(input) ? input as WikiKind : null;
}

export function cleanWikiTitle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const title = input.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  return title || null;
}

export function cleanWikiContent(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const content = input.trim().slice(0, MAX_CONTENT);
  return content || null;
}

export function cleanSourceRefs(input: unknown): WikiSourceRef[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: WikiSourceRef[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { uuid?: unknown; updatedAt?: unknown; excerpt?: unknown };
    if (typeof r.uuid !== 'string' || !r.uuid.trim()) continue;
    const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? Math.trunc(r.updatedAt) : null;
    if (updatedAt === null) continue;
    const excerpt = typeof r.excerpt === 'string' ? r.excerpt.trim().replace(/\s+/g, ' ').slice(0, MAX_EXCERPT) : '';
    const key = `${r.uuid}:${updatedAt}:${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uuid: r.uuid.trim(), updatedAt, excerpt });
    if (out.length >= MAX_SOURCE_REFS) break;
  }
  return out;
}

export function cleanRelatedSlugs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const slug = normalizeWikiSlug(raw);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

export function wikiPageToWire(row: typeof schema.wikiPages.$inferSelect): WikiPageWire {
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    contentMd: row.contentMd,
    sourceRefs: safeJsonArray(row.sourceRefsJson) as WikiSourceRef[],
    relatedSlugs: safeJsonArray(row.relatedSlugsJson).filter((x): x is string => typeof x === 'string'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function wikiEventToWire(row: typeof schema.wikiEvents.$inferSelect) {
  return {
    id: row.id,
    action: row.action,
    pageSlug: row.pageSlug,
    sourceRefs: safeJsonArray(row.sourceRefsJson) as WikiSourceRef[],
    summary: row.summary,
    createdAt: row.createdAt,
  };
}

export async function searchWikiPages(d1: D1Database, query: string, limit = 20): Promise<WikiPageWire[]> {
  const q = query.trim().toLowerCase();
  const rows = await db(d1).select().from(schema.wikiPages).orderBy(desc(schema.wikiPages.updatedAt)).all();
  if (!q) return rows.slice(0, limit).map(wikiPageToWire);
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = rows.map((row) => {
    const hay = `${row.title}\n${row.kind}\n${row.slug}\n${row.contentMd}`.toLowerCase();
    const score = terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) + (row.slug.includes(q) || row.title.toLowerCase().includes(q) ? 2 : 0);
    return { row, score };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt);
  return scored.slice(0, limit).map((item) => wikiPageToWire(item.row));
}

export async function upsertWikiPage(d1: D1Database, input: {
  slug?: unknown;
  title: unknown;
  kind: unknown;
  contentMd: unknown;
  sourceRefs?: unknown;
  relatedSlugs?: unknown;
  action?: string;
  summary?: unknown;
}): Promise<WikiPageWire | { error: string }> {
  const title = cleanWikiTitle(input.title);
  const kind = normalizeWikiKind(input.kind);
  const contentMd = cleanWikiContent(input.contentMd);
  const slug = normalizeWikiSlug(input.slug) || normalizeWikiSlug(title);
  if (!slug) return { error: 'valid slug or title required' };
  if (!title) return { error: 'title required' };
  if (!kind) return { error: `kind must be one of ${WIKI_KINDS.join(', ')}` };
  if (!contentMd) return { error: 'contentMd required' };

  const now = Date.now();
  const d = db(d1);
  const existing = await d.select().from(schema.wikiPages).where(eq(schema.wikiPages.slug, slug)).get();
  const sourceRefs = cleanSourceRefs(input.sourceRefs);
  const relatedSlugs = cleanRelatedSlugs(input.relatedSlugs).filter((s) => s !== slug);
  const row = {
    slug,
    title,
    kind,
    contentMd,
    sourceRefsJson: JSON.stringify(sourceRefs),
    relatedSlugsJson: JSON.stringify(relatedSlugs),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) await d.update(schema.wikiPages).set(row).where(eq(schema.wikiPages.slug, slug)).run();
  else await d.insert(schema.wikiPages).values(row).run();

  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.trim().slice(0, 500)
    : `${existing ? 'updated' : 'created'} ${title}`;
  await d.insert(schema.wikiEvents).values({
    action: input.action || (existing ? 'upsert' : 'create'),
    pageSlug: slug,
    sourceRefsJson: JSON.stringify(sourceRefs),
    summary,
    createdAt: now,
  }).run();
  return wikiPageToWire(row);
}

export function safeJsonArray(s: string | null | undefined): unknown[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
