import type { Note } from './lib/types';
import { escapeAttr, escapeHtml } from './lib/html-escape';
import {
  compact,
  noteDisplayTitle,
  noteHasSource,
  notePreviewText,
  noteSearchText,
  noteSourceHost,
} from './lib/link-note';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SOURCE_CANDIDATES = 3;
const TRAIL_COUNT = 3;
const TRAIL_LENGTH = 3;
const VARIANT_POOL_SIZE = 18;

const STOP_WORDS = new Set([
  'about','after','again','against','also','among','amp','and','another','are','because','before','being','between',
  'can','com','could','every','for','from','get','got','gt','has','have','how','http','https','into','its','just',
  'like','more','most','much','need','new','not','notes','note','now','one','only','other','our','out','over',
  'quot','really','same','should','some','such','than','that','the','their','them','then','there','these','thing',
  'this','those','through','tco','too','two','under','using','very','want','was','what','when','where','which',
  'while','who','why','will','with','without','would','www','you','your',
]);

export type ResurfacePick = {
  note: Note;
  score: number;
  ageDays: number;
  extractChars: number;
  host: string;
  reasons: string[];
  keywords: string[];
};

export type TrailStep = {
  note: Note;
  bridge: string;
};

export type LinkTrail = {
  id: string;
  title: string;
  score: number;
  shared: string[];
  steps: TrailStep[];
};

export type ResurfaceModel = {
  notesTotal: number;
  candidatesTotal: number;
  sourcePreferred: boolean;
  generatedAt: number;
  variant: number;
  picks: ResurfacePick[];
  trails: LinkTrail[];
};

type RenderOpts = {
  loadNotes: () => Promise<Note[]>;
  isFallback: () => boolean;
};

type NoteProfile = {
  note: Note;
  pick: ResurfacePick;
  terms: Set<string>;
  topTerms: string[];
};

export async function renderResurfacePage(root: HTMLElement, opts: RenderOpts): Promise<void> {
  root.innerHTML = '';

  const el = document.createElement('main');
  el.className = 'resurface-page';
  el.innerHTML = `
    <section class="resurface-shell resurface-shell--loading" aria-live="polite">
      <div class="resurface-loading">
        <span>resurface</span>
        <strong>reading links</strong>
      </div>
    </section>
  `;
  root.appendChild(el);

  let variant = 0;

  async function refresh(): Promise<void> {
    const refreshBtn = el.querySelector<HTMLButtonElement>('[data-refresh]');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('is-loading');
    }

    const notes = await opts.loadNotes();
    const model = buildResurfaceModel(notes, Date.now(), variant);
    el.innerHTML = renderModel(model, opts.isFallback());
    bindPageActions(el, async () => {
      variant += 1;
      await refresh();
    });
  }

  try {
    await refresh();
  } catch (err) {
    el.innerHTML = `
      <section class="resurface-shell">
        <header class="resurface-topbar">
          <a class="resurface-back" href="/">Board</a>
        </header>
        <div class="resurface-error">
          <span>resurface</span>
          <strong>Could not load links.</strong>
          <code>${escapeHtml(String(err))}</code>
        </div>
      </section>
    `;
  }
}

export function buildResurfaceModel(notes: Note[], now = Date.now(), variant = 0): ResurfaceModel {
  const sourceNotes = notes.filter(isUsefulCandidate).filter(noteHasSource);
  const fallbackNotes = notes.filter(isUsefulCandidate);
  const candidates = sourceNotes.length >= MIN_SOURCE_CANDIDATES ? sourceNotes : fallbackNotes;
  const picks = rotateRanked(rankResurfaceCandidates(candidates, now), variant);
  const profiles = picks.map((pick) => ({
    note: pick.note,
    pick,
    terms: new Set(tokensForNote(pick.note)),
    topTerms: topTermsForNote(pick.note, 6),
  }));

  return {
    notesTotal: notes.length,
    candidatesTotal: candidates.length,
    sourcePreferred: sourceNotes.length >= MIN_SOURCE_CANDIDATES,
    generatedAt: now,
    variant,
    picks: diversifiedPicks(picks, 3),
    trails: buildTrails(profiles),
  };
}

export function rankResurfaceCandidates(notes: Note[], now = Date.now()): ResurfacePick[] {
  return notes
    .map((note) => scoreNote(note, now))
    .sort((a, b) => b.score - a.score || a.note.updatedAt - b.note.updatedAt || a.note.uuid.localeCompare(b.note.uuid));
}

export function buildTrails(profiles: NoteProfile[]): LinkTrail[] {
  const trails: LinkTrail[] = [];
  const usedSeeds = new Set<string>();

  for (const seed of profiles) {
    if (trails.length >= TRAIL_COUNT) break;
    if (usedSeeds.has(seed.note.uuid)) continue;

    const steps: NoteProfile[] = [seed];
    const used = new Set<string>([seed.note.uuid]);

    while (steps.length < TRAIL_LENGTH) {
      const anchor = steps[steps.length - 1]!;
      const next = profiles
        .filter((profile) => !used.has(profile.note.uuid))
        .map((profile) => ({ profile, score: relatedness(anchor, profile) + relatedness(seed, profile) * 0.45 }))
        .filter((item) => item.score >= 0.16)
        .sort((a, b) => b.score - a.score || b.profile.pick.score - a.profile.pick.score)[0]?.profile;
      if (!next) break;
      steps.push(next);
      used.add(next.note.uuid);
    }

    if (steps.length < 2) continue;
    for (const step of steps) usedSeeds.add(step.note.uuid);
    const shared = sharedLabels(steps);
    trails.push({
      id: `trail-${seed.note.uuid}`,
      title: trailTitle(seed, shared),
      score: steps.reduce((sum, step) => sum + step.pick.score, 0),
      shared,
      steps: steps.map((step, index) => ({
        note: step.note,
        bridge: index === 0 ? 'start here' : bridgeLabel(steps[index - 1]!, step),
      })),
    });
  }

  return trails.sort((a, b) => b.score - a.score).slice(0, TRAIL_COUNT);
}

function renderModel(model: ResurfaceModel, fallback: boolean): string {
  const stamp = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(model.generatedAt);
  const pickHtml = model.picks.length > 0
    ? model.picks.map(renderPick).join('')
    : `<div class="resurface-empty">No saved links yet.</div>`;
  const trailHtml = model.trails.length > 0
    ? model.trails.map(renderTrail).join('')
    : `<div class="resurface-empty">Need more overlapping links for trails.</div>`;

  return `
    <section class="resurface-shell">
      <header class="resurface-topbar">
        <div class="resurface-actions">
          <a class="resurface-back" href="/">Board</a>
          <button class="resurface-refresh" data-refresh type="button" aria-label="refresh resurfacing picks" title="refresh picks">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M12.5 6.2A4.8 4.8 0 0 0 3.6 4.4M3.5 2.2v2.7h2.7M3.5 9.8a4.8 4.8 0 0 0 8.9 1.8m.1 2.2v-2.7H9.8" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>refresh</span>
          </button>
        </div>
        <div class="resurface-status">
          <span>${escapeHtml(stamp)}</span>
          <span>${model.candidatesTotal} candidates</span>
          ${model.variant > 0 ? `<span>set ${model.variant + 1}</span>` : ''}
          <span>${fallback ? 'sample' : 'd1'}</span>
        </div>
      </header>

      <section class="resurface-hero">
        <div>
          <p class="resurface-kicker">daily links</p>
          <h1>Three old things worth a second look.</h1>
        </div>
        <div class="resurface-meter" aria-label="corpus summary">
          <span>${model.notesTotal}</span>
          <small>${model.sourcePreferred ? 'saved links scanned' : 'notes scanned'}</small>
        </div>
      </section>

      <section class="resurface-grid" aria-label="Smart resurfacing">
        ${pickHtml}
      </section>

      <section class="trail-section" aria-label="Link trails">
        <div class="section-head">
          <p class="resurface-kicker">rabbit holes</p>
          <h2>Link trails</h2>
        </div>
        <div class="trail-list">
          ${trailHtml}
        </div>
      </section>
    </section>
  `;
}

function renderPick(pick: ResurfacePick, index: number): string {
  const note = pick.note;
  const title = noteDisplayTitle(note);
  const preview = notePreviewText(note, 180);
  const host = pick.host || 'note';
  const tags = note.tags.slice(0, 5).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('');
  const source = note.sourceUrl
    ? `<a class="text-link" href="${escapeAttr(note.sourceUrl)}" target="_blank" rel="noreferrer">source</a>`
    : '';
  return `
    <article class="resurface-pick" style="--rank:${index + 1}">
      <div class="pick-rank">${String(index + 1).padStart(2, '0')}</div>
      <div class="pick-body">
        <div class="pick-meta">
          <span>${escapeHtml(formatAge(pick.ageDays))}</span>
          <span>${escapeHtml(host)}</span>
        </div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(preview)}</p>
        <div class="pick-tags">${tags || '<span>untagged</span>'}</div>
        <div class="pick-foot">
          <span>${pick.reasons.map(escapeHtml).join(' · ')}</span>
          ${source}
        </div>
      </div>
    </article>
  `;
}

function renderTrail(trail: LinkTrail): string {
  const chips = trail.shared.map((label) => `<span>${escapeHtml(label)}</span>`).join('');
  const steps = trail.steps.map((step, index) => renderTrailStep(step, index)).join('');
  return `
    <article class="trail">
      <header class="trail-head">
        <div>
          <h3>${escapeHtml(trail.title)}</h3>
          <div class="trail-shared">${chips || '<span>mixed signals</span>'}</div>
        </div>
        <span class="trail-count">${trail.steps.length} stops</span>
      </header>
      <div class="trail-steps">
        ${steps}
      </div>
    </article>
  `;
}

function renderTrailStep(step: TrailStep, index: number): string {
  const note = step.note;
  const source = note.sourceUrl
    ? `<a class="text-link" href="${escapeAttr(note.sourceUrl)}" target="_blank" rel="noreferrer">open</a>`
    : '';
  const host = noteSourceHost(note);
  return `
    <div class="trail-step">
      <div class="trail-index">${index + 1}</div>
      <div class="trail-copy">
        <span class="trail-bridge">${escapeHtml(step.bridge)}</span>
        <strong>${escapeHtml(noteDisplayTitle(note))}</strong>
        <p>${escapeHtml(notePreviewText(note, 150))}</p>
      </div>
      <div class="trail-side">
        <span>${escapeHtml(host || firstUsefulTag(note) || 'note')}</span>
        ${source}
      </div>
    </div>
  `;
}

function bindPageActions(el: HTMLElement, onRefresh: () => Promise<void>): void {
  el.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const refresh = target.closest<HTMLButtonElement>('[data-refresh]');
    if (refresh) {
      event.preventDefault();
      void onRefresh();
      return;
    }

    const back = target.closest<HTMLAnchorElement>('.resurface-back');
    if (!back) return;
    if (back.origin !== window.location.origin) return;
    event.preventDefault();
    window.location.href = '/';
  });
}

function rotateRanked(picks: ResurfacePick[], variant: number): ResurfacePick[] {
  if (variant <= 0 || picks.length <= 4) return picks;
  const poolSize = Math.min(VARIANT_POOL_SIZE, picks.length);
  const pool = picks.slice(0, poolSize);
  const offset = (variant * 3) % pool.length;
  return [...pool.slice(offset), ...pool.slice(0, offset), ...picks.slice(poolSize)];
}

function scoreNote(note: Note, now: number): ResurfacePick {
  const ageDays = Math.max(0, Math.floor((now - ageTimestamp(note, now)) / DAY_MS));
  const touchedAgeDays = Math.max(0, Math.floor((now - note.updatedAt) / DAY_MS));
  const content = sourceText(note);
  const extractChars = content.length;
  const host = noteSourceHost(note);
  const hasTitle = !!compact(note.sourceTitle || firstLine(note.text));
  const contentSignal = Math.min(44, Math.log2(extractChars + 16) * 4.2);
  const tagSignal = Math.min(14, note.tags.length * 3.4);
  const hostSignal = host ? 7 : 0;
  const titleSignal = hasTitle ? 7 : 0;
  const sourceSignal = noteHasSource(note) ? 7 : 0;
  const ageSignal = Math.min(90, ageDays * 1.2);
  const recencyPenalty = Math.max(0, 5 - touchedAgeDays) * 4;
  const score = ageSignal + contentSignal + tagSignal + hostSignal + titleSignal + sourceSignal - recencyPenalty;

  return {
    note,
    score,
    ageDays,
    extractChars,
    host,
    reasons: signalReasons(note, ageDays, extractChars, host),
    keywords: topTermsForNote(note, 5),
  };
}

function diversifiedPicks(picks: ResurfacePick[], limit: number): ResurfacePick[] {
  const selected: ResurfacePick[] = [];
  const seenHosts = new Set<string>();
  const seenPrimaryTags = new Set<string>();

  for (const pick of picks) {
    if (selected.length >= limit) break;
    const host = pick.host || '';
    const primary = pick.note.tags[0] || '';
    if (selected.length > 0 && host && seenHosts.has(host)) continue;
    if (selected.length > 1 && primary && seenPrimaryTags.has(primary)) continue;
    selected.push(pick);
    if (host) seenHosts.add(host);
    if (primary) seenPrimaryTags.add(primary);
  }

  for (const pick of picks) {
    if (selected.length >= limit) break;
    if (!selected.some((entry) => entry.note.uuid === pick.note.uuid)) selected.push(pick);
  }

  return selected;
}

function isUsefulCandidate(note: Note): boolean {
  return !!compact(noteDisplayTitle(note) || note.text || note.sourceUrl || '');
}

function relatedness(a: NoteProfile, b: NoteProfile): number {
  const tagScore = overlapScore(new Set(a.note.tags), new Set(b.note.tags)) * 0.48;
  const termScore = overlapScore(a.terms, b.terms) * 0.42;
  const hostScore = noteSourceHost(a.note) && noteSourceHost(a.note) === noteSourceHost(b.note) ? 0.10 : 0;
  return tagScore + termScore + hostScore;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function sharedLabels(steps: NoteProfile[]): string[] {
  const tagCounts = new Map<string, number>();
  const termCounts = new Map<string, number>();
  for (const step of steps) {
    for (const tag of step.note.tags) tagCounts.set(`#${tag}`, (tagCounts.get(`#${tag}`) || 0) + 1);
    for (const term of step.topTerms) termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }
  return [...tagCounts, ...termCounts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([label]) => label);
}

function trailTitle(seed: NoteProfile, shared: string[]): string {
  if (shared.length > 0) return shared.slice(0, 2).join(' / ');
  return firstUsefulTag(seed.note) ? `#${firstUsefulTag(seed.note)}` : noteSourceHost(seed.note) || 'mixed trail';
}

function bridgeLabel(prev: NoteProfile, next: NoteProfile): string {
  const sharedTags = prev.note.tags.filter((tag) => next.note.tags.includes(tag));
  if (sharedTags[0]) return `then follow #${sharedTags[0]}`;
  const sharedTerms = prev.topTerms.filter((term) => next.terms.has(term));
  if (sharedTerms[0]) return `then follow ${sharedTerms[0]}`;
  const host = noteSourceHost(next.note);
  return host ? `then switch to ${host}` : 'then widen out';
}

function signalReasons(note: Note, ageDays: number, extractChars: number, host: string): string[] {
  const out = [formatAge(ageDays)];
  if (extractChars > 1600) out.push('long extract');
  else if (extractChars > 420) out.push('substantial note');
  if (note.tags.length > 0) out.push(`${note.tags.length} tags`);
  if (host) out.push(host);
  return out.slice(0, 4);
}

function topTermsForNote(note: Note, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const token of tokensForNote(note)) counts.set(token, (counts.get(token) || 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function tokensForNote(note: Note): string[] {
  const text = [
    noteDisplayTitle(note),
    note.sourceDescription || '',
    note.text,
    (note.sourceContentText || '').slice(0, 6000),
    note.tags.join(' '),
  ].join(' ');
  return tokenize(text);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function sourceText(note: Note): string {
  return compact(note.sourceContentText || note.sourceContentMarkdown || noteSearchText(note) || note.text || '');
}

function ageTimestamp(note: Note, now: number): number {
  const candidates = [note.sourcePublishedAt, note.createdAt, note.updatedAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now);
  return candidates.length > 0 ? Math.min(...candidates) : note.updatedAt;
}

function formatAge(ageDays: number): string {
  if (ageDays <= 0) return 'saved today';
  if (ageDays === 1) return '1 day old';
  if (ageDays < 60) return `${ageDays} days old`;
  const months = Math.floor(ageDays / 30);
  if (months < 18) return `${months} months old`;
  return `${Math.floor(ageDays / 365)} years old`;
}

function firstUsefulTag(note: Note): string {
  return note.tags.find(Boolean) || '';
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}
