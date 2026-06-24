import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';

import type { Env } from '../env';
import { db, schema } from '../../db/client';
import {
  LINK_TAG_SYSTEM_PROMPT,
  buildLinkTagUserPrompt,
  extractAutoTagItems,
  heuristicLinkTagPrediction,
  normalizeLinkTagPrediction,
  type LinkTagPrediction,
} from './link-tag-service';

export type AutoTagRunResult = {
  considered: number;
  tagged: number;
  suggested: number;
  skipped: number;
  model: string;
  reason?: string;
};

const DEFAULT_TAGGER_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_LIMIT = 25;
const LEGACY_CLOSED_SET = new Set(['idea', 'ai', 'question', 'thought', 'link', 'tweet']);

export async function runAutoTagger(env: Env): Promise<AutoTagRunResult> {
  const model = env.TAGGER_MODEL_ID || DEFAULT_TAGGER_MODEL;
  const limit = clampLimit(env.AUTO_TAG_LIMIT);
  const bedrock = makeBedrock(env);

  const d = db(env.DB);
  const notes = (await d
    .select({ note: schema.notes })
    .from(schema.notes)
    .where(and(
      eq(schema.notes.tags, '[]'),
      isNotNull(schema.notes.sourceUrl),
    ))
    .orderBy(asc(schema.notes.createdAt))
    .limit(limit)
    .all())
    .map((row) => row.note);
  if (notes.length === 0) {
    return { considered: 0, tagged: 0, suggested: 0, skipped: 0, model, reason: bedrock ? undefined : 'heuristic fallback' };
  }

  const predictions = new Map<string, LinkTagPrediction>();
  let reason = bedrock ? undefined : 'heuristic fallback';

  if (bedrock) {
    try {
      const response = await generateText({
        model: bedrock(model),
        system: LINK_TAG_SYSTEM_PROMPT,
        prompt: buildLinkTagUserPrompt(notes),
        temperature: 0,
      });
      for (const item of extractAutoTagItems(response.text)) {
        if (typeof item.uuid !== 'string') continue;
        const note = notes.find((candidate) => candidate.uuid === item.uuid);
        if (!note) continue;
        predictions.set(item.uuid, normalizeLinkTagPrediction(item, note));
      }
    } catch (err) {
      console.error('[auto-tag] model classify failed; falling back to heuristics', err);
      reason = 'model failed, heuristic fallback';
    }
  }

  for (const note of notes) {
    if (!predictions.has(note.uuid)) predictions.set(note.uuid, heuristicLinkTagPrediction(note));
  }

  const now = Date.now();
  let tagged = 0;
  for (const note of notes) {
    const prediction = predictions.get(note.uuid);
    if (!prediction || prediction.tags.length === 0) continue;
    await d.update(schema.notes)
      .set({ tags: JSON.stringify(prediction.tags), tagsUpdatedAt: now })
      .where(eq(schema.notes.uuid, note.uuid))
      .run();
    await d.update(schema.tagSuggestions)
      .set({ appliedAt: now })
      .where(eq(schema.tagSuggestions.uuid, note.uuid))
      .run();
    tagged += 1;
  }

  return {
    considered: notes.length,
    tagged,
    suggested: 0,
    skipped: notes.length - tagged,
    model,
    reason,
  };
}

// Legacy helper kept for the old offline-eval tests. The new link cron does
// not use it, but keeping the export avoids rewriting unrelated fixtures.
export function coverageBoostTags(text: string, inputTags: string[], maxTags = 6): string[] {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tags = inputTags.filter((tag) => LEGACY_CLOSED_SET.has(tag));
  const add = (tag: string) => {
    if (LEGACY_CLOSED_SET.has(tag) && !tags.includes(tag)) tags.push(tag);
  };
  if (/https?:\/\//.test(t)) {
    add('link');
    if (/(twitter\.com|x\.com)/.test(t)) add('tweet');
  }
  if (/\b(ai|gpt|claude|llm|simulate users|usability testing)\b/.test(t)) add('ai');
  if (/^(how|what|why|where|which|do |does |can |should )\b/.test(t)) add('question');
  if (tags.includes('question')) add('thought');
  return tags.slice(0, maxTags);
}

function makeBedrock(env: Env) {
  const region = env.AWS_REGION || 'us-east-1';
  if (env.AWS_BEARER_TOKEN_BEDROCK) return createAmazonBedrock({ region, apiKey: env.AWS_BEARER_TOKEN_BEDROCK });
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return createAmazonBedrock({
    region,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  });
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(100, Math.trunc(n));
}
