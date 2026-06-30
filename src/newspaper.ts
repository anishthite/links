import type { Note } from './lib/types';
import { escapeAttr, escapeHtml } from './lib/html-escape';
import { noteDisplayTitle, notePreviewText, noteSourceHost } from './lib/link-note';

export type NewspaperPeriod = 'daily' | 'weekly';

const MS_PER_DAY = 86_400_000;
const STORAGE_KEY = 'boardPaperPeriod';
const DEFAULT_PERIOD: NewspaperPeriod = 'weekly';

export function filterEditionNotes(
  notes: Note[],
  period: NewspaperPeriod,
  now = Date.now(),
): Note[] {
  const cutoff = period === 'daily'
    ? startOfLocalDay(now)
    : now - 7 * MS_PER_DAY;
  return notes
    .filter((note) => editionTime(note) >= cutoff)
    .sort((a, b) => editionTime(b) - editionTime(a));
}

export function createNewspaperView(opts: {
  now?: () => number;
  onOpenNote?: (uuid: string) => void;
} = {}): {
  el: HTMLElement;
  render: (notes: Note[]) => void;
  getPeriod: () => NewspaperPeriod;
  setPeriod: (period: NewspaperPeriod) => void;
} {
  const el = document.createElement('section');
  el.className = 'newspaper';
  let period = loadPeriod();
  let lastNotes: Note[] = [];

  el.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const periodButton = target.closest<HTMLButtonElement>('[data-paper-period]');
    if (periodButton?.dataset.paperPeriod === 'daily' || periodButton?.dataset.paperPeriod === 'weekly') {
      period = periodButton.dataset.paperPeriod;
      persistPeriod(period);
      render(lastNotes);
      return;
    }
    if (target.closest('a, button')) return;
    const article = target.closest<HTMLElement>('[data-paper-uuid]');
    const uuid = article?.dataset.paperUuid;
    if (uuid) opts.onOpenNote?.(uuid);
  });

  function render(notes: Note[]) {
    lastNotes = notes;
    const now = opts.now?.() ?? Date.now();
    const edition = filterEditionNotes(notes, period, now);
    const lead = edition[0] ?? null;
    const secondary = edition.slice(1, 4);
    const briefs = edition.slice(4);
    el.innerHTML = [
      renderMasthead(period, edition.length, notes.length, now),
      lead ? renderLeadArticle(lead, now) : renderEmpty(period),
      secondary.length > 0 ? renderSecondary(secondary, now) : '',
      briefs.length > 0 ? renderBriefs(briefs, now) : '',
    ].join('');
  }

  function setPeriod(next: NewspaperPeriod) {
    period = next;
    persistPeriod(period);
    render(lastNotes);
  }

  return { el, render, getPeriod: () => period, setPeriod };
}

function renderMasthead(period: NewspaperPeriod, editionCount: number, totalCount: number, now: number): string {
  const range = period === 'daily' ? 'today' : 'last 7 days';
  return `<header class="paper-masthead">
    <div class="paper-rule"></div>
    <div class="paper-topline">
      <span>${escapeHtml(formatLongDate(now))}</span>
      <span>${editionCount.toLocaleString()} / ${totalCount.toLocaleString()} links</span>
    </div>
    <div class="paper-nameplate">The Links Ledger</div>
    <div class="paper-edition-row">
      <span class="paper-edition">${period === 'daily' ? 'Daily' : 'Weekly'} Edition</span>
      <span class="paper-expiry">front page: ${range}</span>
      <div class="paper-period" role="group" aria-label="paper edition">
        ${periodButton('daily', period)}
        ${periodButton('weekly', period)}
      </div>
    </div>
    <div class="paper-rule"></div>
  </header>`;
}

function periodButton(value: NewspaperPeriod, active: NewspaperPeriod): string {
  const label = value === 'daily' ? 'Daily' : 'Weekly';
  return `<button type="button" class="${value === active ? 'active' : ''}" data-paper-period="${value}" aria-pressed="${value === active}">${label}</button>`;
}

function renderLeadArticle(note: Note, now: number): string {
  return `<article class="paper-article paper-lead" data-paper-uuid="${escapeAttr(note.uuid)}">
    <div class="paper-article-meta">${escapeHtml(metaLine(note, now))}</div>
    <h2>${escapeHtml(noteDisplayTitle(note))}</h2>
    <p>${escapeHtml(notePreviewText(note, 360))}</p>
    ${renderArticleFooter(note)}
  </article>`;
}

function renderSecondary(notes: Note[], now: number): string {
  return `<section class="paper-secondary" aria-label="more headlines">
    ${notes.map((note) => `<article class="paper-article" data-paper-uuid="${escapeAttr(note.uuid)}">
      <div class="paper-article-meta">${escapeHtml(metaLine(note, now))}</div>
      <h3>${escapeHtml(noteDisplayTitle(note))}</h3>
      <p>${escapeHtml(notePreviewText(note, 190))}</p>
      ${renderArticleFooter(note)}
    </article>`).join('')}
  </section>`;
}

function renderBriefs(notes: Note[], now: number): string {
  return `<section class="paper-briefs" aria-label="briefs">
    <div class="paper-section-title">Briefs</div>
    <div class="paper-brief-grid">
      ${notes.map((note) => `<article class="paper-article paper-brief" data-paper-uuid="${escapeAttr(note.uuid)}">
        <div class="paper-article-meta">${escapeHtml(metaLine(note, now))}</div>
        <h3>${escapeHtml(noteDisplayTitle(note))}</h3>
        ${renderArticleFooter(note)}
      </article>`).join('')}
    </div>
  </section>`;
}

function renderArticleFooter(note: Note): string {
  const tags = note.tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  const source = note.sourceUrl
    ? `<a class="paper-source-link" href="${escapeAttr(note.sourceUrl)}" target="_blank" rel="noreferrer noopener" aria-label="open source">source</a>`
    : '';
  if (!tags && !source) return '';
  return `<footer class="paper-article-foot">${tags ? `<div class="paper-tags">${tags}</div>` : '<div></div>'}${source}</footer>`;
}

function renderEmpty(period: NewspaperPeriod): string {
  const label = period === 'daily' ? 'today' : 'this week';
  return `<div class="paper-empty">
    <div class="paper-section-title">No edition links</div>
    <p>No links landed ${label}.</p>
  </div>`;
}

function metaLine(note: Note, now: number): string {
  const host = noteSourceHost(note) || 'saved note';
  return `${host} · ${ageLabel(now, editionTime(note))}`;
}

function editionTime(note: Note): number {
  return note.updatedAt;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function ageLabel(now: number, then: number): string {
  const diff = Math.max(0, now - then);
  const days = Math.floor(diff / MS_PER_DAY);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

function formatLongDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function loadPeriod(): NewspaperPeriod {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'daily' || raw === 'weekly' ? raw : DEFAULT_PERIOD;
  } catch {
    return DEFAULT_PERIOD;
  }
}

function persistPeriod(period: NewspaperPeriod) {
  try { window.localStorage.setItem(STORAGE_KEY, period); } catch { /* private mode */ }
}
