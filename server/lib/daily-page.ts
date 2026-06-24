import { asc, desc, eq, gt, lt } from 'drizzle-orm';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

import { db, schema } from '../../db/client';
import type { Env } from '../env';

const DAILY_PAGE_TIMEZONE = 'America/Los_Angeles';
const DAILY_PAGE_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const DAILY_PAGE_PATH = '/daily';
const MS_PER_DAY = 86_400_000;
const MIN_PRESENTABLE_CHARS = 12;
const DAILY_PAGE_STYLE_GUIDE = [
  'Tone: calm, sharp, editorial, useful.',
  'Write like a trusted collaborator, not a hype machine.',
  'Prefer concrete nouns and verbs over abstract inspiration-speak.',
  'Do not claim momentum if the signal is thin.',
  'Do not mention junky titles, numeric scraps, or obviously low-signal notes.',
  'Do not say “the board is leaning toward” unless there are at least two supporting notes.',
  'Use one good image or contrast at most; no purple prose.',
  'Bullets should be actionable and short.',
].join(' ');

type DailyPageRow = typeof schema.dailyPages.$inferSelect;
type NoteRow = typeof schema.notes.$inferSelect;

type DailyPageCard = { title: string; body: string; meta: string; tags: string[] };
type DailyPageSection = { heading: string; items: DailyPageCard[] };
type DailyPageContent = {
  headline: string;
  dek: string;
  summary: string;
  question: string;
  bullets: string[];
  stats: Array<{ label: string; value: string }>;
  sections: DailyPageSection[];
  generatedAtIso: string;
};

type DailyPageContext = {
  now: number;
  timezone: string;
  localDate: string;
  noteCount: number;
  fresh: DailyPageCard[];
  resurfaced: DailyPageCard[];
  hotTags: Array<{ tag: string; count: number; sampleTitles: string[] }>;
  dominantTag: string | null;
  freshCount: number;
};

type DailyPageJobResult =
  | { status: 'generated'; localDate: string; row: DailyPageRow }
  | { status: 'existing'; localDate: string; row: DailyPageRow }
  | { status: 'skipped'; localDate: string; reason: 'outside-hour' };

export async function maybeHandleDailyPageRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === DAILY_PAGE_PATH) return renderDailyPageResponse(env);
  const match = url.pathname.match(/^\/daily\/(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  return renderDailyPageResponse(env, match[1]!);
}

export async function runDailyPageJob(env: Env, now = Date.now()): Promise<DailyPageJobResult> {
  return ensureDailyPage(env, { now, allowOffHour: false });
}

async function renderDailyPageResponse(env: Env, explicitDate?: string): Promise<Response> {
  const timezone = getDailyPageTimezone(env);
  const today = localDateKey(Date.now(), timezone);
  let row = explicitDate
    ? await getDailyPageRow(env.DB, explicitDate)
    : await getDailyPageRow(env.DB, today);

  if (!row && (!explicitDate || explicitDate === today)) {
    const result = await ensureDailyPage(env, { now: Date.now(), allowOffHour: true });
    if (result.status === 'generated' || result.status === 'existing') row = result.row;
  }
  if (!row && !explicitDate) row = await getLatestDailyPageRow(env.DB);

  if (!row) return htmlResponse(renderMissingPage(explicitDate || today), 404);

  const content = parseDailyPageContent(row.contentJson);
  const [prev, next] = await Promise.all([
    getAdjacentDate(env.DB, row.localDate, 'prev'),
    getAdjacentDate(env.DB, row.localDate, 'next'),
  ]);
  return htmlResponse(renderDailyPageDocument(row, content, { prev, next }));
}

async function ensureDailyPage(env: Env, input: { now: number; allowOffHour: boolean }): Promise<DailyPageJobResult> {
  const timezone = getDailyPageTimezone(env);
  const localDate = localDateKey(input.now, timezone);
  if (!input.allowOffHour && localHour(input.now, timezone) !== 7) {
    return { status: 'skipped', localDate, reason: 'outside-hour' };
  }

  const existing = await getDailyPageRow(env.DB, localDate);
  if (existing) return { status: 'existing', localDate, row: existing };

  const context = await buildDailyPageContext(env.DB, input.now, timezone, localDate);
  const content = await buildDailyPageContent(env, context);
  const row = {
    localDate,
    timezone,
    title: content.headline,
    source: envHasBedrock(env) ? 'bedrock-or-fallback' : 'fallback',
    contentJson: JSON.stringify(content),
    createdAt: input.now,
    updatedAt: input.now,
  };
  await db(env.DB).insert(schema.dailyPages).values(row).onConflictDoNothing().run();
  return { status: 'generated', localDate, row: (await getDailyPageRow(env.DB, localDate)) || row };
}

async function getDailyPageRow(d1: D1Database, localDate: string): Promise<DailyPageRow | undefined> {
  return db(d1).select().from(schema.dailyPages).where(eq(schema.dailyPages.localDate, localDate)).get();
}

async function getLatestDailyPageRow(d1: D1Database): Promise<DailyPageRow | undefined> {
  return db(d1).select().from(schema.dailyPages).orderBy(desc(schema.dailyPages.localDate)).limit(1).get();
}

async function getAdjacentDate(d1: D1Database, localDate: string, dir: 'prev' | 'next'): Promise<string | null> {
  const query = db(d1).select({ localDate: schema.dailyPages.localDate }).from(schema.dailyPages)
    .where(dir === 'prev' ? lt(schema.dailyPages.localDate, localDate) : gt(schema.dailyPages.localDate, localDate))
    .orderBy(dir === 'prev' ? desc(schema.dailyPages.localDate) : asc(schema.dailyPages.localDate))
    .limit(1);
  const row = await query.get();
  return row?.localDate || null;
}

async function buildDailyPageContext(d1: D1Database, now: number, timezone: string, localDate: string): Promise<DailyPageContext> {
  const rows = await db(d1).select().from(schema.notes).orderBy(desc(schema.notes.updatedAt)).all();
  const recentCutoff = now - 7 * MS_PER_DAY;
  const resurfacedCutoff = now - 30 * MS_PER_DAY;
  const presentableRows = rows.filter(isPresentableNote);
  const noteCount = rows.length;

  const recentRows = presentableRows.filter((row) => row.updatedAt >= recentCutoff);
  const freshRows = (recentRows.length ? recentRows : presentableRows).slice(0, 6);
  const fresh = freshRows.map((row) => toCard(row, now));

  const hotCounts = new Map<string, { count: number; sampleTitles: string[] }>();
  for (const row of recentRows) {
    const tags = parseTags(row.tags);
    const seen = new Set<string>();
    for (const tag of tags) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      const entry = hotCounts.get(tag) || { count: 0, sampleTitles: [] };
      entry.count += 1;
      const title = bestDisplayTitle(row.text);
      if (title && entry.sampleTitles.length < 2) entry.sampleTitles.push(title);
      hotCounts.set(tag, entry);
    }
  }
  const hotTags = Array.from(hotCounts.entries())
    .map(([tag, value]) => ({ tag, count: value.count, sampleTitles: value.sampleTitles }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 4);

  const hotTagSet = new Set(hotTags.map((item) => item.tag));
  const resurfacedRows = presentableRows
    .filter((row) => row.updatedAt < resurfacedCutoff)
    .map((row) => ({ row, score: resurfacedScore(row, hotTagSet, now) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt)
    .slice(0, 3)
    .map((item) => item.row);
  const resurfaced = resurfacedRows.map((row) => toCard(row, now));

  return {
    now,
    timezone,
    localDate,
    noteCount,
    fresh,
    resurfaced,
    hotTags,
    dominantTag: hotTags[0]?.tag || fresh[0]?.tags[0] || null,
    freshCount: recentRows.length,
  };
}

async function buildDailyPageContent(env: Env, context: DailyPageContext): Promise<DailyPageContent> {
  const fallback = fallbackContent(context);
  const bedrock = makeBedrock(env);
  if (!bedrock) return fallback;

  const prompt = [
    `date=${context.localDate}`,
    `timezone=${context.timezone}`,
    `noteCount=${context.noteCount}`,
    `freshCount=${context.freshCount}`,
    `dominantTag=${context.dominantTag || 'none'}`,
    `hotTags=${JSON.stringify(context.hotTags)}`,
    `fresh=${JSON.stringify(context.fresh.map(minCard))}`,
    `resurfaced=${JSON.stringify(context.resurfaced.map(minCard))}`,
  ].join('\n');

  try {
    const out = await generateText({
      model: bedrock(DAILY_PAGE_MODEL),
      system: [
        'You write a daily page for one person from their notes metadata.',
        'Use only facts in the prompt.',
        DAILY_PAGE_STYLE_GUIDE,
        'Return strict JSON only with keys headline, dek, summary, question, bullets.',
        'headline: 2-6 words, title case, no colon.',
        'dek: one sentence, 8-20 words.',
        'summary: 2 short paragraphs separated by a blank line; each paragraph 1-2 sentences.',
        'question: one specific question worth thinking about today.',
        'bullets: exactly 3 short action bullets, each under 12 words.',
        'No markdown. No code fences. No quotation marks unless naming a note title.',
      ].join(' '),
      prompt,
      temperature: 0.45,
      maxRetries: 1,
    });
    const parsed = parseJsonObject(out.text);
    const headline = cleanHeadline(parsed.headline);
    const dek = cleanLine(parsed.dek);
    const summary = cleanParagraphs(parsed.summary);
    const question = cleanLine(parsed.question);
    const bullets = uniqueLines(Array.isArray(parsed.bullets)
      ? parsed.bullets.map((item) => cleanLine(String(item))).filter(Boolean)
      : []).slice(0, 3);
    if (!headline || !dek || !summary || !question || bullets.length < 3) return fallback;
    return { ...fallback, headline, dek, summary, question, bullets };
  } catch {
    return fallback;
  }
}

function fallbackContent(context: DailyPageContext): DailyPageContent {
  const dominant = context.dominantTag ? humanTag(context.dominantTag) : null;
  const freshLead = context.fresh[0]?.title || 'No fresh notes yet';
  const secondFresh = context.fresh[1]?.title || null;
  const resurfacedLead = context.resurfaced[0]?.title || null;
  const hotLead = context.hotTags[0];

  const headline = dominant
    ? `${dominant} Morning Brief`
    : 'Board Morning Brief';

  const dek = hotLead
    ? `${hotLead.count} recent note${hotLead.count === 1 ? '' : 's'} point at ${humanTag(hotLead.tag).toLowerCase()} as today’s clearest thread.`
    : `${context.fresh.length} note${context.fresh.length === 1 ? '' : 's'} are worth a second look this morning.`;

  const summaryParts = [
    context.fresh.length > 0
      ? `Start with “${freshLead}”${secondFresh ? `, then keep “${secondFresh}” nearby as the supporting thread.` : '.'}`
      : 'Fresh signal is thin this morning, so the page stays intentionally narrow.',
    resurfacedLead
      ? `The best older note to reopen is “${resurfacedLead}”. It has enough shape to turn into a concrete next move.`
      : hotLead
        ? `There is not much worth resurfacing, so keep the page focused on the recent ${humanTag(hotLead.tag).toLowerCase()} cluster.`
        : 'There is no strong old thread to revive today, so bias toward making one new sharp note instead.',
  ];

  const question = resurfacedLead
    ? `What would make “${resurfacedLead}” worth reopening today instead of leaving it archived?`
    : hotLead
      ? `What is the smallest real thing you can ship from the ${humanTag(hotLead.tag).toLowerCase()} thread today?`
      : `Which recent note is closest to becoming something real today?`;

  const bullets = uniqueLines([
    `Start with: ${freshLead}`,
    hotLead ? `Stay with ${humanTag(hotLead.tag).toLowerCase()} for one uninterrupted block.` : 'Write one strong note before noon.',
    resurfacedLead ? `Reopen: ${resurfacedLead}` : 'Skip nostalgia; follow the freshest signal.',
  ]).slice(0, 3);

  return {
    headline,
    dek,
    summary: summaryParts.join('\n\n'),
    question,
    bullets,
    stats: [
      { label: 'notes', value: String(context.noteCount) },
      { label: 'fresh / 7d', value: String(context.freshCount) },
      { label: 'top tag', value: context.dominantTag ? `#${context.dominantTag}` : 'none' },
      { label: 'resurfaced', value: String(context.resurfaced.length) },
    ],
    sections: [
      { heading: 'Fresh sparks', items: context.fresh.slice(0, 4) },
      { heading: 'Worth revisiting', items: context.resurfaced.slice(0, 3) },
      {
        heading: 'Tag weather',
        items: context.hotTags.slice(0, 4).map((item) => ({
          title: `#${item.tag}`,
          body: `${item.count} recent note${item.count === 1 ? '' : 's'}${item.sampleTitles[0] ? `. Latest: “${item.sampleTitles[0]}”.` : '.'}`,
          meta: item.sampleTitles[1] ? `also: ${item.sampleTitles[1]}` : 'recent momentum',
          tags: [item.tag],
        })),
      },
    ].filter((section) => section.items.length > 0),
    generatedAtIso: new Date(context.now).toISOString(),
  };
}

function toCard(row: NoteRow, now: number): DailyPageCard {
  const tags = parseTags(row.tags);
  const title = bestDisplayTitle(row.text) || 'Untitled note';
  const body = bestDisplayBody(row.text, title);
  return {
    title,
    body,
    meta: `${tags.slice(0, 3).map((tag) => `#${tag}`).join(' · ') || 'untagged'} · updated ${ageLabel(now, row.updatedAt)}`,
    tags,
  };
}

function resurfacedScore(row: NoteRow, hotTags: Set<string>, now: number): number {
  if (!isPresentableNote(row)) return -1;
  const tags = parseTags(row.tags);
  const age = Math.max(0, Math.floor((now - row.updatedAt) / MS_PER_DAY));
  const shared = tags.filter((tag) => hotTags.has(tag)).length;
  const title = bestDisplayTitle(row.text);
  let score = 0;
  score += shared * 8;
  score += tags.length > 0 ? 3 : 0;
  score += title && title.length >= 18 ? 2 : 0;
  score += age >= 90 ? 2 : 0;
  score += age >= 365 ? 1 : 0;
  return score;
}

function parseDailyPageContent(raw: string): DailyPageContent {
  const parsed = parseJsonObject(raw);
  return {
    headline: cleanHeadline(parsed.headline) || 'Board Morning Brief',
    dek: cleanLine(parsed.dek) || 'A quick read on what your notes say this morning.',
    summary: cleanParagraphs(parsed.summary) || 'No summary yet.',
    question: cleanLine(parsed.question) || 'What deserves your first hour?',
    bullets: uniqueLines(Array.isArray(parsed.bullets) ? parsed.bullets.map((item) => cleanLine(String(item))).filter(Boolean) : []).slice(0, 3),
    stats: Array.isArray(parsed.stats) ? parsed.stats.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const label = cleanLine(String((item as Record<string, unknown>).label || ''));
      const value = cleanLine(String((item as Record<string, unknown>).value || ''));
      return label && value ? [{ label, value }] : [];
    }).slice(0, 6) : [],
    sections: Array.isArray(parsed.sections) ? parsed.sections.flatMap((section) => {
      if (!section || typeof section !== 'object') return [];
      const heading = cleanLine(String((section as Record<string, unknown>).heading || ''));
      const items = Array.isArray((section as Record<string, unknown>).items)
        ? ((section as Record<string, unknown>).items as unknown[]).flatMap((card) => normalizeCard(card))
        : [];
      return heading && items.length ? [{ heading, items }] : [];
    }).slice(0, 4) : [],
    generatedAtIso: cleanLine(parsed.generatedAtIso) || new Date().toISOString(),
  };
}

function normalizeCard(card: unknown): DailyPageCard[] {
  if (!card || typeof card !== 'object') return [];
  const record = card as Record<string, unknown>;
  const title = cleanLine(String(record.title || ''));
  const body = cleanLine(String(record.body || ''));
  const meta = cleanLine(String(record.meta || ''));
  const tags = Array.isArray(record.tags) ? record.tags.map((item) => cleanLine(String(item))).filter(Boolean).slice(0, 4) : [];
  return title && body ? [{ title, body, meta, tags }] : [];
}

function renderDailyPageDocument(row: DailyPageRow, content: DailyPageContent, nav: { prev: string | null; next: string | null }): string {
  const stats = content.stats.map((item) => `<div class="stat"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('');
  const bullets = content.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const sections = content.sections.map((section) => `
    <section class="panel">
      <div class="panel-head"><h2>${escapeHtml(section.heading)}</h2></div>
      <div class="stack">${section.items.map(renderCard).join('')}</div>
    </section>`).join('');
  const prevHref = nav.prev ? `${DAILY_PAGE_PATH}/${nav.prev}` : DAILY_PAGE_PATH;
  const nextHref = nav.next ? `${DAILY_PAGE_PATH}/${nav.next}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.headline)} · Board Daily</title>
<style>
:root{color-scheme:light;background:#f6f2e8;color:#181612;--ink:#181612;--muted:#6a6258;--line:#d8d0c4;--card:#fffdf9;--accent:#b86f3d;--accent-soft:#f4dfd1}
*{box-sizing:border-box}body{margin:0;font:16px/1.5,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:radial-gradient(circle at top,#fff8ef 0,#f6f2e8 45%,#efe7da 100%)}a{color:inherit}main{max-width:1120px;margin:0 auto;padding:32px 18px 56px}.topbar,.hero,.panel{background:rgba(255,253,249,.88);backdrop-filter:blur(8px);border:1px solid var(--line);box-shadow:0 10px 30px rgba(83,63,37,.08)}.topbar{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px 18px;border-radius:18px;margin-bottom:18px}.brand{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.brand b{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.brand span{color:var(--muted)}.nav{display:flex;gap:10px;flex-wrap:wrap}.nav a{padding:8px 12px;border-radius:999px;border:1px solid var(--line);text-decoration:none;background:#fff}.hero{border-radius:28px;padding:30px 24px;background:linear-gradient(135deg,#fffdf9 0,#fff6ed 60%,#f7ebe0 100%)}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.hero h1{font:600 clamp(36px,7vw,74px)/.95,Georgia,serif;margin:0 0 14px;max-width:11ch}.hero p{margin:0;max-width:72ch;color:#2a241d}.hero .question{margin-top:18px;padding:14px 16px;border-left:4px solid var(--accent);background:var(--accent-soft);border-radius:14px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 0}.stat{padding:14px 16px;border-radius:16px;background:#fff;border:1px solid var(--line)}.stat span{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.stat strong{font-size:24px}.layout{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,.95fr);gap:18px;margin-top:18px}.panel{border-radius:24px;padding:20px}.panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}.panel h2{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0}.panel .summary{margin:0;color:#2a241d;white-space:pre-line}.panel ul{margin:10px 0 0;padding-left:18px}.panel li{margin:8px 0}.stack{display:grid;gap:12px}.card{padding:14px 15px;border-radius:18px;border:1px solid var(--line);background:#fff}.card h3{margin:0 0 6px;font-size:17px;line-height:1.25}.card p{margin:0;color:#312a22}.meta{margin-top:10px;font-size:12px;color:var(--muted)}.footer{margin-top:18px;color:var(--muted);font-size:13px;text-align:center}@media (max-width:900px){.layout{grid-template-columns:1fr}.hero h1{max-width:none}}@media (max-width:640px){main{padding:18px 12px 36px}.topbar,.hero,.panel{border-radius:18px}.hero{padding:22px 18px}.topbar{padding:12px 14px}}
</style>
</head>
<body>
<main>
  <div class="topbar">
    <div class="brand"><b>Board daily</b><span>${escapeHtml(formatLongDate(row.localDate))}</span></div>
    <nav class="nav">
      <a href="/">open board</a>
      ${nav.prev ? `<a href="${prevHref}">← prev</a>` : ''}
      <a href="${DAILY_PAGE_PATH}">today</a>
      ${nextHref ? `<a href="${nextHref}">next →</a>` : ''}
    </nav>
  </div>
  <section class="hero">
    <p class="eyebrow">${escapeHtml(row.localDate)} · ${escapeHtml(row.timezone)}</p>
    <h1>${escapeHtml(content.headline)}</h1>
    <p>${escapeHtml(content.dek)}</p>
    <div class="question"><strong>Question to chase:</strong> ${escapeHtml(content.question)}</div>
    ${stats ? `<div class="stats">${stats}</div>` : ''}
  </section>
  <div class="layout">
    <div class="stack">
      <section class="panel"><div class="panel-head"><h2>Read on the board</h2></div><p class="summary">${escapeHtml(content.summary)}</p></section>
      ${sections}
    </div>
    <div class="stack">
      <section class="panel"><div class="panel-head"><h2>Focus for today</h2></div><ul>${bullets}</ul></section>
      <section class="panel"><div class="panel-head"><h2>Generated</h2></div><p class="summary">${escapeHtml(formatGeneratedAt(content.generatedAtIso, row.timezone))}</p></section>
    </div>
  </div>
  <p class="footer">One page a day, before the coffee gets too opinionated.</p>
</main>
</body>
</html>`;
}

function renderCard(item: DailyPageCard): string {
  return `<article class="card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>${item.meta ? `<div class="meta">${escapeHtml(item.meta)}</div>` : ''}</article>`;
}

function renderMissingPage(localDate: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Daily page missing</title><style>body{font:16px/1.5,-apple-system,system-ui,sans-serif;margin:0;padding:32px;background:#f6f2e8;color:#181612}main{max-width:720px;margin:0 auto;background:#fffdf9;border:1px solid #d8d0c4;border-radius:22px;padding:28px}a{color:inherit}</style></head><body><main><h1>No daily page for ${escapeHtml(localDate)}</h1><p>Try <a href="${DAILY_PAGE_PATH}">${DAILY_PAGE_PATH}</a> for the latest morning brief.</p></main></body></html>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function getDailyPageTimezone(env: Env): string {
  return env.DAILY_PAGE_TIMEZONE || DAILY_PAGE_TIMEZONE;
}

function envHasBedrock(env: Env): boolean {
  return !!makeBedrock(env);
}

function makeBedrock(env: Env) {
  const region = env.AWS_REGION || 'us-east-1';
  if (env.AWS_BEARER_TOKEN_BEDROCK) return createAmazonBedrock({ region, apiKey: env.AWS_BEARER_TOKEN_BEDROCK });
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return createAmazonBedrock({ region, accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN });
}

function localDateKey(timestamp: number, timezone: string): string {
  const parts = zonedParts(timestamp, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localHour(timestamp: number, timezone: string): number {
  return Number(zonedParts(timestamp, timezone).hour);
}

function zonedParts(timestamp: number, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp)).flatMap((part) => part.type === 'literal' ? [] : [[part.type, part.value]]));
}

function formatLongDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year || 0, (month || 1) - 1, day || 1, 12)));
}

function formatGeneratedAt(iso: string, timezone: string): string {
  const date = new Date(iso);
  return `Generated ${new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function isPresentableNote(row: NoteRow): boolean {
  const lines = row.text.split('\n').map((line) => compact(line)).filter(Boolean);
  const best = lines.find(isPresentableLine) || '';
  if (!best) return false;
  const joined = compact(lines.join(' '));
  if (!hasLetters(joined) || joined.length < MIN_PRESENTABLE_CHARS) return false;
  return true;
}

function bestDisplayTitle(text: string): string {
  const lines = text.split('\n').map((line) => compact(line)).filter(Boolean);
  return lines.find(isPresentableLine) || cleanLine(lines[0] || '');
}

function bestDisplayBody(text: string, title: string): string {
  const lines = text.split('\n').map((line) => compact(line)).filter(Boolean);
  const bodyLine = lines.find((line) => line !== title && line.length >= 24 && isPresentableLine(line));
  const fallback = compact(lines.join(' ')).replace(title, '').trim();
  return clip(bodyLine || fallback || title, 180);
}

function isPresentableLine(line: string): boolean {
  const clean = compact(line);
  if (clean.length < 3) return false;
  if (!hasLetters(clean)) return false;
  if (/^[\d\W_]+$/.test(clean)) return false;
  if (/^[a-z]$/i.test(clean)) return false;
  if (/^[a-f0-9]{8,}$/i.test(clean)) return false;
  return true;
}

function hasLetters(text: string): boolean {
  return /[a-z]/i.test(text);
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function ageLabel(now: number, then: number): string {
  const days = Math.max(0, Math.floor((now - then) / MS_PER_DAY));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function cleanHeadline(value: unknown): string {
  return cleanLine(value).replace(/[:.!?]+$/g, '').slice(0, 80);
}

function cleanLine(value: unknown): string {
  return compact(String(value || '')).slice(0, 220);
}

function cleanParagraphs(value: unknown): string {
  return String(value || '')
    .split(/\n{2,}/)
    .map((part) => compact(part))
    .filter(Boolean)
    .slice(0, 2)
    .join('\n\n')
    .slice(0, 900);
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function minCard(card: DailyPageCard) {
  return { title: card.title, body: card.body, meta: card.meta };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] || raw).trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function humanTag(tag: string): string {
  return tag.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
