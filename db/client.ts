// Tiny Drizzle wrapper. Server routes call `db(env)` and get a typed client.
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function db(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type DB = ReturnType<typeof db>;
export { schema };
