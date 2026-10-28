// #479 — the prisma-schema generator: the model's tables as a Prisma schema, with the CHECK
// constraints a Prisma schema cannot declare in a companion SQL file. The golden files are the
// generator's output for the shop fixture under each provider; `prisma validate` and the
// `prisma db push` + `meta verify --db` round trip run them in the cli package's integration
// tests. Refresh the goldens with UPDATE_GOLDEN=1.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { defineConfig, runGen, type Generator } from "../../src/index.js";
import { prismaSchemaFile, type PrismaSchemaFileOptions } from "../../src/generators/prisma-schema-file.js";
import { buildPrismaSchema } from "../../src/prisma/build-prisma-schema.js";
import {
  ERR_PRISMA_NAME_COLLISION,
  ERR_PRISMA_READ_ONLY_SOURCE,
  ERR_PRISMA_UNMAPPABLE_RELATION,
  ERR_PRISMA_UNSUPPORTED_CHECK,
  ERR_PRISMA_UNSUPPORTED_INDEX,
  ERR_PRISMA_UNSUPPORTED_PROVIDER,
  ERR_PRISMA_NO_PRIMARY_KEY,
  PrismaSchemaError,
} from "../../src/prisma/prisma-errors.js";

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const SHOP = join(import.meta.dir, "fixtures", "shop", "metaobjects", "meta.shop.json");
const GOLDEN_DIR = join(import.meta.dir, "golden");

type Json = Record<string, unknown>;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "prisma-schema-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function loadJson(text: string): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(text)]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

const loadShop = (): Promise<MetaRoot> => loadJson(readFileSync(SHOP, "utf8"));

function model(children: Json[]): string {
  return JSON.stringify({ "metadata.root": { package: "acme::shop", children } });
}

function entity(name: string, children: Json[], extra: Json = {}): Json {
  return { "object.entity": { name, ...extra, children } };
}

const longId: Json = { "field.long": { name: "id" } };
const pk: Json = { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } };

/** Runs the generators into `tmp`; returns the files written, by path, without the gen state. */
async function gen(root: MetaRoot, generators: Generator[], dialect: "postgres" | "mysql" | "sqlite" = "postgres", entities?: string[]) {
  await runGen({
    config: defineConfig({ outDir: tmp, dialect, generators }),
    metadata: root,
    projectRoot: tmp,
    ...(entities !== undefined ? { entities } : {}),
  });
  const out = new Map<string, string>();
  for (const name of ["schema.prisma", "schema.checks.sql", "models.prisma", "models.checks.sql"]) {
    const p = join(tmp, name);
    if (existsSync(p)) out.set(name, readFileSync(p, "utf8"));
  }
  return out;
}

function expectGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

function refusal(fn: () => unknown): PrismaSchemaError {
  try {
    fn();
  } catch (e) {
    if (e instanceof PrismaSchemaError) return e;
    throw e;
  }
  throw new Error("expected a PrismaSchemaError");
}

describe("prisma-schema — golden output for the shop fixture", () => {
  const CASES: ReadonlyArray<{ dialect: "postgres" | "mysql" | "sqlite"; opts: PrismaSchemaFileOptions; golden: string; checks: boolean }> = [
    { dialect: "postgres", opts: {}, golden: "shop.postgresql", checks: true },
    { dialect: "mysql", opts: {}, golden: "shop.mysql", checks: true },
    { dialect: "sqlite", opts: { checks: "omit" }, golden: "shop.sqlite", checks: false },
  ];
  for (const c of CASES) {
    test(`${c.golden}: the provider comes from the config's dialect`, async () => {
      const files = await gen(await loadShop(), [prismaSchemaFile(c.opts)], c.dialect);
      expectGolden(`${c.golden}.prisma`, files.get("schema.prisma") ?? "");
      if (c.checks) expectGolden(`${c.golden}.checks.sql`, files.get("schema.checks.sql") ?? "");
      else expect(files.has("schema.checks.sql")).toBe(false);
    });
  }
});

describe("prisma-schema — what the schema says", () => {
  test("names: entity and field names, with @@map and @map onto the physical names", async () => {
    const spec = buildPrismaSchema(await loadShop(), { provider: "postgresql" });
    const customer = spec.models.find((m) => m.name === "Customer")!;
    expect(customer.blockAttributes).toContain('@@map("customers")');
    const displayName = customer.fields.find((f) => f.name === "displayName")!;
    expect(displayName.attributes).toContain('@map("display_name")');
    expect(displayName.optional).toBe(true);
  });

  test("an enum is a String with its membership in the checks file, never a Prisma enum", async () => {
    const spec = buildPrismaSchema(await loadShop(), { provider: "postgresql" });
    const tier = spec.models.find((m) => m.name === "Customer")!.fields.find((f) => f.name === "tier")!;
    expect(tier.type).toBe("String");
    expect(spec.checks.map((c) => c.name)).toContain("customers_tier_chk");
  });

  test("a self relation is named, so its two ends pair", async () => {
    const spec = buildPrismaSchema(await loadShop(), { provider: "postgresql" });
    const employee = spec.models.find((m) => m.name === "Employee")!;
    const manager = employee.fields.find((f) => f.name === "manager")!;
    expect(manager.attributes[0]).toStartWith('@relation("employees_manager_id_fk", ');
    const back = employee.fields.find((f) => f.name === "employeesByManager")!;
    expect(back).toMatchObject({ type: "Employee", list: true, attributes: ['@relation("employees_manager_id_fk")'] });
  });

  test("a one-to-one reference gets an optional singular back relation", async () => {
    const root = await loadJson(model([
      entity("User", [{ "source.rdb": {} }, longId, pk]),
      entity("Profile", [
        { "source.rdb": {} },
        longId,
        { "field.long": { name: "userId", "@required": true } },
        pk,
        { "identity.secondary": { name: "byUser", "@fields": ["userId"] } },
        { "identity.reference": { name: "user", "@fields": ["userId"], "@references": "User" } },
      ]),
    ]));
    const user = buildPrismaSchema(root, { provider: "postgresql" }).models.find((m) => m.name === "User")!;
    expect(user.fields.find((f) => f.name === "profile")).toMatchObject({ type: "Profile", list: false, optional: true });
  });

  test("sqlite: an expression default is in parentheses, which SQLite requires and does not store", async () => {
    const spec = buildPrismaSchema(await loadShop(), { provider: "sqlite", checks: "omit" });
    const createdAt = spec.models.find((m) => m.name === "Customer")!.fields.find((f) => f.name === "createdAt")!;
    expect(createdAt.attributes).toContain(`@default(dbgenerated("(strftime('%Y-%m-%dT%H:%M:%fZ','now'))"))`);
    const pgCreatedAt = buildPrismaSchema(await loadShop(), { provider: "postgresql" })
      .models.find((m) => m.name === "Customer")!.fields.find((f) => f.name === "createdAt")!;
    expect(pgCreatedAt.attributes).toContain('@default(dbgenerated("now()"))');
  });

  test("an @unmanaged object is not a model", async () => {
    const root = await loadJson(model([
      entity("Legacy", [{ "source.rdb": { "@unmanaged": true } }, longId, pk]),
      entity("Fresh", [{ "source.rdb": {} }, longId, pk]),
    ]));
    expect(buildPrismaSchema(root, { provider: "postgresql" }).models.map((m) => m.name)).toEqual(["Fresh"]);
  });

  test("a non-default Postgres schema turns on multi-schema", async () => {
    const root = await loadJson(model([
      entity("Audit", [{ "source.rdb": { "@schema": "audit" } }, longId, pk]),
      entity("Fresh", [{ "source.rdb": {} }, longId, pk]),
    ]));
    const spec = buildPrismaSchema(root, { provider: "postgresql" });
    expect(spec.schemas).toEqual(["audit", "public"]);
    expect(spec.models.find((m) => m.name === "Audit")!.blockAttributes).toContain('@@schema("audit")');
  });
});

describe("prisma-schema — refusals", () => {
  test("a view-backed object that is not @unmanaged", async () => {
    const root = await loadJson(model([
      entity("Program", [{ "source.rdb": {} }, longId, { "field.string": { name: "title" } }, pk]),
      { "object.projection": { name: "ProgramTitle", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_program_title" } },
        { "field.long": { name: "id", extends: "Program.id" } },
        { "field.string": { name: "title", extends: "Program.title" } },
        { "identity.primary": { name: "pk", extends: "Program.pk" } },
      ] } },
    ]));
    const e = refusal(() => buildPrismaSchema(root, { provider: "postgresql" }));
    expect(e.code).toBe(ERR_PRISMA_READ_ONLY_SOURCE);
    expect(e.message).toContain("ProgramTitle");
    expect(e.message).toContain("@unmanaged");
  });

  test("an expression index", async () => {
    const root = await loadJson(model([
      entity("Customer", [
        { "source.rdb": {} },
        longId,
        { "field.string": { name: "email" } },
        pk,
        { "index.lookup": { name: "byLowerEmail", "@expr": "lower(email)" } },
      ]),
    ]));
    expect(refusal(() => buildPrismaSchema(root, { provider: "postgresql" })).code).toBe(ERR_PRISMA_UNSUPPORTED_INDEX);
  });

  test("a partial index", async () => {
    const root = await loadJson(model([
      entity("Customer", [
        { "source.rdb": {} },
        longId,
        { "field.string": { name: "email" } },
        pk,
        { "index.lookup": { name: "byEmail", "@fields": ["email"], "@where": "email IS NOT NULL" } },
      ]),
    ]));
    expect(refusal(() => buildPrismaSchema(root, { provider: "postgresql" })).code).toBe(ERR_PRISMA_UNSUPPORTED_INDEX);
  });

  test("a CHECK on sqlite, unless omitted", async () => {
    const root = await loadShop();
    expect(refusal(() => buildPrismaSchema(root, { provider: "sqlite" })).code).toBe(ERR_PRISMA_UNSUPPORTED_CHECK);
    expect(buildPrismaSchema(root, { provider: "sqlite", checks: "omit" }).checks).toEqual([]);
  });

  test("an array column is a Postgres list and JSON on MySQL", async () => {
    const root = await loadShop();
    const notes = (provider: "postgresql" | "mysql") =>
      buildPrismaSchema(root, { provider }).models.find((m) => m.name === "Order")!.fields.find((f) => f.name === "notes")!;
    expect(notes("postgresql")).toMatchObject({ type: "String", list: true, optional: false });
    expect(notes("mysql")).toMatchObject({ type: "Json", list: false });
  });

  test("a table with no primary key", async () => {
    const root = await loadJson(model([entity("Log", [{ "source.rdb": {} }, { "field.string": { name: "line" } }])]));
    expect(refusal(() => buildPrismaSchema(root, { provider: "postgresql" })).code).toBe(ERR_PRISMA_NO_PRIMARY_KEY);
  });

  test("a reference to a table outside the generator's filter", async () => {
    const root = await loadShop();
    const e = refusal(() => buildPrismaSchema(root, { provider: "postgresql", matches: (o) => o.name !== "Customer" }));
    expect(e.code).toBe(ERR_PRISMA_UNMAPPABLE_RELATION);
    expect(e.message).toContain("orders_customer_id_fk");
  });

  test("two objects that would be one model", async () => {
    const a = JSON.stringify({ "metadata.root": { package: "acme::a", children: [entity("Item", [{ "source.rdb": { "@table": "a_items" } }, longId, pk])] } });
    const b = JSON.stringify({ "metadata.root": { package: "acme::b", children: [entity("Item", [{ "source.rdb": { "@table": "b_items" } }, longId, pk])] } });
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(a), new InMemoryStringSource(b)]);
    expect(errors).toEqual([]);
    expect(refusal(() => buildPrismaSchema(root, { provider: "postgresql" })).code).toBe(ERR_PRISMA_NAME_COLLISION);
  });

  test("a dialect with no Prisma provider", async () => {
    const root = await loadShop();
    await expect(
      runGen({
        config: defineConfig({ outDir: tmp, dialect: "postgres", generators: [prismaSchemaFile({ provider: "sqlserver" as "postgresql" })] }),
        metadata: root,
        projectRoot: tmp,
      }),
    ).rejects.toThrow(ERR_PRISMA_UNSUPPORTED_PROVIDER);
  });
});

describe("prisma-schema — the generator", () => {
  test("the schema does not depend on the run's selection", async () => {
    const root = await loadShop();
    const all = await gen(root, [prismaSchemaFile()]);
    rmSync(join(tmp, "schema.prisma"));
    const one = await gen(root, [prismaSchemaFile()], "postgres", ["Tag"]);
    expect(one.get("schema.prisma")).toBe(all.get("schema.prisma")!);
  });

  test("a run that selects no table-backed object writes nothing", async () => {
    const root = await loadJson(model([
      { "object.value": { name: "Address", children: [{ "field.string": { name: "line1" } }] } },
    ]));
    expect((await gen(root, [prismaSchemaFile()])).size).toBe(0);
  });

  test("header false writes models only; a string header is written verbatim", async () => {
    const root = await loadShop();
    const bare = await gen(root, [prismaSchemaFile({ header: false, fileName: "models.prisma" })]);
    expect(bare.get("models.prisma")).not.toContain("datasource");
    expect(bare.get("models.prisma")).not.toContain("generator");
    expect(bare.has("models.checks.sql")).toBe(true);
    const own = 'generator client {\n  provider = "prisma-client-js"\n}';
    const mine = await gen(root, [prismaSchemaFile({ header: own })]);
    expect(mine.get("schema.prisma")).toContain(own);
    expect(mine.get("schema.prisma")).not.toContain("datasource");
  });

  test("a hand edit is discarded, not merged", async () => {
    const root = await loadShop();
    const first = await gen(root, [prismaSchemaFile()]);
    writeFileSync(join(tmp, "schema.prisma"), `${first.get("schema.prisma")}\nmodel Extra {\n  id Int @id\n}\n`);
    const second = await gen(root, [prismaSchemaFile()]);
    expect(second.get("schema.prisma")).toBe(first.get("schema.prisma")!);
  });

  test("the checks file goes when the last CHECK does", async () => {
    const withCheck = await loadJson(model([
      entity("Customer", [{ "source.rdb": {} }, longId, { "field.enum": { name: "tier", "@values": ["A", "B"] } }, pk]),
    ]));
    expect((await gen(withCheck, [prismaSchemaFile()])).has("schema.checks.sql")).toBe(true);
    const without = await loadJson(model([entity("Customer", [{ "source.rdb": {} }, longId, pk])]));
    expect((await gen(without, [prismaSchemaFile()])).has("schema.checks.sql")).toBe(false);
  });
});
