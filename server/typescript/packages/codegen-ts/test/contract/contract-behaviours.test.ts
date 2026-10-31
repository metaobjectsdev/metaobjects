// FR-022 — what the goldens hold but cannot explain: each behaviour the contract emitters promise,
// stated with a payload a validator takes or refuses, and with the generator options the corpus does
// not vary. The corpus proves the bytes hold. This file proves the bytes mean what the docs say.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { type ContractCase, contractCases, contractTree, loadCaseModel } from "../../scripts/gen-contract-conformance.js";
import { readTree } from "../../scripts/gen-cube-model-canonical.js";
import { DECIMAL_CANONICAL_PATTERN } from "../../src/contract/field-schema.js";
import { jsonSchemaFile, openApiFile } from "../../src/generators/index.js";
import { defineConfig, type Generator, runGen } from "../../src/index.js";
import { jsonSchemaFile as refJsonSchemaFile } from "../../src/reference/contract-schema.js";
import { openApiFile as refOpenApiFile } from "../../src/reference/openapi.js";
import { ajvOver, type JsonDoc } from "./contract-validators.js";

const CASES = new Map(contractCases().map((c) => [c.name, c]));

function corpusCase(name: string): ContractCase {
  const c = CASES.get(name);
  if (c === undefined) throw new Error(`no contract case '${name}'`);
  return c;
}

interface RunOptions {
  entityFilter?: string[];
}

async function emit(c: ContractCase, generators: Generator[], run: RunOptions = {}): Promise<Map<string, string>> {
  const root = await loadCaseModel(c);
  const dir = mkdtempSync(join(tmpdir(), "contract-behaviour-"));
  try {
    const outDir = join(dir, "out");
    await runGen({
      config: defineConfig({ outDir, dialect: "postgres", apiPrefix: "/api", generators }),
      metadata: root,
      genStateDir: join(dir, ".gen-state"),
      ...(run.entityFilter !== undefined && { entityFilter: run.entityFilter }),
    });
    return readTree(outDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function jsonAt(tree: ReadonlyMap<string, string>, path: string): JsonDoc {
  const content = tree.get(path);
  if (content === undefined) throw new Error(`${path} was not written; wrote ${[...tree.keys()].join(", ")}`);
  return JSON.parse(content) as JsonDoc;
}

/** A validator for one schema file of a tree, every other schema in the tree loaded for its `$ref`s. */
function validatorOf(tree: ReadonlyMap<string, string>, path: string): (value: unknown) => boolean {
  const schemas = [...tree].filter(([p]) => p.endsWith(".schema.json") && !p.endsWith(".strict.schema.json"));
  const ajv = ajvOver(schemas.map(([, content]) => JSON.parse(content) as JsonDoc));
  const validate = ajv.getSchema(jsonAt(tree, path)["$id"] as string);
  if (validate === undefined) throw new Error(`${path} did not compile`);
  return (value) => validate(value) as boolean;
}

const ALL_FIELDS = "schemas/acme/contract/AllFields";
const ADDRESS = "schemas/acme/contract/Address";

function sampleRow(): Record<string, unknown> {
  return {
    id: "6f1c2b1e-0d7a-4d55-9c1e-0a4e8f1d2c3b",
    title: "A title", email: null, host: null, quantity: 3, views: null, ratio: null, score: null, amount: null,
    active: null, startsOn: null, startsAt: null, publishedAt: null, wallClock: null, priceCents: null, status: "draft",
    stage: null, homepage: null, looseLink: null, address: null, shipTo: null, stops: null, tags: null,
    internalNote: null, issuedBy: null, syncedBy: null, createdAt: null, updatedAt: null,
  };
}

describe("a read answers what the wire setting says", () => {
  test("wire.decimals: string fixes the canonical string, and refuses a number", async () => {
    const tree = await contractTree(corpusCase("all-fields-wire-string-omit"));
    const valid = validatorOf(tree, `${ALL_FIELDS}.schema.json`);
    expect(valid({ ...sampleRow(), amount: "19.99" })).toBe(true);
    expect(valid({ ...sampleRow(), amount: 19.99 })).toBe(false);
    expect(valid({ ...sampleRow(), amount: "1e3" })).toBe(false);
  });

  test("the default takes either form, because each server language writes its own", async () => {
    const tree = await contractTree(corpusCase("all-fields"));
    const valid = validatorOf(tree, `${ALL_FIELDS}.schema.json`);
    expect(valid({ ...sampleRow(), amount: "19.99" })).toBe(true);
    expect(valid({ ...sampleRow(), amount: 19.99 })).toBe(true);
    expect(valid({ ...sampleRow(), amount: true })).toBe(false);
  });

  test("a decimal is accepted for a write as a string or a number, in every setting", async () => {
    for (const name of ["all-fields", "all-fields-wire-string-omit", "all-fields-wire-string-emit"]) {
      const tree = await contractTree(corpusCase(name));
      const amount = (jsonAt(tree, `${ALL_FIELDS}.create.schema.json`)["properties"] as Record<string, JsonDoc>)["amount"]!;
      expect(amount["type"], name).toEqual(["string", "number"]);
    }
  });

  test("the canonical decimal pattern is the normalized form", () => {
    const canonical = new RegExp(DECIMAL_CANONICAL_PATTERN);
    for (const ok of ["0", "-1", "19.99", "0.5", "1000"]) expect(canonical.test(ok), ok).toBe(true);
    for (const bad of ["1e3", "+1", "1.", ".5", "01", "1.50"]) expect(canonical.test(bad), bad).toBe(false);
  });

  test("nullMembers: omit leaves a null member out of a value object", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields-wire-string-omit")), `${ADDRESS}.schema.json`);
    expect(valid({ street: "1 Main" })).toBe(true);
    expect(valid({ street: "1 Main", unit: null })).toBe(false);
  });

  test("nullMembers: emit writes every member, null included", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields-wire-string-emit")), `${ADDRESS}.schema.json`);
    expect(valid({ street: "1 Main", unit: null, latitude: null })).toBe(true);
    expect(valid({ street: "1 Main" })).toBe(false);
  });

  test("the default takes either, because the language's serializer decides", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ADDRESS}.schema.json`);
    expect(valid({ street: "1 Main" })).toBe(true);
    expect(valid({ street: "1 Main", unit: null })).toBe(true);
  });

  test("a top-level optional field is written null, whatever the setting", async () => {
    for (const name of ["all-fields", "all-fields-wire-string-omit", "all-fields-wire-string-emit"]) {
      const tree = await contractTree(corpusCase(name));
      const valid = validatorOf(tree, `${ALL_FIELDS}.schema.json`);
      const { email: _dropped, ...withoutEmail } = sampleRow();
      expect(valid(sampleRow()), name).toBe(true);
      expect(valid(withoutEmail), name).toBe(false);
    }
  });
});

describe("types the JSON Schema formats do not state", () => {
  test("a time has no offset, so it is a pattern", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ALL_FIELDS}.schema.json`);
    expect(valid({ ...sampleRow(), startsAt: "09:30:00" })).toBe(true);
    expect(valid({ ...sampleRow(), startsAt: "09:30:00.250" })).toBe(true);
    expect(valid({ ...sampleRow(), startsAt: "9am" })).toBe(false);
  });

  test("a local timestamp has no offset, and a zoned one must", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ALL_FIELDS}.schema.json`);
    expect(valid({ ...sampleRow(), wallClock: "2026-10-30T09:30:00" })).toBe(true);
    expect(valid({ ...sampleRow(), wallClock: "2026-10-30T09:30:00Z" })).toBe(false);
    expect(valid({ ...sampleRow(), publishedAt: "2026-10-30T09:30:00Z" })).toBe(true);
    expect(valid({ ...sampleRow(), publishedAt: "2026-10-30T09:30:00" })).toBe(false);
  });
});

describe("a write takes what a route takes", () => {
  test("a timestamp with no offset is read as UTC, on a write and nowhere else", async () => {
    const tree = await contractTree(corpusCase("all-fields"));
    const create = validatorOf(tree, `${ALL_FIELDS}.create.schema.json`);
    const required = { title: "A title", quantity: 1, status: "draft" };
    expect(create({ ...required, publishedAt: "2026-10-30T09:30:00" })).toBe(true);
    expect(create({ ...required, publishedAt: "2026-10-30T09:30:00Z" })).toBe(true);
    expect(create({ ...required, publishedAt: "2026-10-30T09:30:00+02:00" })).toBe(true);
    expect(create({ ...required, publishedAt: "next tuesday" })).toBe(false);
    expect(validatorOf(tree, `${ALL_FIELDS}.schema.json`)({ ...sampleRow(), publishedAt: "2026-10-30T09:30:00" })).toBe(false);
  });

  test("a report's list route takes format only when the project wires report-export", async () => {
    const formatOn = (tree: ReadonlyMap<string, string>): boolean => {
      const list = (jsonAt(tree, "openapi.json")["paths"] as Record<string, { get: { parameters: { name: string }[] } }>)["/api/invoice_totals"]!;
      return list.get.parameters.some((p) => p.name === "format");
    };
    expect(formatOn(await contractTree(corpusCase("report")))).toBe(true);
    expect(formatOn(await emit(corpusCase("report"), [openApiFile({ title: "t", version: "1" })]))).toBe(false);
  });
});

describe("the three shapes", () => {
  test("an update takes null for an optional field, and not for a required one", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ALL_FIELDS}.update.schema.json`);
    expect(valid({})).toBe(true);
    expect(valid({ email: null })).toBe(true);
    expect(valid({ title: null })).toBe(false);
  });

  test("a create leaves an optional field out, and does not take null for it", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ALL_FIELDS}.create.schema.json`);
    const title = "A title";
    const status = "draft";
    expect(valid({ title, quantity: 1, status })).toBe(true);
    expect(valid({ title, quantity: 1, status, email: null })).toBe(false);
    expect(valid({ quantity: 1, status })).toBe(false);
  });

  test("validators hold on a write: length, pattern and range", async () => {
    const valid = validatorOf(await contractTree(corpusCase("all-fields")), `${ALL_FIELDS}.create.schema.json`);
    const status = "draft";
    expect(valid({ title: "Abcd", quantity: 1, status })).toBe(true);
    expect(valid({ title: "Ab", quantity: 1, status })).toBe(false);
    expect(valid({ title: "lowercase", quantity: 1, status })).toBe(false);
    expect(valid({ title: "A title", quantity: 1001, status })).toBe(false);
  });

  test("a credential is on no shape, and @formExclude is only on the read", async () => {
    const tree = await contractTree(corpusCase("secret-fields"));
    const keysOf = (path: string): string[] => Object.keys(jsonAt(tree, path)["properties"] as JsonDoc);
    const account = "schemas/acme/secrets/Account";
    expect(keysOf(`${account}.schema.json`)).toEqual(["id", "name", "tokenHash"]);
    expect(keysOf(`${account}.create.schema.json`)).toEqual(["name"]);
    expect(keysOf(`${account}.update.schema.json`)).toEqual(["name"]);
    expect(tree.get("openapi.json")).not.toContain("pinHash");
  });

  test("a projection and a report read, and nothing writes them", async () => {
    const tree = await contractTree(corpusCase("projection"));
    const paths = [...tree.keys()];
    expect(paths.some((p) => p.endsWith(".create.schema.json") && p.includes("Summary"))).toBe(false);
    const doc = jsonAt(tree, "openapi.json");
    for (const [path, item] of Object.entries(doc["paths"] as Record<string, JsonDoc>)) {
      if (!path.includes("summar")) continue;
      expect(Object.keys(item).filter((verb) => verb !== "parameters"), path).toEqual(["get"]);
    }
  });
});

describe("what a project's run changes", () => {
  test("openapi writes the same bytes for a run narrowed to one entity", async () => {
    const c = corpusCase("m2m");
    const whole = await emit(c, [openApiFile({ title: "t", version: "1" })]);
    const root = await loadCaseModel(c);
    const first = root.objects()[0]!.name;
    const narrowed = await emit(c, [openApiFile({ title: "t", version: "1" })], { entityFilter: [first] });
    expect(narrowed.get("openapi.json")).toBe(whole.get("openapi.json")!);
  });

  test("a generator filter narrows the document, and keeps what a kept object references", async () => {
    const c = corpusCase("all-fields");
    const onlyAllFields = (o: MetaObject): boolean => o.name === "AllFields";
    const tree = await emit(c, [openApiFile({ title: "t", version: "1", filter: onlyAllFields })]);
    const doc = jsonAt(tree, "openapi.json");
    expect(Object.keys(doc["paths"] as JsonDoc)).toEqual(["/api/all_fields", "/api/all_fields/{id}"]);
    expect(Object.keys((doc["components"] as { schemas: JsonDoc }).schemas)).toContain("Address");
    expect(Object.keys((doc["components"] as { schemas: JsonDoc }).schemas)).not.toContain("Bag");
  });

  test("a schema filter keeps a file for what a kept object references, so no $ref dangles", async () => {
    const c = corpusCase("all-fields");
    const tree = await emit(c, [jsonSchemaFile({ filter: (o) => o.name === "AllFields" })]);
    expect(tree.has("schemas/acme/contract/Address.schema.json")).toBe(true);
    expect(tree.has("schemas/acme/contract/Bag.schema.json")).toBe(false);
    validatorOf(tree, `${ALL_FIELDS}.schema.json`);
  });

  test("expose narrows the document to the verbs the project mounts", async () => {
    const tree = await emit(corpusCase("blog"), [openApiFile({ title: "t", version: "1", expose: ["list", "get"] })]);
    const paths = jsonAt(tree, "openapi.json")["paths"] as Record<string, JsonDoc>;
    const verbsOf = (path: string): string[] => Object.keys(paths[path]!).filter((key) => key !== "parameters");
    expect(verbsOf("/api/authors")).toEqual(["get"]);
    expect(verbsOf("/api/authors/{id}")).toEqual(["get"]);
  });

  test("baseUri prefixes every $id, and the relative $refs still resolve", async () => {
    const baseUri = "https://schemas.example.com/v1/";
    const tree = await emit(corpusCase("all-fields"), [jsonSchemaFile({ baseUri })]);
    const id = jsonAt(tree, `${ALL_FIELDS}.schema.json`)["$id"] as string;
    expect(id).toBe(`${baseUri}${ALL_FIELDS}.schema.json`);
    validatorOf(tree, `${ALL_FIELDS}.schema.json`);
  });

  test("title, version, servers and security are options, and pass through untouched", async () => {
    const tree = await emit(corpusCase("blog"), [openApiFile({
      title: "Blog API",
      version: "2.1.0",
      description: "The blog.",
      servers: [{ url: "https://api.example.com" }],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
    })]);
    const doc = jsonAt(tree, "openapi.json");
    expect(doc["info"]).toEqual({ title: "Blog API", version: "2.1.0", description: "The blog." });
    expect(doc["servers"]).toEqual([{ url: "https://api.example.com" }]);
    expect(doc["security"]).toEqual([{ bearer: [] }]);
    expect((doc["components"] as JsonDoc)["securitySchemes"]).toEqual({ bearer: { type: "http", scheme: "bearer" } });
  });

  test("the path option moves the document, and the strict profile writes only .strict files", async () => {
    const tree = await emit(corpusCase("blog"), [
      openApiFile({ title: "t", version: "1", path: "api/openapi.json" }),
      jsonSchemaFile({ profile: "strict" }),
    ]);
    expect(tree.has("api/openapi.json")).toBe(true);
    const schemas = [...tree.keys()].filter((p) => p.endsWith(".json") && p !== "api/openapi.json");
    expect(schemas.length).toBeGreaterThan(0);
    for (const p of schemas) expect(p.endsWith(".strict.schema.json"), p).toBe(true);
  });
});

describe("the reference copies", () => {
  for (const c of contractCases()) {
    if (c.name.startsWith("error-")) continue;
    test(`${c.name}: the copy a project ejects writes the same tree`, async () => {
      const packaged = await contractTree(c);
      const owned = await contractTree(c, { jsonSchemaFile: refJsonSchemaFile, openApiFile: refOpenApiFile });
      expect(owned).toEqual(packaged);
    });
  }
});
