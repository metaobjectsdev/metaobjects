// m2m-read.ts — how a many-to-many traversal (FR-018) is read: `GET <source>/{id}/<relation>`
// answers the target rows the junction links the source row to. Framework-neutral: the Fastify
// mount (`mountM2mRoute`) and the generated service (ADR-0067 layer 4) both call it.

import { and, eq, or, inArray } from "drizzle-orm";
import { coerceIdForColumn } from "./drizzle-fastify/util.js";
import { InvalidIdError } from "./read-only-read.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic Drizzle tables and driver handles
type Any = any;

/** One traversal: the junction, the target, and how they join. */
export interface M2mSpec {
  /** The junction Drizzle table const. */
  readonly junctionTable: Any;
  /** The target Drizzle table const. */
  readonly targetTable: Any;
  /** Junction FK column holding the SOURCE key (physical name). */
  readonly sourceColumn: string;
  /** Junction FK column holding the TARGET key (physical name). */
  readonly targetColumn: string;
  /** Target key column (physical name). Default "id". */
  readonly targetPkColumn?: string;
  /** Undirected self-join: union both junction FK columns on read. */
  readonly symmetric: boolean;
  /** The target is a TPH subtype: keep only target rows whose discriminator `column` is `value`. */
  readonly targetDiscriminator?: { readonly column: string; readonly value: string };
  /**
   * The source is a TPH subtype: an id whose row in `table` is not of discriminator `value` names
   * no row of this subtype, so it has no relations (an empty list, not an error).
   */
  readonly sourceDiscriminator?: { readonly table: Any; readonly pkColumn: string; readonly column: string; readonly value: string };
}

/**
 * The target rows the junction links source `id` to: empty when there are none, or when `id` names
 * no row of the source subtype. Throws `InvalidIdError` for an id that is no key of the junction's
 * source column.
 */
export async function m2mRelated(db: Any, spec: M2mSpec, id: string | number): Promise<Record<string, unknown>[]> {
  const targetPk = spec.targetPkColumn ?? "id";
  const srcCol = columnRef(spec.junctionTable, spec.sourceColumn);
  const tgtCol = columnRef(spec.junctionTable, spec.targetColumn);

  const sourceId = coerceIdForColumn(srcCol, String(id));
  if (sourceId === undefined) throw new InvalidIdError();

  // Stage 0: a TPH subtype source must be a row of THIS subtype, or it has no relations here.
  const srcDisc = spec.sourceDiscriminator;
  if (srcDisc !== undefined) {
    const srcPk = columnRef(srcDisc.table, srcDisc.pkColumn);
    const ownId = coerceIdForColumn(srcPk, String(id));
    if (ownId === undefined) throw new InvalidIdError();
    const owner = await db.select({ d: columnRef(srcDisc.table, srcDisc.column) }).from(srcDisc.table).where(eq(srcPk, ownId)).limit(1);
    if (owner.length === 0 || String(owner[0]?.d) !== srcDisc.value) return [];
  }

  // Stage 1: the junction rows. A symmetric self-join reads both FK columns.
  const joinWhere = spec.symmetric ? or(eq(srcCol, sourceId), eq(tgtCol, sourceId)) : eq(srcCol, sourceId);
  const joinRows = (await db.select({ src: srcCol, tgt: tgtCol }).from(spec.junctionTable).where(joinWhere)) as Array<{ src: unknown; tgt: unknown }>;
  const sourceKey = String(sourceId);
  const relatedIds = new Set<string | number | bigint>();
  for (const r of joinRows) {
    if (!spec.symmetric) {
      addId(relatedIds, r.tgt);
      continue;
    }
    // The other side of each edge is the related id; a self-loop names the source on both.
    if (r.src != null && String(r.src) === sourceKey) addId(relatedIds, r.tgt);
    else addId(relatedIds, r.src);
  }
  if (relatedIds.size === 0) return [];

  // Stage 2: the target rows.
  const byPk = inArray(columnRef(spec.targetTable, targetPk), [...relatedIds]);
  const disc = spec.targetDiscriminator;
  return (await db
    .select()
    .from(spec.targetTable)
    .where(disc ? and(byPk, eq(columnRef(spec.targetTable, disc.column), disc.value)) : byPk)) as Record<string, unknown>[];
}

function addId(set: Set<string | number | bigint>, v: unknown): void {
  if (v === null || v === undefined) return;
  // Keep bigint AS bigint — Number(bigint) silently loses precision above
  // 2^53, so a field.long id could round to a DIFFERENT row's key. Drizzle
  // binds bigint params natively; the driver never needed the narrowing.
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") set.add(v);
}

/**
 * Resolve a physical column name to its Drizzle column object. Drizzle exposes
 * columns on the table object keyed by the TS property name, but the underlying
 * `.name` is the physical column. The descriptor carries physical names (what
 * the junction/target SQL uses), so match on `.name` and fall back to the key.
 */
// biome-ignore lint/suspicious/noExplicitAny: returns a Drizzle column ref for the loose query builder
function columnRef(table: Any, physicalName: string): Any {
  for (const key of Object.keys(table)) {
    const col = table[key];
    if (col && typeof col === "object" && col.name === physicalName) return col;
  }
  // Fall back to the property-name lookup (covers tables whose TS key == column).
  const direct = table[physicalName];
  if (direct !== undefined) return direct;
  throw new Error(`m2m traversal: column '${physicalName}' not found on table`);
}
