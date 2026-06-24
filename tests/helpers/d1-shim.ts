// Minimal D1-compatible facade over `node:sqlite` so vitest can exercise the
// real Hono route handlers (server/routes/notes.ts, server/routes/ai.ts)
// without spinning up wrangler/miniflare. Implements just enough of the
// Cloudflare D1 binding surface to satisfy drizzle-orm/d1 for the queries
// our handlers run:
//
//   prepared = d1.prepare(sql)
//   prepared.bind(...values)
//   prepared.run()    → { success, meta }
//   prepared.all()    → { results, success, meta }
//   prepared.first()  → row | null
//   prepared.raw()    → row[][]
//   d1.batch(stmts)   → results[]
//   d1.exec(sql)      → { count, duration }
//
// This is a TEST-ONLY adapter; the production code path is the real D1
// binding from wrangler. Keep the surface tight: when the route handlers
// start calling a D1 method that's not implemented, add it here.

import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// We use `better-sqlite3` (not Node 22's `node:sqlite` builtin) so that we
// can get positional row access via `stmt.raw(true)` — needed because drizzle
// uses `.raw()` for select-with-join calls (e.g. GET /api/notes), and a
// join with duplicate unqualified column names (notes.uuid + tag_suggestions
// .uuid) collapses to one value in node:sqlite's key-by-name row shape.
//
// better-sqlite3 lets us hand drizzle exactly what its mapper expects.

type Stmt = ReturnType<Database.Database['prepare']>;
type Db = Database.Database;

/** Construct a fresh in-memory database, apply every migration in db/migrations/,
 *  and return a D1-shaped object suitable for drizzle. */
export function freshShimDb(migrationPaths: readonly string[]): D1Database {
  const db = new Database(':memory:');
  for (const p of migrationPaths) {
    db.exec(readFileSync(p, 'utf8'));
  }
  return wrap(db);
}

function wrap(db: Db): D1Database {
  // The cast below trades a small loss of type tightness for a working test
  // path; the surface we implement matches what drizzle-orm/d1 reaches for.
  return {
    prepare(sql: string) {
      return makePrepared(db, sql, []);
    },
    async batch(statements: readonly D1PreparedStatement[]) {
      const out: D1Result[] = [];
      db.exec('BEGIN');
      try {
        for (const s of statements) {
          out.push(await s.run());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return out as never;
    },
    async exec(sql: string) {
      const t0 = Date.now();
      db.exec(sql);
      return { count: 0, duration: Date.now() - t0 } as never;
    },
    async dump() {
      // Not used by our handlers; provided for binding shape compatibility.
      return new ArrayBuffer(0) as never;
    },
    withSession() {
      // Sessions API not used here.
      return wrap(db) as never;
    },
  } as unknown as D1Database;
}

function makePrepared(
  db: Db,
  sql: string,
  boundValues: unknown[],
): D1PreparedStatement {
  return {
    bind(...values: unknown[]) {
      return makePrepared(db, sql, [...boundValues, ...values]);
    },
    async first<T = unknown>(colName?: string): Promise<T | null> {
      const stmt: Stmt = db.prepare(sql);
      const row = stmt.get(...(boundValues as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName) return ((row)[colName] ?? null) as T;
      return row as T;
    },
    async run() {
      const stmt: Stmt = db.prepare(sql);
      const info = stmt.run(...(boundValues as never[]));
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
      const stmt: Stmt = db.prepare(sql);
      // drizzle's `.all()` path is used only for non-mapped selects (no
      // customResultMapper). The column collision problem doesn't apply
      // there because those queries don't join, so name-keyed rows are
      // sufficient. See the comment block at the top of this file.
      const results = stmt.all(...(boundValues as never[])) as T[];
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
      const stmt: Stmt = db.prepare(sql).raw(true);
      // better-sqlite3's `.raw(true)` returns rows as positional arrays, which
      // is what drizzle expects from D1's `.raw()` for select-with-mapping.
      return stmt.all(...(boundValues as never[])) as unknown as T[];
    },
  } as unknown as D1PreparedStatement;
}
