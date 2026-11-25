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
import { m2mRelated } from "../m2m-read.js";
import { InvalidIdError } from "../read-only-read.js";
import { timestampWire } from "../timestamp-wire.js";
import { withWire, type WireOptions } from "../wire-format.js";
import { withContractErrorHandler } from "./route-error-handler.js";

// Loose Drizzle types — the helper works across libsql / better-sqlite3 / pg.
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle instance
type AnyDrizzle = any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over user's Drizzle table
type AnyTable = any;

export interface M2mRouteOptions extends WireOptions {
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
  const toWire = withWire(timestampWire(opts.targetTable), opts);

  opts.fastify.get(route, ro, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return (await m2mRelated(opts.db, opts, id)).map(toWire);
    } catch (e) {
      if (e instanceof InvalidIdError) return reply.code(400).send({ error: "invalid_id" });
      throw e;
    }
  });
}
