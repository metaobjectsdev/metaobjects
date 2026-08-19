// src/verify/replay.ts
import type { Kysely } from "kysely";
import { applyPending } from "../apply/apply.js";
import { MIGRATIONS_TABLE } from "../apply/ledger.js";
import { introspect } from "../introspect/index.js";
import { driftAgainstSnapshot, type DriftClassification } from "../drift/classify.js";
import { excludeFromSnapshot, type GovernedScope } from "../scope.js";
import type { Dialect, SchemaSnapshot } from "../types.js";

export interface VerifyReplayArgs {
  /** A FRESH, throwaway database. Replay applies every migration into it from empty. */
  db: Kysely<Record<string, unknown>>;
  dialect: Extract<Dialect, "postgres" | "sqlite">;
  /** Directory holding the committed `<timestamp>-<slug>/up.sql` migrations. */
  migrationsDir: string;
  /** The committed snapshot the migrations are expected to reproduce. */
  snapshot: SchemaSnapshot;
  /**
   * The scope decision the run made, as `scopeExpectedSchema` reports it.
   *
   * A project declaring `migrate.scope` carries the OTHER owner's tables into its
   * committed snapshot on purpose (`carryForwardOutOfScope`), and its chain — also on
   * purpose — never creates them. Without this they read as missing on every replay,
   * so a scoped project could never use this check at all.
   *
   * Excluded from the SNAPSHOT side only: the replayed database never had them
   * either, so there is nothing to suppress on the actual side. Omitted ⇒ the
   * comparison is byte-for-byte what it was, which is what every unscoped project
   * gets.
   */
  governed?: GovernedScope;
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
  // `excludeFromSnapshot` returns a ScopedExpectedSchema, so take `.snapshot`. With an
  // empty `outOfScope` it returns the SAME object, not an equal copy.
  const expected = args.governed !== undefined
    ? excludeFromSnapshot(args.snapshot, args.governed).snapshot
    : args.snapshot;
  const classification = await driftAgainstSnapshot(expected, actual, args.dialect);
  return {
    ...classification,
    ok: classification.drift.length === 0 && classification.unmanaged.length === 0,
  };
}
