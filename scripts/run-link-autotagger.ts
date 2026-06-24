#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { runAutoTagger } from '../server/lib/auto-tag';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOCAL_D1_DIR = path.join(REPO, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ROUNDS = 20;

type Args = {
  once: boolean;
  limit: number;
  rounds: number;
};

async function main(): Promise<void> {
  loadDevVars();
  const args = parseArgs(process.argv.slice(2));
  const dbPath = findLocalNotesDbPath();
  const sqlite = new Database(dbPath);
  const d1 = wrap(sqlite);

  console.log(`[tags:links:local] db=${path.relative(REPO, dbPath)}`);
  console.log('[tags:links:local] before', JSON.stringify(readCounts(sqlite)));

  let round = 0;
  while (round < args.rounds) {
    const before = readCounts(sqlite);
    if (before.unprocessed === 0) break;
    round += 1;
    const result = await runAutoTagger({
      DB: d1,
      AUTO_TAG_LIMIT: String(args.limit),
      AWS_REGION: process.env.AWS_REGION,
      AWS_BEARER_TOKEN_BEDROCK: process.env.AWS_BEARER_TOKEN_BEDROCK,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      TAGGER_MODEL_ID: process.env.TAGGER_MODEL_ID,
    } as never);
    const after = readCounts(sqlite);
    console.log(`[tags:links:local] round ${round}`, JSON.stringify({ result, after }));
    if (args.once) break;
    if (result.tagged === 0 && result.suggested === 0) break;
  }

  console.log('[tags:links:local] final', JSON.stringify(readCounts(sqlite)));
}

function parseArgs(argv: string[]): Args {
  let once = false;
  let limit = DEFAULT_LIMIT;
  let rounds = DEFAULT_MAX_ROUNDS;
  for (const arg of argv) {
    if (arg === '--once') once = true;
    else if (arg.startsWith('--limit=')) limit = clampInt(arg.slice('--limit='.length), DEFAULT_LIMIT);
    else if (arg.startsWith('--rounds=')) rounds = clampInt(arg.slice('--rounds='.length), DEFAULT_MAX_ROUNDS);
  }
  return { once, limit, rounds };
}

function clampInt(raw: string, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function loadDevVars(): void {
  const file = path.join(REPO, '.dev.vars');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

function findLocalNotesDbPath(): string {
  const files = readdirSync(LOCAL_D1_DIR)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => path.join(LOCAL_D1_DIR, name));
  for (const file of files) {
    const db = new Database(file, { readonly: true });
    try {
      const row = db.prepare("select 1 as ok from sqlite_master where type='table' and name='notes'").get() as { ok?: number } | undefined;
      if (row?.ok === 1) return file;
    } finally {
      db.close();
    }
  }
  throw new Error('Could not find local Wrangler D1 sqlite with a notes table. Run wrangler once first.');
}

function readCounts(db: Database.Database) {
  const readNum = (sql: string) => Number((db.prepare(sql).get() as { count?: number } | undefined)?.count || 0);
  return {
    notes: readNum("select count(*) as count from notes"),
    tagged: readNum("select count(*) as count from notes where tags <> '[]'"),
    suggested: readNum("select count(*) as count from tag_suggestions where applied_at is null"),
    unprocessed: readNum("select count(*) as count from notes n where (n.tags = '[]' or n.tags is null) and n.source_url is not null and n.source_url <> ''"),
  };
}

function wrap(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      return makePrepared(db, sql, []);
    },
    async batch(statements: readonly D1PreparedStatement[]) {
      const out: D1Result[] = [];
      db.exec('BEGIN');
      try {
        for (const statement of statements) out.push(await statement.run());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return out as never;
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 } as never;
    },
    async dump() {
      return new ArrayBuffer(0) as never;
    },
    withSession() {
      return wrap(db) as never;
    },
  } as unknown as D1Database;
}

function makePrepared(db: Database.Database, sql: string, boundValues: unknown[]): D1PreparedStatement {
  return {
    bind(...values: unknown[]) {
      return makePrepared(db, sql, [...boundValues, ...values]);
    },
    async first<T = unknown>(colName?: string): Promise<T | null> {
      const row = db.prepare(sql).get(...(boundValues as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName) return (row[colName] ?? null) as T;
      return row as T;
    },
    async run() {
      const info = db.prepare(sql).run(...(boundValues as never[]));
      return {
        success: true,
        meta: {
          changes: Number(info.changes ?? 0),
          last_row_id: Number(info.lastInsertRowid ?? 0),
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: Number(info.changes ?? 0),
        },
      } as never;
    },
    async all<T = unknown>() {
      const results = db.prepare(sql).all(...(boundValues as never[])) as T[];
      return {
        results,
        success: true,
        meta: {
          changes: 0,
          last_row_id: 0,
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
        },
      } as never;
    },
    async raw<T = unknown>() {
      return db.prepare(sql).raw(true).all(...(boundValues as never[])) as unknown as T[];
    },
  } as unknown as D1PreparedStatement;
}

main().catch((err) => {
  console.error('[tags:links:local] failed', err);
  process.exit(1);
});
