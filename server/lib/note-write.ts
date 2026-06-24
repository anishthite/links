import short from 'short-uuid';

import { absorbInlineHashtags, normalizeTags, unionTagsOrdered } from '../../src/lib/tags';

const translator = short();

export const MAX_TAGS_PER_NOTE = 32;
export const MAX_TEXT_LEN = 50_000;

export function cleanTags(input: unknown): string[] {
  return normalizeTags(input).slice(0, MAX_TAGS_PER_NOTE);
}

export function resolveWrite(bodyTags: unknown, rawText: string): { text: string; tags: string[] } {
  const absorbed = absorbInlineHashtags(rawText);
  const explicit = cleanTags(bodyTags);
  const tags = unionTagsOrdered(explicit, absorbed.tags).slice(0, MAX_TAGS_PER_NOTE);
  return { text: absorbed.text, tags };
}

export function buildNoteInsert(bodyTags: unknown, bodyText: string) {
  const raw = bodyText.slice(0, MAX_TEXT_LEN);
  const { text, tags } = resolveWrite(bodyTags, raw);
  const now = Date.now();
  return {
    uuid: translator.new(),
    text,
    tags: JSON.stringify(tags),
    color: null,
    positionX: null,
    positionY: null,
    zIndex: 0,
    createdAt: now,
    updatedAt: now,
    tagsUpdatedAt: now,
    contentHash: null,
  };
}
