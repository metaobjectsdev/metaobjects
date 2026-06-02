// src/verify/replay.ts
import type { Kysely } from "kysely";
import { applyPending } from "../apply/apply.js";
import { MIGRATIONS_TABLE } from "../apply/ledger.js";
import { introspect } from "../introspect/index.js";
import { driftAgainstSnapshot, type DriftClassification } from "../drift/classify.js";
import type { Dialect, SchemaSnapshot } from "../types.js";

export interface VerifyReplayArgs {
  /** A FRESH, throwaway database. Replay applies every migration into it from empty. */
  db: Kysely<Record<string, unknown>>;
  dialect: Extract<Dialect, "postgres" | "sqlite">;
  /** Directory holding the committed `<timestamp>-<slug>/up.sql` migrations. */
  migrationsDir: string;
  /** The committed snapshot the migrations are expected to reproduce. */
  snapshot: SchemaSnapshot;
}

export interface VerifyReplayResult extends DriftClassification {
  /** True when the replayed schema matches the snapshot (no drift, no unmanaged). */
  ok: boolean;
}

/**
 * Replay all committed migrations into a fresh database, introspect the result,
 * and compare it to the committed snapshot. A non-empty `drift`/`unmanaged` means
 * the migrations-as-applied diverge from the snapshot — e.g. a hand-edited up.sql
 * that changed structure the metadata-derived snapshot doesn't know about. The
 * ledger sidecar table is excluded from the comparison.
 */
export async function verifyReplay(args: VerifyReplayArgs): Promise<VerifyReplayResult> {
  await applyPending(args.db, args.migrationsDir, { dryRun: false, dialect: args.dialect });
  const introspected = await introspect(args.db, args.dialect);
  const actual: SchemaSnapshot = {
    ...introspected,
    tables: introspected.tables.filter((t) => t.name !== MIGRATIONS_TABLE),
  };
  const classification = await driftAgainstSnapshot(args.snapshot, actual, args.dialect);
  return {
    ...classification,
    ok: classification.drift.length === 0 && classification.unmanaged.length === 0,
  };
}
