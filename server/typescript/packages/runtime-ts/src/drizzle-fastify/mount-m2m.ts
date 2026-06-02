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

import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { eq, or, inArray } from "drizzle-orm";
import { parseId } from "./util.js";

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
  /** Fastify route-level hooks (auth, etc.). */
  routeOptions?: RouteShorthandOptions;
}

export function mountM2mRoute(opts: M2mRouteOptions): void {
  const targetPk = opts.targetPkColumn ?? "id";
  const route = `${opts.path}/:id/${opts.relationName}`;
  const ro = opts.routeOptions ?? {};

  opts.fastify.get(route, ro, async (req) => {
    const { id } = req.params as { id: string };
    const sourceId = parseId(id);

    const srcCol = columnRef(opts.junctionTable, opts.sourceColumn);
    const tgtCol = columnRef(opts.junctionTable, opts.targetColumn);

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
    const relatedIds = new Set<string | number>();
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
    return await opts.db
      .select()
      .from(opts.targetTable)
      .where(inArray(pkCol, [...relatedIds]));
  });
}

function addId(set: Set<string | number>, v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v === "number" || typeof v === "string") set.add(v);
  else if (typeof v === "bigint") set.add(Number(v));
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
