import type { SchemaSnapshot } from "../types.js";

/** A rebuilt table that cannot be rebuilt on D1 because a foreign key targets it. */
export interface D1RebuildRefusal {
  /** The table being rebuilt. */
  table: string;
  /** Tables whose foreign key targets `table` (includes `table` itself for a self-reference). */
  referencedBy: string[];
}

/**
 * Of the tables being rebuilt (recreate-and-copy), which are the target of a foreign
 * key in the expected schema? On remote D1 the rebuild recipe's `PRAGMA foreign_keys
 * = OFF` is a no-op inside D1's implicit transaction, so `DROP TABLE` of a referenced
 * table fails with "FOREIGN KEY constraint failed" (#226). Detection uses the target
 * (expected) schema and errs toward refusing.
 */
export function findReferencedRebuilds(
  recreatedTables: ReadonlySet<string>,
  expectedSchema: SchemaSnapshot,
): D1RebuildRefusal[] {
  const refusals: D1RebuildRefusal[] = [];
  for (const t of recreatedTables) {
    const referencedBy = expectedSchema.tables
      .filter((tbl) => tbl.foreignKeys.some((fk) => fk.refTable === t))
      .map((tbl) => tbl.name);
    if (referencedBy.length > 0) refusals.push({ table: t, referencedBy });
  }
  return refusals;
}

/** Thrown at generation time when a D1 migration would rebuild an FK-referenced table. */
export class D1ReferencedTableRebuildError extends Error {
  constructor(public readonly refusals: D1RebuildRefusal[]) {
    super(formatMessage(refusals));
    this.name = "D1ReferencedTableRebuildError";
  }
}

/**
 * Thrown when a D1 FK-cascade rebuild (#241) cannot be ordered because the
 * affected tables form a multi-table foreign-key cycle. Unlike the acyclic case
 * (which the cascade emitter rebuilds via `PRAGMA defer_foreign_keys = ON`), a
 * cycle has no parents-first order, so the rebuild is refused at generation time.
 */
export class D1CyclicForeignKeyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(formatCycleMessage(cycle));
    this.name = "D1CyclicForeignKeyError";
  }
}

function formatCycleMessage(cycle: string[]): string {
  const members = cycle.map((n) => `"${n}"`).join(", ");
  return (
    `Cannot rebuild the following table(s) on Cloudflare D1 — their foreign keys form a ` +
    `cycle: ${members}.\n\n` +
    `The FK-cascade rebuild recipe recreates tables parents-first, which is impossible ` +
    `when tables reference each other in a cycle. Even with ` +
    "`PRAGMA defer_foreign_keys = ON`" +
    ` the DROP/RENAME sequence cannot be ordered to keep every reference valid. To apply ` +
    `this on D1, hand-write the migration (drop the foreign key on one side of the cycle, ` +
    `rebuild the tables, then restore it), or break the cycle in your metadata.`
  );
}

function formatMessage(refusals: D1RebuildRefusal[]): string {
  const lines = refusals.map((r) => {
    const refs = r.referencedBy.map((n) => `"${n}"`).join(", ");
    return `  - "${r.table}" is referenced by a foreign key from ${refs}`;
  });
  return (
    `Cannot rebuild the following table(s) on Cloudflare D1 — each is the target of a ` +
    `foreign key:\n${lines.join("\n")}\n\n` +
    `D1 applies migrations inside an implicit transaction where ` +
    "`PRAGMA foreign_keys = OFF` is a no-op, so dropping a referenced table during the " +
    `rebuild fails with "FOREIGN KEY constraint failed". The rebuild is triggered by a ` +
    `CHECK, column type/nullability/default, foreign-key, or enum-values change on the ` +
    `table. To apply it on D1, hand-write this migration (rebuild the referencing table ` +
    `to temporarily drop its foreign key, rebuild the referenced table, then restore the ` +
    `foreign key), or make the change on an unreferenced table.`
  );
}
