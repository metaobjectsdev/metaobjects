// FR-022 — the contract corpus (fixtures/contract-conformance/). Each case holds either `expected/`,
// the exact tree the emitters write, or `expected-error.txt`, the refusal. Every document a case
// writes goes through a real validator as well: Ajv strict for JSON Schema 2020-12, the OpenAPI 3.1
// specification's schema for the document, and the strict subset's own rules. The goldens prove the
// bytes hold; the validators prove stock tools take them.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContractEmitError } from "../../src/contract/contract-errors.js";
import { CONTRACT_SCRIPT, contractCases, contractTree } from "../../scripts/gen-contract-conformance.js";
import { readTree } from "../../scripts/gen-cube-model-canonical.js";
import { ajvOver, danglingRefs, type JsonDoc, openApiErrors, strictViolations } from "./contract-validators.js";

const STRICT_SUFFIX = ".strict.schema.json";
const OPENAPI_FILE = "openapi.json";

function contractErrorOf(e: unknown): ContractEmitError | undefined {
  for (let at: unknown = e; at instanceof Error; at = at.cause) {
    if (at instanceof ContractEmitError) return at;
  }
  return undefined;
}

function documents(tree: ReadonlyMap<string, string>, keep: (path: string) => boolean): Map<string, JsonDoc> {
  const out = new Map<string, JsonDoc>();
  for (const [path, content] of tree) if (keep(path)) out.set(path, JSON.parse(content) as JsonDoc);
  return out;
}

const cases = contractCases();

describe("the contract corpus", () => {
  test("has cases of both kinds", () => {
    expect(cases.some((c) => existsSync(join(c.dir, "expected")))).toBe(true);
    expect(cases.some((c) => existsSync(join(c.dir, "expected-error.txt")))).toBe(true);
  });

  test("the README lists every case, and no case it does not hold", () => {
    const readme = readFileSync(join(cases[0]!.dir, "..", "README.md"), "utf8");
    const listed = [...readme.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!);
    expect(listed.slice().sort()).toEqual(cases.map((c) => c.name));
  });

  for (const c of cases) {
    const errorFile = join(c.dir, "expected-error.txt");
    if (existsSync(errorFile)) {
      test(`${c.name}: refuses`, async () => {
        let thrown: unknown;
        try {
          await contractTree(c);
        } catch (e) {
          thrown = e;
        }
        expect(contractErrorOf(thrown)?.message).toBe(readFileSync(errorFile, "utf8").trimEnd());
      });
      continue;
    }

    describe(c.name, () => {
      const written = contractTree(c);

      test(`writes the golden tree (regenerate with ${CONTRACT_SCRIPT})`, async () => {
        const expected = readTree(join(c.dir, "expected"));
        const tree = await written;
        expect([...tree.keys()].sort()).toEqual([...expected.keys()].sort());
        for (const [path, content] of tree) expect(content, path).toBe(expected.get(path)!);
      });

      test("every canonical schema compiles in strict Ajv, every $ref resolved", async () => {
        const canonical = documents(await written, (p) => p.endsWith(".schema.json") && !p.endsWith(STRICT_SUFFIX));
        expect(canonical.size).toBeGreaterThan(0);
        const ajv = ajvOver([...canonical.values()]);
        for (const [path, schema] of canonical) expect(ajv.getSchema(schema["$id"] as string), path).toBeDefined();
      });

      test("every strict schema compiles, and holds to the subset", async () => {
        const strict = documents(await written, (p) => p.endsWith(STRICT_SUFFIX));
        const ajv = ajvOver([]);
        for (const [path, schema] of strict) {
          expect(ajv.compile(schema), path).toBeDefined();
          expect(strictViolations(schema), path).toEqual([]);
        }
      });

      test("the document is valid OpenAPI 3.1", async () => {
        const doc = documents(await written, (p) => p === OPENAPI_FILE).get(OPENAPI_FILE)!;
        expect(await openApiErrors(doc)).toEqual([]);
      });

      test("the document is a valid schema set: every component compiles in Ajv", async () => {
        const doc = documents(await written, (p) => p === OPENAPI_FILE).get(OPENAPI_FILE)!;
        const ajv = ajvOver([]);
        ajv.opts.strictSchema = false; // OpenAPI's `discriminator` is its own keyword
        ajv.addSchema(doc as never, "openapi");
        const schemas = (doc["components"] as { schemas: JsonDoc }).schemas;
        for (const name of Object.keys(schemas)) {
          expect(ajv.compile({ $ref: `openapi#/components/schemas/${name}` }), name).toBeDefined();
        }
      });

      test("every $ref in the document has a component behind it", async () => {
        const doc = documents(await written, (p) => p === OPENAPI_FILE).get(OPENAPI_FILE)!;
        expect(danglingRefs(doc)).toEqual([]);
      });

      test("every operation has a unique operationId", async () => {
        const doc = documents(await written, (p) => p === OPENAPI_FILE).get(OPENAPI_FILE)!;
        const ids = Object.values(doc["paths"] as Record<string, Record<string, { operationId?: string }>>)
          .flatMap((item) => Object.values(item).map((op) => op.operationId))
          .filter((id) => id !== undefined);
        expect(new Set(ids).size).toBe(ids.length);
      });
    });
  }
});
