import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { resolvePgConnection } from "./ssl";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ ...resolvePgConnection(process.env.DATABASE_URL), max: 15 });
export const db = drizzle(pool, { schema });

// Separate connection pool for background jobs (traffic polling, hourly
// billing). These run periodic batch queries touching many rows at once;
// without a dedicated pool, a slow batch job could starve the connections
// needed to serve concurrent user-facing HTTP requests on `pool` above.
export const jobsPool = new Pool({ ...resolvePgConnection(process.env.DATABASE_URL), max: 5 });
export const jobsDb = drizzle(jobsPool, { schema });

export * from "./schema";
