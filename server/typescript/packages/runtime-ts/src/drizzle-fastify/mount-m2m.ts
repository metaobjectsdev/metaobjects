// M:N traversal route — mounts `GET {path}/:id/{relationName}` returning the
// related target rows reached through a junction table.
//
// This is the Drizzle-direct executor for a many-to-many relationship. Codegen
// derives the static descriptor at BUILD time (the source/target junction FK
// columns come from the junction entity's two `identity.reference` children via
// the shared `deriveM2MFields` SSOT — see relation-resolver.ts in codegen-ts),
// then emits a `mountM2mRoute({...})` call carrying those resolved column names.
// At runtime this helper performs the same two-stage join the ObjectManager
// `n2m-resolver` performs, but expressed in Drizzle so it stays self-evident
// Drizzle code in the user's app (no ObjectManager dependency, no metadata at
// runtime — ADR-0001 build-time binding).
//
// Three modes, identical to the runtime resolver:
//   1. Hetero (sourceCol != targetCol entity): junction WHERE sourceCol = :id,
//      collect targetCol, target WHERE pk IN (...).
//   2. Directed self-join: same traversal; codegen picked which junction FK is
//      the source side (via @sourceRefField) → sourceColumn/targetColumn.
//   3. Symmetric self-join: junction WHERE sourceCol = :id OR targetCol = :id;
//      per row the related id is whichever column is NOT the source id.
//
// A target that is a TPH SUBTYPE lives in its discriminator base's table, and the
// junction FK can only point at that base table — so it can hold the id of a row of
// another subtype. `targetDiscriminator` ANDs the subtype predicate into stage 2 so
// only rows of the declared target come back.
//
// The SOURCE has the mirror problem. An M:N declared ON a subtype mounts under that
// subtype's segment (`/auths/bridge/:id/linkedAuths`), but the junction FK still points
// at the shared base table, so a SIBLING subtype's id traverses it just as well and the
// subtype segment in the path would be decorative. `sourceDiscriminator` adds a stage 0
// that checks the source row's own discriminator first.

import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { and, eq, or, inArray } from "drizzle-orm";
import { coerceIdForColumn } from "./util.js";
import { timestampWire } from "../timestamp-wire.js";
import { withContractErrorHandler } from "./route-error-handler.js";

// Loose Drizzle types — the helper works across libsql / better-sqlite3 / pg.
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle instance
type AnyDrizzle = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;

export interface M2mRouteOptions {
  fastify: FastifyInstance;
  /** Source resource path, e.g. "/posts". The route mounts at `{path}/:id/{relationName}`. */
  path: string;
  /** Navigation member name, e.g. "tags" → GET /posts/:id/tags. */
  relationName: string;
  /** User's Drizzle instance. */
  db: AnyDrizzle;
  /** The junction Drizzle table const (e.g. postTags). */
  junctionTable: AnyTable;
  /** The target Drizzle table const (e.g. tags). */
  targetTable: AnyTable;
  /** Junction FK column holding the SOURCE key (physical column name, e.g. "post_id"). */
  sourceColumn: string;
  /** Junction FK column holding the TARGET key (physical column name, e.g. "tag_id"). */
  targetColumn: string;
  /** Target entity PK column (physical column name, e.g. "id"). Defaults to "id". */
  targetPkColumn?: string;
  /** Undirected self-join: union both junction FK columns on read. */
  symmetric: boolean;
  /**
   * The target is a TPH subtype: `targetTable` is its discriminator base's table, and
   * stage 2 keeps only rows whose discriminator `column` (physical name) equals `value`.
   * Absent → every related row is returned, behaviour unchanged.
   */
  targetDiscriminator?: { column: string; value: string };
  /**
   * The SOURCE is a TPH subtype: this route is mounted under the subtype's path segment,
   * but the junction FK addresses the shared base table, so an id belonging to a SIBLING
   * subtype would traverse it successfully and return that sibling's relations. Stage 0
   * reads the source row's discriminator from `table` (the base table the row lives in)
   * and yields an empty list when it is not `value` — the id names no row of THIS
   * subtype, so it has no relations, which is a 200 with `[]` rather than an error.
   * Absent → no source check, behaviour unchanged.
   */
  sourceDiscriminator?: { table: AnyTable; pkColumn: string; column: string; value: string };
  /** Fastify route-level hooks (auth, etc.). */
  routeOptions?: RouteShorthandOptions;
}

export function mountM2mRoute(opts: M2mRouteOptions): void {
  const targetPk = opts.targetPkColumn ?? "id";
  const route = `${opts.path}/:id/${opts.relationName}`;
  // Route-scoped contract error handler — see route-error-handler.ts.
  const ro = withContractErrorHandler(opts.routeOptions);
  const toWire = timestampWire(opts.targetTable);

  opts.fastify.get(route, ro, async (req, reply) => {
    const { id } = req.params as { id: string };

    const srcCol = columnRef(opts.junctionTable, opts.sourceColumn);
    const tgtCol = columnRef(opts.junctionTable, opts.targetColumn);

    // Compare against the junction FK's real type — a numeric-LOOKING id on a
    // TEXT fk must stay a string ('0123' ≠ '123'), or affinity traverses the
    // WRONG source row's relations.
    const sourceId = coerceIdForColumn(srcCol, id);
    if (sourceId === undefined) {
      return reply.code(400).send({ error: "invalid_id" });
    }

    // Stage 0 — the source id must name a row of THIS subtype. Skipping it would let
    // `/auths/bridge/{a Copay's id}/linkedAuths` return that Copay's relations, because
    // the junction FK cannot tell the subtypes apart: it points at the shared base table.
    const srcDisc = opts.sourceDiscriminator;
    if (srcDisc !== undefined) {
      const srcPk = columnRef(srcDisc.table, srcDisc.pkColumn);
      const ownId = coerceIdForColumn(srcPk, id);
      if (ownId === undefined) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const owner = await opts.db
        .select({ d: columnRef(srcDisc.table, srcDisc.column) })
        .from(srcDisc.table)
        .where(eq(srcPk, ownId))
        .limit(1);
      if (owner.length === 0 || String(owner[0]?.d) !== srcDisc.value) return [];
    }

    // Stage 1 — junction rows for this source id.
    const joinWhere = opts.symmetric
      ? or(eq(srcCol, sourceId), eq(tgtCol, sourceId))
      : eq(srcCol, sourceId);
    const joinRows = (await opts.db
      .select({ src: srcCol, tgt: tgtCol })
      .from(opts.junctionTable)
      .where(joinWhere)) as Array<{ src: unknown; tgt: unknown }>;

    // Collect the related target ids. Symmetric: the related endpoint is the
    // column that is NOT the source id (compared by string key to bridge
    // number/bigint-as-string driver skew). Otherwise: always the target column.
    const sourceKey = String(sourceId);
    const relatedIds = new Set<string | number | bigint>();
    for (const r of joinRows) {
      if (!opts.symmetric) {
        addId(relatedIds, r.tgt);
        continue;
      }
      const srcIsSource = r.src != null && String(r.src) === sourceKey;
      // Self-loop (a,a): src matches → relate to a itself (single occurrence).
      if (srcIsSource) addId(relatedIds, r.tgt);
      else addId(relatedIds, r.src);
    }

    if (relatedIds.size === 0) return [];

    // Stage 2 — load the target rows.
    const pkCol = columnRef(opts.targetTable, targetPk);
    const byPk = inArray(pkCol, [...relatedIds]);
    const disc = opts.targetDiscriminator;
    const rows = await opts.db
      .select()
      .from(opts.targetTable)
      .where(disc ? and(byPk, eq(columnRef(opts.targetTable, disc.column), disc.value)) : byPk);
    return (rows as unknown[]).map(toWire);
  });
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
function columnRef(table: AnyTable, physicalName: string): any {
  for (const key of Object.keys(table)) {
    const col = table[key];
    if (col && typeof col === "object" && col.name === physicalName) return col;
  }
  // Fall back to the property-name lookup (covers tables whose TS key == column).
  const direct = table[physicalName];
  if (direct !== undefined) return direct;
  throw new Error(`mountM2mRoute: column '${physicalName}' not found on table`);
}
