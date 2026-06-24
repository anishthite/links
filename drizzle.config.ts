// Drizzle config — kept here for future drizzle-kit usage.
// v0 uses hand-written SQL migrations in db/migrations/*.sql
// (see D-024). Once drizzle-kit is wired, run:
//   npx drizzle-kit generate
//   wrangler d1 execute board-db --local --file db/migrations/<latest>.sql
import type { Config } from 'drizzle-orm/d1';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
} satisfies Config;
