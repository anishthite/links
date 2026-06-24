import type { NoteRow } from '../../db/schema';

export type LinkTopic = typeof LINK_TOPICS[number];
export type Confidence = 'high' | 'medium' | 'low';
export type LinkTaggableNote = Pick<
  NoteRow,
  'uuid' | 'text' | 'sourceUrl' | 'sourceTitle' | 'sourceDescription' | 'sourceSiteName' | 'sourceContentText'
>;
export type LinkTagPrediction = {
  tags: LinkTopic[];
  primary: LinkTopic;
  confidence: Confidence;
  rationale: string;
};

type AutoTagItem = {
  uuid?: unknown;
  suggested_tags?: unknown;
  primary?: unknown;
  confidence?: unknown;
  rationale?: unknown;
};

type Rule = {
  topic: LinkTopic;
  weight: number;
  reason: string;
  patterns: RegExp[];
};

export const LINK_TOPICS = [
  'ai',
  'agents',
  'career',
  'design',
  'focus',
  'founders',
  'philosophy',
  'psychology',
  'research',
  'tools',
  'writing',
] as const;

const TOPIC_SET = new Set<string>(LINK_TOPICS);

const DEFINITIONS = [
  'ai=general AI, frontier labs, models, AI industry, model capabilities, AI strategy',
  'agents=coding agents, harnesses, autonomous workflows, eval harnesses, sandboxed agent systems',
  'career=job search, hiring, mentorship, career choices, professional growth, networking',
  'design=UI polish, visual taste, typography, wireframing, component craft, product aesthetics',
  'focus=discipline, concentration, productivity, consistency, motivation for doing the work',
  'founders=startups, company-building, markets, go-to-market, operators, founders, software factories',
  'philosophy=meaning, agency, values, worldview, ethics, life principles, broad reflections on how to live',
  'psychology=self-image, behavior, identity, emotions, cognition, mindset, inner change',
  'research=experiments, evals, benchmarks, scientific/technical lectures, research process, study plans',
  'tools=software tools, libraries, SDKs, local setups, code review tools, practical implementation guides',
  'writing=essays about writing, communication, plain language, structuring prose, essays as craft',
].join('\n');

const STYLE_GUIDE = [
  'Tags are topics only. Do not encode source type, medium, workflow state, favorites, or "link".',
  'Return 1 or 2 tags only.',
  'primary must be the main filing topic.',
  'Use agents when autonomous tooling or coding harnesses are central; add ai only when the broader AI topic is also central.',
  'Use focus for discipline/productivity/concentration; use psychology for self-image/behavior/identity.',
  'Use philosophy for meaning/agency/worldview/life-principles pieces.',
  'Use tools for practical software/tooling/setup content when AI is not the main subject.',
  'Use founders for startup/company-building/sales/operator content; use career for job and personal career advice.',
  'If a piece is mostly a practical guide, tools/design/writing can outrank the broader umbrella topic.',
].join('\n');

export const LINK_TAG_SYSTEM_PROMPT = [
  'You classify saved links into a small closed topic taxonomy.',
  `Allowed tags: ${LINK_TOPICS.join(', ')}.`,
  `Definitions:\n${DEFINITIONS}`,
  STYLE_GUIDE,
  'Output strict JSON only: {"items":[{"uuid":"...","suggested_tags":["tag"],"primary":"tag","confidence":"high|medium|low","rationale":"short"}]}',
].join('\n');

const RULES: Rule[] = [
  { topic: 'agents', weight: 3, reason: 'agent tooling', patterns: [/\bcoding agents?\b/i, /\bagentic\b/i, /\bharness\b/i, /\bworkflow(?:s)?\b/i, /\bevals? setup\b/i, /\bsandbox(?:ed)?\b/i] },
  { topic: 'ai', weight: 3, reason: 'ai terms', patterns: [/\b(ai|agi|llm|gpt(?:-?\d+(?:\.\d+)?)?|claude|codex|frontier labs?)\b/i, /language modeling/i, /artificial intelligence/i] },
  { topic: 'career', weight: 3, reason: 'career terms', patterns: [/\bcareer\b/i, /\bjob search\b/i, /\bfrontier lab job\b/i, /\bmentorship\b/i, /\byounger self\b/i, /\bnetwork(?:ing)?\b/i, /\bprofessional connections\b/i] },
  { topic: 'design', weight: 3, reason: 'design terms', patterns: [/\bdesign\b/i, /\bui\b/i, /\bux\b/i, /\bwirefram(?:e|ing)\b/i, /\btypograph(?:y|ic)\b/i, /\bkerning\b/i, /\baesthetic(?:s)?\b/i] },
  { topic: 'focus', weight: 3, reason: 'focus terms', patterns: [/\bfocus\b/i, /\bdiscipline\b/i, /\bconcentration\b/i, /\bproductive|productivity\b/i, /\bdopamine\b/i, /\bconsistency\b/i, /\bconfidence\b/i] },
  { topic: 'founders', weight: 3, reason: 'founder terms', patterns: [/\bfounder(?:s)?\b/i, /\bstartup(?:s)?\b/i, /\bsoftware factor(?:y|ies)\b/i, /\boperator(?:s)?\b/i, /\bgo-to-market\b/i, /\bseller\b/i, /\bcompany\b/i, /\bbusiness model\b/i] },
  { topic: 'philosophy', weight: 3, reason: 'philosophy terms', patterns: [/\bmeaning\b/i, /\bagency\b/i, /\bworldview\b/i, /\bethic(?:s|al)\b/i, /\bpurpose\b/i, /\bhow to live\b/i, /\bmind game\b/i, /\bmoral vision\b/i] },
  { topic: 'psychology', weight: 3, reason: 'psychology terms', patterns: [/\bself-image\b/i, /\bidentity\b/i, /\bbehavior\b/i, /\bbehaviour\b/i, /\bmindset\b/i, /\bneural pathways\b/i, /\bbrain\b/i, /\bcognit(?:ion|ive)\b/i, /\bhabit(?:s)?\b/i] },
  { topic: 'research', weight: 3, reason: 'research terms', patterns: [/\bresearch\b/i, /\beval(?:s|uation)?\b/i, /\bexperiment(?:s)?\b/i, /\bbenchmark(?:s)?\b/i, /\blecture(?:s)?\b/i, /\bstudy\b/i, /\bpaper(?:s)?\b/i] },
  { topic: 'tools', weight: 3, reason: 'tools terms', patterns: [/\btool(?:s|ing)?\b/i, /\blibrary\b/i, /\bgithub\b/i, /\bopen source\b/i, /\bsetup\b/i, /\bsdk\b/i, /\bcode review\b/i, /\bhow to setup\b/i, /\bplatform\b/i] },
  { topic: 'writing', weight: 3, reason: 'writing terms', patterns: [/\bwriting\b/i, /\bplain-language\b/i, /\bessay\b/i, /\bprose\b/i, /\brevision\b/i, /\bcommunication\b/i] },
];

const DOMAIN_RULES: Rule[] = [
  { topic: 'tools', weight: 2, reason: 'github domain', patterns: [/github\.com/i] },
  { topic: 'writing', weight: 2, reason: 'essay domain', patterns: [/substack\.com/i, /benkuhn\.net/i, /henrikkarlsson\.xyz/i] },
  { topic: 'research', weight: 2, reason: 'lecture domain', patterns: [/stanford/i, /arxiv\.org/i] },
];

export function buildLinkTagUserPrompt(notes: LinkTaggableNote[]): string {
  return [
    'Classify each saved link by topic.',
    `Return exactly ${notes.length} items, one per uuid.`,
    notes.map((note, index) => [
      `${index + 1}. uuid=${note.uuid}`,
      `title=${JSON.stringify(compact(note.sourceTitle || ''))}`,
      `description=${JSON.stringify(compact(note.sourceDescription || ''))}`,
      `note_text=${JSON.stringify(compact(note.text || ''))}`,
      `url=${JSON.stringify(note.sourceUrl || '')}`,
      `site=${JSON.stringify(note.sourceSiteName || '')}`,
      `content=${JSON.stringify(compact((note.sourceContentText || '').slice(0, 1200)))}`,
    ].join('\n')).join('\n\n'),
  ].join('\n\n');
}

export function heuristicLinkTagPrediction(note: LinkTaggableNote): LinkTagPrediction {
  const text = buildHaystack(note);
  const scores = new Map<LinkTopic, number>();
  const reasons = new Map<LinkTopic, string[]>();

  for (const rule of [...RULES, ...DOMAIN_RULES]) {
    if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
    scores.set(rule.topic, (scores.get(rule.topic) || 0) + rule.weight);
    const existing = reasons.get(rule.topic) || [];
    if (!existing.includes(rule.reason)) existing.push(rule.reason);
    reasons.set(rule.topic, existing);
  }

  // Simple tie-breaks for the common overlaps.
  if ((scores.get('agents') || 0) > 0) scores.set('tools', (scores.get('tools') || 0) + 1);
  if ((scores.get('ai') || 0) > 0 && /(job|career|lab|hiring)/i.test(text)) scores.set('career', (scores.get('career') || 0) + 1);
  if ((scores.get('writing') || 0) > 0 && /(guide|how to|plain-language)/i.test(text)) scores.set('tools', (scores.get('tools') || 0) + 1);
  if ((scores.get('psychology') || 0) > 0 && /(discipline|focus|concentration|confidence)/i.test(text)) scores.set('focus', (scores.get('focus') || 0) + 1);
  if ((scores.get('philosophy') || 0) > 0 && /(behavior|identity|self-image|brain)/i.test(text)) scores.set('psychology', (scores.get('psychology') || 0) + 1);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || LINK_TOPICS.indexOf(a[0]) - LINK_TOPICS.indexOf(b[0]));
  const primary = ranked[0]?.[0] || fallbackTopic(note);
  const secondary = ranked[1] && shouldKeepSecondary(ranked[0]?.[1] || 0, ranked[1][1]) ? ranked[1][0] : null;
  const tags = secondary ? [primary, secondary] : [primary];
  const topScore = ranked[0]?.[1] || 0;
  const confidence: Confidence = topScore >= 4 ? 'high' : topScore >= 2 ? 'medium' : 'low';
  const rationale = [
    reasons.get(primary)?.join(', ') || fallbackReason(primary),
    secondary ? reasons.get(secondary)?.join(', ') : '',
  ].filter(Boolean).join('; ');
  return { tags, primary, confidence, rationale: rationale || fallbackReason(primary) };
}

export function normalizeLinkTagPrediction(raw: AutoTagItem, note: LinkTaggableNote): LinkTagPrediction {
  const fallback = heuristicLinkTagPrediction(note);
  const tags: LinkTopic[] = [];
  if (Array.isArray(raw.suggested_tags)) {
    for (const value of raw.suggested_tags) {
      const topic = normalizeTopic(value);
      if (topic && !tags.includes(topic)) tags.push(topic);
      if (tags.length === 2) break;
    }
  }
  if (tags.length === 0) return fallback;
  const primary = typeof raw.primary === 'string' && tags.includes(normalizeTopic(raw.primary) || fallback.primary)
    ? (normalizeTopic(raw.primary) || tags[0]!)
    : tags[0]!;
  const confidence: Confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
    ? raw.confidence
    : fallback.confidence;
  const rationale = typeof raw.rationale === 'string' && raw.rationale.trim()
    ? raw.rationale.trim().slice(0, 200)
    : fallback.rationale;
  return { tags, primary, confidence, rationale };
}

export function extractAutoTagItems(text: string): AutoTagItem[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const parsed = JSON.parse((fenced?.[1] || text).trim()) as { items?: unknown } | unknown[];
  if (Array.isArray(parsed)) return parsed.filter((item): item is AutoTagItem => !!item && typeof item === 'object');
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
    return (parsed as { items: unknown[] }).items.filter((item): item is AutoTagItem => !!item && typeof item === 'object');
  }
  return [];
}

function normalizeTopic(value: unknown): LinkTopic | null {
  if (typeof value !== 'string') return null;
  const topic = value.toLowerCase().trim().replace(/\s+/g, '-');
  return TOPIC_SET.has(topic) ? (topic as LinkTopic) : null;
}

function buildHaystack(note: LinkTaggableNote): string {
  return [
    note.sourceTitle,
    note.sourceDescription,
    note.text,
    note.sourceSiteName,
    note.sourceUrl,
    (note.sourceContentText || '').slice(0, 3000),
  ].filter(Boolean).join('\n').toLowerCase();
}

function shouldKeepSecondary(top: number, next: number): boolean {
  return next >= 3 || (top >= 4 && next >= 2);
}

function fallbackTopic(note: LinkTaggableNote): LinkTopic {
  const url = (note.sourceUrl || '').toLowerCase();
  if (/github\.com/.test(url)) return 'tools';
  if (/youtube\.com|youtu\.be/.test(url)) return 'research';
  if (/substack\.com|\.blog|\.xyz|\.net/.test(url)) return 'writing';
  return 'philosophy';
}

function fallbackReason(topic: LinkTopic): string {
  switch (topic) {
    case 'tools': return 'tooling/domain fallback';
    case 'research': return 'lecture/video fallback';
    case 'writing': return 'essay/article fallback';
    default: return 'broad topical fallback';
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
