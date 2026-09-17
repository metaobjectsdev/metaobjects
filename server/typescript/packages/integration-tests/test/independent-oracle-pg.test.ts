// Independent checks against a live Postgres — the oracle in src/independent-oracle.ts
// asked of real output, on models where a shared code path could otherwise mark its own
// homework (see that module's header for the incident that motivated it).
//
// Four questions, each answered from the metadata by the oracle and from Postgres or the
// running app directly:
//   - does the schema `meta migrate` writes carry every declared FK and column?
//   - does the committed cross-port schema (canonical/schema.postgres.sql, which every
//     port's query runner executes) carry them?
//   - does the generated Drizzle schema declare the same FKs the database has?
//   - does the generated API mount every route the metadata says it serves, and does an
//     M:N onto a TPH subtype return only that subtype's rows?

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  actualColumns, actualForeignKeys, drizzleForeignKeys, expectedColumns, expectedForeignKeys,
  expectedRoutes, fkKey, missingColumns, servedObjects,
} from "../src/independent-oracle.ts";
import { generateApp, generatedPathOf } from "../src/generated-app.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { CANONICAL_COLUMN_NAMING, CANONICAL_SCHEMA_SQL_PATH } from "../src/canonical-schema.ts";
import { CANONICAL_DIR } from "../src/paths.ts";
import { executeSql } from "../src/postgres-sql.ts";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

// A TPH hierarchy with every reference shape that has bitten: an FK onto a subtype, a
// self-join junction onto it, an M:N onto it, a reference declared ON a subtype, and one
// declared on an abstract level between the base and a subtype.
const TPH_REFERENCE_MODEL = {
  "metadata.root": {
    package: "demo",
    children: [
      { "object.entity": { name: "Depot", children: [
        { "source.rdb": { "@table": "depots" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "partyType", "@values": ["Carrier", "Broker"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Organization", extends: "Party", abstract: true, children: [
        { "field.long": { name: "hqDepotId" } },
        { "identity.reference": { name: "fkHqDepot", "@fields": "hqDepotId", "@references": "Depot" } },
      ]}},
      { "object.entity": { name: "Carrier", extends: "Organization", "@discriminatorValue": "Carrier", children: [
        { "field.long": { name: "homeDepotId" } },
        { "identity.reference": { name: "fkHomeDepot", "@fields": "homeDepotId", "@references": "Depot" } },
      ]}},
      { "object.entity": { name: "Broker", extends: "Party", "@discriminatorValue": "Broker", children: [
        { "field.string": { name: "mcNumber", "@maxLength": 20 } },
      ]}},
      { "object.entity": { name: "Shipment", children: [
        { "source.rdb": { "@table": "shipments" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "relationship.association": { name: "carriers", "@cardinality": "many", "@objectRef": "Carrier", "@through": "Leg" } },
      ]}},
      { "object.entity": { name: "Leg", children: [
        { "source.rdb": { "@table": "legs" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "shipmentId", "@required": true } },
        { "field.long": { name: "carrierId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "fkShipment", "@fields": "shipmentId", "@references": "Shipment" } },
        { "identity.reference": { name: "fkCarrier", "@fields": "carrierId", "@references": "Carrier" } },
      ]}},
      { "object.entity": { name: "CarrierPartnership", children: [
        { "source.rdb": { "@table": "carrier_partnerships" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "fromCarrierId", "@required": true } },
        { "field.long": { name: "toCarrierId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "fkFromCarrier", "@fields": "fromCarrierId", "@references": "Carrier" } },
        { "identity.reference": { name: "fkToCarrier", "@fields": "toCarrierId", "@references": "Carrier" } },
      ]}},
    ],
  },
};

async function load(model: unknown): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(model), { id: "oracle-model.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

describe("the oracle states the contract (no database)", () => {
  // The oracle is only worth its independence if its own rules are right, so they are
  // pinned by hand here, once, against a model a person can read.
  test("FKs land on the table storing each side's rows", async () => {
    const fks = expectedForeignKeys(await load(TPH_REFERENCE_MODEL)).map(fkKey);
    expect(fks).toEqual([
      "carrier_partnerships(from_carrier_id) -> parties(id)",
      "carrier_partnerships(to_carrier_id) -> parties(id)",
      "legs(carrier_id) -> parties(id)",
      "legs(shipment_id) -> shipments(id)",
      "parties(home_depot_id) -> depots(id)",
      "parties(hq_depot_id) -> depots(id)",
    ]);
  });

  test("a base table carries the columns of every level beneath it", async () => {
    const cols = expectedColumns(await load(TPH_REFERENCE_MODEL));
    expect([...(cols.get("parties") ?? [])].sort()).toEqual(
      ["home_depot_id", "hq_depot_id", "id", "mc_number", "party_type"],
    );
    expect(cols.has("carriers")).toBe(false);
    expect(cols.has("organizations")).toBe(false);
  });
});

describe("independent checks against Postgres", () => {
  let pgServer: RunningPg;
  beforeAll(async () => { pgServer = await startPostgres(); }, 120_000);
  afterAll(async () => { await pgServer?.stop(); });

  test("the schema meta migrate writes carries every declared FK and column, and no others", async () => {
    const root = await load(TPH_REFERENCE_MODEL);
    const app = await generateApp(root, pgServer.connectionUri, "oracle-migrate");
    try {
      await app.migrate(pgServer.connectionUri);
      const actual = await actualForeignKeys(pgServer.connectionUri);
      expect(actual.map(fkKey)).toEqual(expectedForeignKeys(root).map(fkKey));
      expect(missingColumns(expectedColumns(root), await actualColumns(pgServer.connectionUri))).toEqual([]);
    } finally {
      await app.close();
      await executeSql(pgServer.connectionUri, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
  }, 120_000);

  test("the generated Drizzle schema declares exactly the FKs the database has", async () => {
    const root = await load(TPH_REFERENCE_MODEL);
    const app = await generateApp(root, pgServer.connectionUri, "oracle-drizzle");
    try {
      await app.migrate(pgServer.connectionUri);
      const entityModules = await Promise.all(
        root.objects().map((o) => app.files.includes(`${o.name}.ts`) ? app.importModule(`${o.name}.ts`) : {}),
      );
      expect(drizzleForeignKeys(entityModules).map(fkKey)).toEqual(
        (await actualForeignKeys(pgServer.connectionUri)).map(fkKey),
      );
    } finally {
      await app.close();
      await executeSql(pgServer.connectionUri, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
  }, 120_000);

  test("the generated API mounts every route the metadata says it serves", async () => {
    const root = await load(TPH_REFERENCE_MODEL);
    const app = await generateApp(root, pgServer.connectionUri, "oracle-routes");
    try {
      const paths = new Map<MetaObject, string>();
      for (const obj of servedObjects(root)) paths.set(obj, await generatedPathOf(app, obj));
      const fastify = await app.bootRoutes();
      try {
        const missing = expectedRoutes(root, (o) => paths.get(o) ?? `<no path for ${o.name}>`)
          .filter((r) => !fastify.hasRoute({ method: r.method, url: r.url }))
          .map((r) => `${r.method} ${r.url} (${r.why})`);
        expect(missing).toEqual([]);

        // And the M:N onto the subtype returns only that subtype's rows: its junction
        // column can hold a Broker's id, which is not a Carrier.
        await app.migrate(pgServer.connectionUri);
        await executeSql(pgServer.connectionUri, `
          INSERT INTO shipments (id) VALUES (1);
          INSERT INTO parties (id, party_type) VALUES (11, 'Carrier'), (12, 'Carrier'), (13, 'Broker');
          INSERT INTO legs (shipment_id, carrier_id) VALUES (1, 11), (1, 12), (1, 13);
        `);
        const res = await fastify.inject({ method: "GET", url: `${paths.get(root.findObject("Shipment")!)}/1/carriers` });
        expect(res.statusCode).toBe(200);
        expect((JSON.parse(res.body) as Array<{ id: number }>).map((r) => Number(r.id)).sort()).toEqual([11, 12]);
      } finally {
        await fastify.close();
      }
    } finally {
      await app.close();
      await executeSql(pgServer.connectionUri, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
  }, 120_000);

  test("the committed cross-port schema carries every FK and column the shared model declares", async () => {
    const root = await loadMetadataFile(resolve(CANONICAL_DIR, "meta.fitness.json"));
    await executeSql(pgServer.connectionUri, readFileSync(CANONICAL_SCHEMA_SQL_PATH, "utf8"));
    try {
      const actual = await actualForeignKeys(pgServer.connectionUri);
      expect(actual.map(fkKey)).toEqual(expectedForeignKeys(root, CANONICAL_COLUMN_NAMING).map(fkKey));
      expect(missingColumns(expectedColumns(root, CANONICAL_COLUMN_NAMING), await actualColumns(pgServer.connectionUri))).toEqual([]);
    } finally {
      await executeSql(pgServer.connectionUri, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    }
  }, 120_000);
});
