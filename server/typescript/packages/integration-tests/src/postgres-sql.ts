// Thin pg helpers shared between the migration + query scenario runners.
// Both runners spin up a one-shot pool per call — Kysely owns its own pool
// elsewhere (see migration-scenario.ts), so these helpers are only used for
// the bootstrap / seed / post-query phases that don't go through Kysely.

import { Pool } from "pg";

export async function executeSql(connectionUri: string, sql: string): Promise<void> {
  const pool = new Pool({ connectionString: connectionUri });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

export async function queryRows(connectionUri: string, sql: string): Promise<Record<string, unknown>[]> {
  const pool = new Pool({ connectionString: connectionUri });
  try {
    const r = await pool.query(sql);
    return r.rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}
