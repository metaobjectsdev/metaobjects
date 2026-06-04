// api-contract-tph-server.ts — the HAND-ROLLED reference lane for the FR-017
// TPH (table-per-hierarchy) contract. The single Drizzle `auths` table + the
// polymorphic / per-subtype route wiring here are declared by hand (not emitted
// by codegen), so the two lanes are independent witnesses of the same contract.
// Both mount the shared `mountCrudRoutes` runtime helper with the
// `discriminator` option — that helper IS the cross-port per-subtype scoping
// semantics, exercised here directly.

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { pgTable, bigserial, text, varchar, integer, numeric, check } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  mountCrudRoutes,
  type FilterAllowlist,
  type SortAllowlist,
} from "@metaobjectsdev/runtime-ts/drizzle-fastify";
import { bigintAsNumberTypes } from "./pg-bigint-number-types.ts";
import { seedTph, type TphSeed } from "./api-contract-tph-generated-server.ts";

export interface TphServerHandle {
  baseUrl: string;
  applySeed(seed: TphSeed): Promise<void>;
  close(): Promise<void>;
}

// Hand-declared single TPH table (the reference, not the emitted one). The
// subtype-only columns are nullable; the base columns follow their @required.
const auths = pgTable(
  "auths",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type", { enum: ["Bridge", "Copay", "PriorAuth"] as const }),
    reference: varchar("reference", { length: 80 }).notNull(),
    quantity: integer("quantity"),
    copayAmount: numeric("copay_amount", { precision: 10, scale: 2 }),
    approver: varchar("approver", { length: 80 }),
  },
  () => [check("chk_auths_type", sql`type IN ('Bridge', 'Copay', 'PriorAuth')`)],
);

// Base entity: polymorphic read surface only (no polymorphic create).
const AuthInsertSchema = z.object({
  type: z.enum(["Bridge", "Copay", "PriorAuth"]).optional(),
  reference: z.string().min(1).max(80),
});
const AuthUpdateSchema = AuthInsertSchema.partial();
const AuthFilterAllowlist = {
  id: { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const, subType: "number" as const, leadingWildcard: false },
  type: { ops: [] as const, subType: "string" as const, leadingWildcard: false },
  reference: { ops: ["eq", "ne", "in", "like", "isNull"] as const, subType: "string" as const, leadingWildcard: false },
} as const satisfies FilterAllowlist;
const AuthSortAllowlist = { id: {}, type: {}, reference: {} } as const satisfies SortAllowlist;

// Per-subtype insert schemas (discriminator pinned, omitted at the route boundary).
const BridgeInsert = z.object({ reference: z.string().min(1).max(80), quantity: z.number().int() });
const CopayInsert = z.object({ reference: z.string().min(1).max(80), copayAmount: z.string().nullable().optional() });
const PriorAuthInsert = z.object({ reference: z.string().min(1).max(80), approver: z.string().max(80).nullable().optional() });

const numberOps = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const;
const stringOps = ["eq", "ne", "in", "like", "isNull"] as const;
const BridgeFilterAllowlist = {
  id: { ops: numberOps, subType: "number" as const, leadingWildcard: false },
  reference: { ops: stringOps, subType: "string" as const, leadingWildcard: false },
  quantity: { ops: numberOps, subType: "number" as const, leadingWildcard: false },
} as const satisfies FilterAllowlist;
const CopayFilterAllowlist = {
  id: { ops: numberOps, subType: "number" as const, leadingWildcard: false },
  reference: { ops: stringOps, subType: "string" as const, leadingWildcard: false },
  copayAmount: { ops: numberOps, subType: "number" as const, leadingWildcard: false },
} as const satisfies FilterAllowlist;
const PriorAuthFilterAllowlist = {
  id: { ops: numberOps, subType: "number" as const, leadingWildcard: false },
  reference: { ops: stringOps, subType: "string" as const, leadingWildcard: false },
  approver: { ops: stringOps, subType: "string" as const, leadingWildcard: false },
} as const satisfies FilterAllowlist;
const BridgeSortAllowlist = { id: {}, reference: {}, quantity: {} } as const satisfies SortAllowlist;
const PriorAuthSortAllowlist = { id: {}, reference: {}, approver: {} } as const satisfies SortAllowlist;
const CopaySortAllowlist = { id: {}, reference: {} } as const satisfies SortAllowlist;

export async function startTphServer(connectionUri: string): Promise<TphServerHandle> {
  const pool = new pg.Pool({ connectionString: connectionUri, types: bigintAsNumberTypes });
  const db = drizzle(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "auths" (
      "id"           bigserial PRIMARY KEY,
      "type"         text,
      "reference"    varchar(80) NOT NULL,
      "quantity"     integer,
      "copay_amount" numeric(10,2),
      "approver"     varchar(80)
    )`);

  const fastify = Fastify();
  await fastify.register(
    async (instance) => {
      mountCrudRoutes({
        fastify: instance, path: "/auths", db, table: auths,
        insertSchema: AuthInsertSchema, updateSchema: AuthUpdateSchema,
        filterAllowlist: AuthFilterAllowlist, sortAllowlist: AuthSortAllowlist,
        dialect: "postgres", expose: ["list", "get"],
      });
      mountCrudRoutes({
        fastify: instance, path: "/auths/bridge", db, table: auths,
        insertSchema: BridgeInsert, updateSchema: BridgeInsert.partial(),
        filterAllowlist: BridgeFilterAllowlist, sortAllowlist: BridgeSortAllowlist,
        dialect: "postgres", discriminator: { column: "type", value: "Bridge" },
      });
      mountCrudRoutes({
        fastify: instance, path: "/auths/copay", db, table: auths,
        insertSchema: CopayInsert, updateSchema: CopayInsert.partial(),
        filterAllowlist: CopayFilterAllowlist, sortAllowlist: CopaySortAllowlist,
        dialect: "postgres", discriminator: { column: "type", value: "Copay" },
      });
      mountCrudRoutes({
        fastify: instance, path: "/auths/priorauth", db, table: auths,
        insertSchema: PriorAuthInsert, updateSchema: PriorAuthInsert.partial(),
        filterAllowlist: PriorAuthFilterAllowlist, sortAllowlist: PriorAuthSortAllowlist,
        dialect: "postgres", discriminator: { column: "type", value: "PriorAuth" },
      });
    },
    { prefix: "/api" },
  );
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: TphSeed) => { await seedTph(connectionUri, seed); },
    close: async () => { await fastify.close(); await pool.end(); },
  };
}
