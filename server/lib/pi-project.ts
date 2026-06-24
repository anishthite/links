import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/client';

type D = ReturnType<typeof db>;

type PiEntryRow = typeof schema.agentPiEntries.$inferSelect;

const MAX_STORED_JSON_DEPTH = 6;
const MAX_STORED_JSON_KEYS = 40;
const MAX_STORED_JSON_ITEMS = 40;
const MAX_STORED_STRING_CHARS = 16_000;

export async function projectPiEntries(d: D, sessionId: string, entries: PiEntryRow[]): Promise<{ turns: number; events: number }> {
  let turns = 0;
  let events = 0;
  for (const entry of entries) {
    const raw = safeJson(entry.rawJson);
    if (entry.piType === 'message') {
      const message = isRecord(raw.message) ? raw.message : null;
      const role = typeof message?.role === 'string' ? message.role : null;
      if ((role === 'user' || role === 'assistant') && message) {
        const content = messageToText(message);
        if (!content.trim()) continue;
        const existing = await d.select({ id: schema.agentTurns.id }).from(schema.agentTurns)
          .where(and(eq(schema.agentTurns.sessionId, sessionId), eq(schema.agentTurns.piEntryId, entry.piEntryId))).get();
        if (!existing) {
          const unkeyed = await d.select({ id: schema.agentTurns.id }).from(schema.agentTurns).where(and(
            eq(schema.agentTurns.sessionId, sessionId),
            isNull(schema.agentTurns.piEntryId),
            eq(schema.agentTurns.role, role),
            eq(schema.agentTurns.kind, 'message'),
            eq(schema.agentTurns.content, content),
          )).orderBy(desc(schema.agentTurns.seq)).get();
          if (unkeyed) {
            await d.update(schema.agentTurns).set({
              piEntryId: entry.piEntryId,
              piParentEntryId: entry.piParentId,
              piMessageRole: role,
              rawMessageJson: jsonForStorage(message),
            }).where(eq(schema.agentTurns.id, unkeyed.id)).run();
            turns++;
          } else {
            await d.insert(schema.agentTurns).values({
              sessionId,
              seq: await nextTurnSeq(d, sessionId),
              role,
              kind: 'message',
              content,
              piEntryId: entry.piEntryId,
              piParentEntryId: entry.piParentId,
              piMessageRole: role,
              rawMessageJson: jsonForStorage(message),
              createdAt: Date.parse(entry.piTimestamp) || entry.createdAt,
            });
            turns++;
          }
        }
      } else if ((role === 'toolResult' || role === 'bashExecution') && message) {
        const existing = await d.select({ id: schema.agentEvents.id }).from(schema.agentEvents)
          .where(and(eq(schema.agentEvents.sessionId, sessionId), eq(schema.agentEvents.piEntryId, entry.piEntryId))).get();
        if (!existing) {
          await d.insert(schema.agentEvents).values({
            sessionId,
            turnId: null,
            seq: await nextEventSeq(d, sessionId),
            type: role === 'toolResult' ? 'tool_result' : 'bash_execution',
            name: role === 'toolResult' && typeof message?.toolName === 'string' ? message.toolName : role,
            payloadJson: jsonForStorage(message ?? raw),
            piEntryId: entry.piEntryId,
            piParentEntryId: entry.piParentId,
            toolCallId: typeof message?.toolCallId === 'string' ? message.toolCallId : null,
            rawEntryJson: entry.rawJson,
            createdAt: Date.parse(entry.piTimestamp) || entry.createdAt,
          });
          events++;
        }
      }
    } else if (entry.piType !== 'session') {
      const existing = await d.select({ id: schema.agentEvents.id }).from(schema.agentEvents)
        .where(and(eq(schema.agentEvents.sessionId, sessionId), eq(schema.agentEvents.piEntryId, entry.piEntryId))).get();
      if (!existing) {
        await d.insert(schema.agentEvents).values({
          sessionId,
          turnId: null,
          seq: await nextEventSeq(d, sessionId),
          type: `pi_${entry.piType}`,
          name: entry.piType,
          payloadJson: jsonForStorage(raw),
          piEntryId: entry.piEntryId,
          piParentEntryId: entry.piParentId,
          toolCallId: entry.toolCallId,
          rawEntryJson: entry.rawJson,
          createdAt: Date.parse(entry.piTimestamp) || entry.createdAt,
        });
        events++;
      }
    }
  }
  return { turns, events };
}

async function nextTurnSeq(d: D, sessionId: string): Promise<number> {
  const rows = await d.select({ seq: schema.agentTurns.seq }).from(schema.agentTurns).where(eq(schema.agentTurns.sessionId, sessionId)).all();
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

async function nextEventSeq(d: D, sessionId: string): Promise<number> {
  const rows = await d.select({ seq: schema.agentEvents.seq }).from(schema.agentEvents).where(eq(schema.agentEvents.sessionId, sessionId)).all();
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

function messageToText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return normalizeUserPromptContent(content);
  if (Array.isArray(content)) {
    return normalizeUserPromptContent(content.map((block) => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    }).filter(Boolean).join('\n'));
  }
  return JSON.stringify(message);
}

function normalizeUserPromptContent(text: string): string {
  const marker = '\nUser request:\n';
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return text;
  const suffix = text.slice(idx + marker.length).trim();
  return suffix || text;
}

function jsonForStorage(value: unknown): string {
  return JSON.stringify(clampJsonValue(value, 0));
}

function clampJsonValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STORED_STRING_CHARS ? `${value.slice(0, MAX_STORED_STRING_CHARS)}\n…[truncated]` : value;
  if (depth >= MAX_STORED_JSON_DEPTH) return Array.isArray(value) ? ['…[truncated]'] : { _truncated: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_STORED_JSON_ITEMS).map((item) => clampJsonValue(item, depth + 1));
    if (value.length > MAX_STORED_JSON_ITEMS) items.push(`…[${value.length - MAX_STORED_JSON_ITEMS} more items]`);
    return items;
  }
  if (!isRecord(value)) return String(value);
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, MAX_STORED_JSON_KEYS)) out[key] = clampJsonValue(entryValue, depth + 1);
  if (entries.length > MAX_STORED_JSON_KEYS) out._truncated = `${entries.length - MAX_STORED_JSON_KEYS} more keys`;
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
