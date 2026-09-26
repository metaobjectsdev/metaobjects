/**
 * The two EXAMPLE generators in docs/recipes/generators/typescript/ (JSON Schema, OpenAPI
 * 3.1) must keep working, because the guidance tells adopters to copy them. This gate does
 * exactly that: copies both files verbatim into a fresh project's codegen/generators/, wires
 * them the way the recipe says, typechecks them strictly, runs `meta gen`, checks what they
 * emitted, and runs `meta verify --codegen`.
 *
 * The files are examples, not a product surface — this test exists so they cannot rot
 * against the engine API they import, not to promise their output to anyone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_ROOT, meta, requireFreshDist } from "./support/built-cli.js";
import { newShopProject, typecheckGenerators } from "./support/generator-project.js";

const RECIPES = resolve(CLI_ROOT, "..", "..", "..", "..", "docs", "recipes", "generators", "typescript");
const FILES = ["json-schema.ts", "openapi.ts"];

type Json = { [key: string]: unknown };

beforeAll(requireFreshDist);

let root = "";
afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** Every `$ref` in an OpenAPI document is a local pointer that resolves inside it. */
function unresolvedRefs(doc: Json): string[] {
  const bad: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        let cur: unknown = doc;
        for (const seg of v.replace(/^#\//, "").split("/")) cur = (cur as Json | undefined)?.[seg];
        if (!v.startsWith("#/") || cur === undefined) bad.push(v);
      } else walk(v);
    }
  };
  walk(doc);
  return bad;
}

describe("docs/recipes example generators", () => {
  test("copied verbatim, they typecheck, generate, and verify clean", async () => {
    root = await newShopProject("recipe-gens-");
    for (const f of FILES) copyFileSync(join(RECIPES, f), join(root, "codegen", "generators", f));

    // The wiring the recipe documents.
    const configPath = join(root, "metaobjects.config.ts");
    const config = readFileSync(configPath, "utf8")
      .replace(
        'import { defineConfig } from "@metaobjectsdev/cli";',
        'import { defineConfig } from "@metaobjectsdev/cli";\n' +
          'import { jsonSchemaFile } from "./codegen/generators/json-schema.js";\n' +
          'import { openApiFile } from "./codegen/generators/openapi.js";',
      )
      .replace("generators: [],", 'apiPrefix: "/api",\n  generators: [jsonSchemaFile(), openApiFile({ title: "Shop" })],');
    expect(config).toContain("openApiFile(");
    writeFileSync(configPath, config);

    const tsc = await typecheckGenerators(root, FILES.map((f) => `codegen/generators/${f}`));
    expect({ step: "tsc", ...tsc }).toMatchObject({ step: "tsc", exit: 0 });

    expect(await meta(root, "gen")).toMatchObject({ exit: 0 });

    // JSON Schema: one per concrete object, none for the abstract base.
    const out = join(root, "src", "generated");
    const customer = JSON.parse(readFileSync(join(out, "schemas/shop/Customer.schema.json"), "utf8")) as Json;
    expect(customer.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const props = customer.properties as Record<string, Json>;
    expect(props.createdAt).toEqual({ type: "string", format: "date-time" });   // inherited
    expect(props.labels).toEqual({ type: "array", items: { type: "string" } }); // inherited array
    expect(props.shipping).toEqual({ $ref: "./Address.schema.json" });
    expect(customer.required).toEqual(["createdAt", "email"]);
    expect(customer.description).toBe("A person who buys.");
    const orderLine = JSON.parse(readFileSync(join(out, "schemas/shop/OrderLine.schema.json"), "utf8")) as Json;
    expect((orderLine.properties as Record<string, Json>).status).toEqual({ type: "string", enum: ["open", "paid"] });
    readFileSync(join(out, "schemas/shop/Address.schema.json"), "utf8");
    expect(() => readFileSync(join(out, "schemas/shop/BaseEntity.schema.json"))).toThrow();

    // OpenAPI: 3.1, the reference collection paths under apiPrefix, every $ref resolvable.
    const api = JSON.parse(readFileSync(join(out, "openapi.json"), "utf8")) as Json;
    expect(api.openapi).toBe("3.1.0");
    expect(Object.keys(api.paths as Json).sort()).toEqual([
      "/api/customers", "/api/customers/{id}", "/api/order_lines", "/api/order_lines/{id}",
    ]);
    expect(Object.keys((api.components as Json).schemas as Json).sort()).toEqual(["Address", "Customer", "OrderLine"]);
    expect(unresolvedRefs(api)).toEqual([]);

    const verified = await meta(root, "verify", "--codegen");
    expect({ step: "verify", ...verified }).toMatchObject({ step: "verify", exit: 0 });
  }, 180_000);
});
