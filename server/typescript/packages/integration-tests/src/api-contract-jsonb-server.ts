// api-contract-jsonb-server.ts — minimal hand-rolled Fastify reference server
// for the `Document` entity from the api-contract-conformance/jsonb/ corpus.
//
// The contract under test is the `field.string @dbColumnType:jsonb` open bag:
// a posted JSON object must round-trip as an object (never a JSON-encoded
// string). This reference lane backs onto the standard runtime-ts
// ObjectManager + Kysely driver, so the jsonb parse/serialize is the same
// code path other runtime tests exercise — the runner only adds the `payload`
// jsonb column to the table and lets the runtime do the rest.
//
// Mirrors api-contract-server.ts (the Author reference) but pared down: the
// jsonb scenario only POSTs + GETs by id (no filter / sort / pagination), so
// this server implements just the verbs the scenario drives.

import Fastify, { type FastifyInstance, type RouteHandlerMethod } from "fastify";
import { type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager, ValidationError } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { executeSql } from "./postgres-sql.ts";
import { bigintAsNumberTypes } from "./pg-bigint-number-types.ts";

const ENTITY = "Document";
const ROUTE_BASE = "/api/documents";

export interface Marker {
  label: string;
  score?: number;
}

export interface DocumentRow {
  id?: number;
  title: string;
  payload?: unknown;
  primaryMarker?: Marker;
  optionalMarker?: Marker | null;
  markers?: Marker[] | null;
}

export interface JsonbServerHandle {
  fastify: FastifyInstance;
  kysely: Kysely<Record<string, never>>;
  baseUrl: string;
  truncate(): Promise<void>;
  applySeed(rows: DocumentRow[]): Promise<void>;
  close(): Promise<void>;
}

export async function startJsonbServer(connectionUri: string, root: MetaRoot): Promise<JsonbServerHandle> {
  const kysely = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({
      // Per-pool bigint→Number (small ids); a global mutation would leak into
      // the persistence-conformance query tests sharing the process.
      pool: new Pool({ connectionString: connectionUri, types: bigintAsNumberTypes }),
    }),
  });

  // Literal column naming (the corpus pins physical name = field name), so a
  // small CREATE TABLE matches the entity. `payload` is a bare jsonb column —
  // the open bag holds any JSON value. The three Marker value-object columns
  // are jsonb too (single / single-nullable / array); `primaryMarker` is
  // @required (NOT NULL). Program D exercises VO-column POST + PATCH here.
  await kysely.schema
    .createTable("documents")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("title", "varchar(200)", (c) => c.notNull())
    .addColumn("payload", "jsonb")
    .addColumn("primaryMarker", "jsonb", (c) => c.notNull())
    .addColumn("optionalMarker", "jsonb")
    .addColumn("markers", "jsonb")
    .execute();

  const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
  const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });

  const fastify = Fastify();

  // A per-field validation failure (FR-035 present-null on a @required field,
  // a value that fails a length rule, or a nested VO constraint) surfaces from
  // om.create/om.update as a ValidationError → the cross-port 400
  // {error:"validation"} envelope. Any other error keeps Fastify's 500.
  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      reply.code(400).send({ error: "validation" });
      return;
    }
    throw err;
  });

  // GET /api/documents/:id
  fastify.get(`${ROUTE_BASE}/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await om.findById(ENTITY, Number(id));
    if (row) return row;
    reply.code(404).send({ error: "not_found" });
    return reply;
  });

  // POST /api/documents
  fastify.post(ROUTE_BASE, async (req, reply) => {
    const row = await om.create(ENTITY, req.body as Record<string, unknown>);
    reply.code(201).send(row);
    return reply;
  });

  // PATCH + PUT /api/documents/:id — FR-035 tristate + VO-column PATCH. A
  // ValidationError (present-null on a @required column, nested VO violation)
  // propagates to the shared setErrorHandler → 400.
  const updateHandler: RouteHandlerMethod = async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await om.update(ENTITY, Number(id), req.body as Record<string, unknown>, {
      ifMissing: "ignore",
    });
    if (row) return row;
    reply.code(404).send({ error: "not_found" });
    return reply;
  };
  fastify.patch(`${ROUTE_BASE}/:id`, updateHandler);
  fastify.put(`${ROUTE_BASE}/:id`, updateHandler);

  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    fastify,
    kysely,
    baseUrl,
    truncate: async () => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "documents" RESTART IDENTITY');
    },
    applySeed: async (rows: DocumentRow[]) => {
      await executeSql(connectionUri, 'TRUNCATE TABLE "documents" RESTART IDENTITY');
      for (const r of rows) {
        await om.create(ENTITY, r as unknown as Record<string, unknown>);
      }
      // Advance the bigserial sequence past max(id) so the next implicit-id
      // create lands at max+1 (the GET-after-POST contract relies on it).
      await executeSql(
        connectionUri,
        `SELECT setval(pg_get_serial_sequence('documents', 'id'), COALESCE((SELECT MAX(id) FROM documents), 1))`,
      );
    },
    close: async () => {
      await fastify.close();
      await kysely.destroy();
    },
  };
}
