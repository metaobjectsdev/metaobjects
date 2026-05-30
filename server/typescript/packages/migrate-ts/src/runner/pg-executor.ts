// src/runner/pg-executor.ts
import type { Pool } from "pg";
import type { SqlExecutor } from "./apply.js";

/** Executes a migration's SQL in a single BEGIN/COMMIT transaction (ROLLBACK on error). */
export class PgExecutor implements SqlExecutor {
  constructor(private readonly pool: Pool) {}
  async runInTransaction(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }
}
