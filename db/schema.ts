// Drizzle schema for D1 (SQLite dialect).
//
// `tags` is stored as a JSON string for v0 simplicity (no junction table yet).
// `color` is nullable — when null, the UI derives the bg from the primary tag.
// `position_x/y` and `z_index` are reserved for future drag-to-reorder (L-002).
// `content_hash` is sha256(normalized text) truncated to 22 hex chars, used by
// importers for cross-source dedup. Nullable; UNIQUE — see D-009.

import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  uuid:        text('uuid').primaryKey(),
  text:        text('text').notNull(),
  tags:        text('tags').notNull().default('[]'),       // JSON-encoded string[]
  color:       text('color'),                              // nullable; null → derive
  positionX:   real('position_x'),                         // reserved (L-002)
  positionY:   real('position_y'),
  zIndex:      integer('z_index').notNull().default(0),
  createdAt:   integer('created_at', { mode: 'number' }).notNull(),  // epoch ms
  updatedAt:   integer('updated_at', { mode: 'number' }).notNull(),  // epoch ms
  // Separate timestamp for tag-only mutations so they don't reshuffle the
  // reverse-chrono sort by `updated_at`. See implementation-notes/
  // 2026-06-02-tags-standalone.html#D-002. Nullable for rows that predate
  // the standalone-tags migration.
  tagsUpdatedAt: integer('tags_updated_at', { mode: 'number' }),
  contentHash: text('content_hash'),                       // nullable, UNIQUE (importer-set; D-009)
  sourceUrl: text('source_url'),
  sourceUrlNormalized: text('source_url_normalized'),
  sourceTitle: text('source_title'),
  sourceDescription: text('source_description'),
  sourceSiteName: text('source_site_name'),
  sourceAuthor: text('source_author'),
  sourcePublishedAt: integer('source_published_at', { mode: 'number' }),
  sourceFetchedAt: integer('source_fetched_at', { mode: 'number' }),
  sourceContentText: text('source_content_text'),
  sourceContentMarkdown: text('source_content_markdown'),
  sourceStatus: text('source_status', { enum: ['ready', 'failed'] }),
  sourceLastError: text('source_last_error'),
});

export type NoteRow = typeof notes.$inferSelect;
export type InsertNoteRow = typeof notes.$inferInsert;

// Persistent classifier suggestions (Phase-5 backfill + on-create steady-state).
// One row per note that has a pending or accepted suggestion. uuid joins `notes`.
// Loaded from db/tag-suggestions-final.jsonl via scripts/load-suggestions.ts.
// Schema mirrors db/migrations/0002_tag_suggestions.sql.
export const tagSuggestions = sqliteTable('tag_suggestions', {
  uuid:          text('uuid').primaryKey().references(() => notes.uuid, { onDelete: 'cascade' }),
  suggestedTags: text('suggested_tags').notNull(),                   // JSON-encoded string[]
  primaryTag:    text('primary_tag').notNull(),                      // always ∈ suggestedTags
  confidence:    text('confidence', { enum: ['high', 'medium', 'low'] }).notNull(),
  rationale:     text('rationale'),                                  // nullable
  appliedAt:     integer('applied_at', { mode: 'number' }),          // null = pending
  createdAt:     integer('created_at', { mode: 'number' }).notNull(),
});

export type TagSuggestionRow = typeof tagSuggestions.$inferSelect;
export type InsertTagSuggestionRow = typeof tagSuggestions.$inferInsert;

// AI arrange prompt log — see db/migrations/0004_ai_arrange_log.sql and
// PLAN-whiteboard.md §11 Q4. Append-only; never read by the UI in v1.
export const aiArrangeLog = sqliteTable('ai_arrange_log', {
  id:             integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  prompt:         text('prompt').notNull(),
  strategy:       text('strategy').notNull(),
  explanation:    text('explanation').notNull(),
  updatesCount:   integer('updates_count', { mode: 'number' }).notNull().default(0),
  affectedUuids:  text('affected_uuids').notNull().default('[]'),
  selectedUuids:  text('selected_uuids'),
  status:         text('status', { enum: ['ok', 'empty', 'error'] }).notNull(),
  errorDetail:    text('error_detail'),
  durationMs:     integer('duration_ms', { mode: 'number' }).notNull().default(0),
  createdAt:      integer('created_at', { mode: 'number' }).notNull(),
});

export type AiArrangeLogRow = typeof aiArrangeLog.$inferSelect;
export type InsertAiArrangeLogRow = typeof aiArrangeLog.$inferInsert;

// Sandbox agent session metadata. First slice tracks lifecycle only; turns,
// artifacts, and daemon heartbeats land in later migrations.
export const agentSessions = sqliteTable('agent_sessions', {
  id:                text('id').primaryKey(),
  provider:          text('provider').notNull(),
  providerSessionId: text('provider_session_id'),
  title:             text('title'),
  status:            text('status').notNull(),
  ownerEmail:        text('owner_email').notNull(),
  previewUrl:        text('preview_url'),
  cwd:               text('cwd'),
  errorMessage:      text('error_message'),
  piSessionId:       text('pi_session_id'),
  piSessionFile:     text('pi_session_file'),
  piCwd:             text('pi_cwd'),
  piLeafEntryId:     text('pi_leaf_entry_id'),
  createdAt:         integer('created_at', { mode: 'number' }).notNull(),
  updatedAt:         integer('updated_at', { mode: 'number' }).notNull(),
  deletedAt:         integer('deleted_at', { mode: 'number' }),
});

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type InsertAgentSessionRow = typeof agentSessions.$inferInsert;

export const agentTurns = sqliteTable('agent_turns', {
  id:        integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  seq:       integer('seq', { mode: 'number' }).notNull(),
  role:      text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  kind:      text('kind', { enum: ['message', 'status', 'error', 'summary'] }).notNull(),
  content:   text('content').notNull(),
  piEntryId: text('pi_entry_id'),
  piParentEntryId: text('pi_parent_entry_id'),
  piMessageRole: text('pi_message_role'),
  rawMessageJson: text('raw_message_json'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
});

export type AgentTurnRow = typeof agentTurns.$inferSelect;
export type InsertAgentTurnRow = typeof agentTurns.$inferInsert;

export const agentEvents = sqliteTable('agent_events', {
  id:          integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  sessionId:   text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  turnId:      integer('turn_id', { mode: 'number' }).references(() => agentTurns.id, { onDelete: 'set null' }),
  seq:         integer('seq', { mode: 'number' }).notNull(),
  type:        text('type').notNull(),
  name:        text('name'),
  payloadJson: text('payload_json').notNull().default('{}'),
  piEntryId: text('pi_entry_id'),
  piParentEntryId: text('pi_parent_entry_id'),
  toolCallId: text('tool_call_id'),
  rawEntryJson: text('raw_entry_json'),
  createdAt:   integer('created_at', { mode: 'number' }).notNull(),
});

export type AgentEventRow = typeof agentEvents.$inferSelect;
export type InsertAgentEventRow = typeof agentEvents.$inferInsert;

export const agentArtifacts = sqliteTable('agent_artifacts', {
  id:           integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  sessionId:    text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  turnId:       integer('turn_id', { mode: 'number' }).references(() => agentTurns.id, { onDelete: 'set null' }),
  kind:         text('kind').notNull(),
  pathOrKey:    text('path_or_key'),
  title:        text('title'),
  contentText:  text('content_text'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt:    integer('created_at', { mode: 'number' }).notNull(),
});

export type AgentArtifactRow = typeof agentArtifacts.$inferSelect;
export type InsertAgentArtifactRow = typeof agentArtifacts.$inferInsert;

export const agentPiEntries = sqliteTable('agent_pi_entries', {
  id:           integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  sessionId:    text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  piEntryId:    text('pi_entry_id').notNull(),
  piParentId:   text('pi_parent_id'),
  piType:       text('pi_type').notNull(),
  piTimestamp:  text('pi_timestamp').notNull(),
  role:         text('role'),
  toolCallId:   text('tool_call_id'),
  rawJson:      text('raw_json').notNull(),
  createdAt:    integer('created_at', { mode: 'number' }).notNull(),
});

export type AgentPiEntryRow = typeof agentPiEntries.$inferSelect;
export type InsertAgentPiEntryRow = typeof agentPiEntries.$inferInsert;

export const agentSecrets = sqliteTable('agent_secrets', {
  ownerEmail: text('owner_email').notNull(),
  key:        text('key').notNull(),
  valueJson:  text('value_json').notNull(),
  updatedAt:  integer('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ownerEmail, table.key] }),
}));

export type AgentSecretRow = typeof agentSecrets.$inferSelect;
export type InsertAgentSecretRow = typeof agentSecrets.$inferInsert;

export const dailyPages = sqliteTable('daily_pages', {
  localDate:   text('local_date').primaryKey(),
  timezone:    text('timezone').notNull(),
  title:       text('title').notNull(),
  source:      text('source').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt:   integer('created_at', { mode: 'number' }).notNull(),
  updatedAt:   integer('updated_at', { mode: 'number' }).notNull(),
});

export type DailyPageRow = typeof dailyPages.$inferSelect;
export type InsertDailyPageRow = typeof dailyPages.$inferInsert;

export const wikiPages = sqliteTable('wiki_pages', {
  slug:             text('slug').primaryKey(),
  title:            text('title').notNull(),
  kind:             text('kind', { enum: ['topic', 'project', 'person', 'pattern', 'synthesis'] }).notNull(),
  contentMd:        text('content_md').notNull(),
  sourceRefsJson:   text('source_refs_json').notNull().default('[]'),
  relatedSlugsJson: text('related_slugs_json').notNull().default('[]'),
  createdAt:        integer('created_at', { mode: 'number' }).notNull(),
  updatedAt:        integer('updated_at', { mode: 'number' }).notNull(),
});

export type WikiPageRow = typeof wikiPages.$inferSelect;
export type InsertWikiPageRow = typeof wikiPages.$inferInsert;

export const wikiEvents = sqliteTable('wiki_events', {
  id:             integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  action:         text('action').notNull(),
  pageSlug:       text('page_slug'),
  sourceRefsJson: text('source_refs_json').notNull().default('[]'),
  summary:        text('summary').notNull(),
  createdAt:      integer('created_at', { mode: 'number' }).notNull(),
});

export type WikiEventRow = typeof wikiEvents.$inferSelect;
export type InsertWikiEventRow = typeof wikiEvents.$inferInsert;
