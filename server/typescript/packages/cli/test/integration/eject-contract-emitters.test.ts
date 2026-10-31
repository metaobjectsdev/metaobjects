/**
 * FR-022 — an ejected contract emitter stands on the engine and on what eject copied.
 *
 * The contract stages are not on the package root. `meta eject` copies them into
 * `codegen/templates/`, so an owned `openapi` or `contract-schema` must compile and run with
 * the package's public entries alone: this ejects both into a project that links only those
 * packages, compiles the whole owned tree with `tsc`, runs `meta gen` through the copies, and
 * holds the output to the packaged generators' bytes.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as packageRoot from "@metaobjectsdev/codegen-ts";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { jsonSchemaFile, openApiFile } from "@metaobjectsdev/codegen-ts/generators";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { run } from "../../src/index.js";

const CLI_ROOT = resolve(import.meta.dirname, "..", "..");
const TSC = join(CLI_ROOT, "node_modules", "typescript", "bin", "tsc");
const DEPS = ["@metaobjectsdev/codegen-ts", "@metaobjectsdev/metadata", "@types/node", "typescript"];

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          children: [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 200, "@filterable": true } },
            { "field.decimal": { name: "price", "@precision": 10, "@scale": 2 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
}, null, 2);

const CONFIG = `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { jsonSchemaFile } from "./codegen/generators/contract-schema.js";
import { openApiFile } from "./codegen/generators/openapi.js";

export default defineConfig({
  outDir: "src/gen",
  dialect: "sqlite",
  apiPrefix: "/api",
  extStyle: "js",
  generators: [jsonSchemaFile(), jsonSchemaFile({ profile: "strict" }), openApiFile({ title: "Shop", version: "1.0.0" })],
});
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noEmit: true, skipLibCheck: true, types: ["node"],
  },
  include: ["codegen/**/*.ts", "metaobjects.config.ts"],
}, null, 2);

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "mo-owned-contract-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), META);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "owned-contract-app", type: "module" }));
  writeFileSync(join(root, "metaobjects.config.ts"), CONFIG);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const name of DEPS) {
    const target = join(CLI_ROOT, "node_modules", name);
    if (!existsSync(target)) throw new Error(`test setup: ${name} is not installed under ${CLI_ROOT}`);
    const link = join(root, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
  return root;
}

async function quietly(argv: string[]): Promise<number> {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run(argv);
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function packagedOpenApi(outDir: string): Promise<string> {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([new InMemoryStringSource(META, { id: "meta.shop.json" })]);
  await runGen({
    config: defineConfig({
      outDir,
      dialect: "sqlite",
      apiPrefix: "/api",
      generators: [jsonSchemaFile(), openApiFile({ title: "Shop", version: "1.0.0" })],
    }),
    metadata: root,
    genStateDir: join(outDir, ".gen-state"),
  });
  return readFileSync(join(outDir, "openapi.json"), "utf8");
}

describe("an ejected contract emitter", () => {
  test("the package root holds none of the contract stages", () => {
    const root = packageRoot as Record<string, unknown>;
    for (const name of ["jsonSchemaFile", "openApiFile", "buildOpenApiDocument", "objectSchema", "fieldSchema", "strictSchema", "ContractEmitError"]) {
      expect(root[name], name).toBeUndefined();
    }
  });

  test("eject → tsc → gen, with no root export of the stages it copied", async () => {
    const root = scaffold();
    try {
      expect(await quietly(["eject", "contract-schema", "openapi", "--cwd", root])).toBe(0);
      for (const copied of ["build-openapi", "field-schema", "object-schema", "strict-profile", "contract-errors"]) {
        expect(existsSync(join(root, "codegen", "templates", "contract", `${copied}.ts`)), copied).toBe(true);
      }

      const tsc = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
      expect(tsc.stdout + tsc.stderr).toBe("");
      expect(tsc.status).toBe(0);

      expect(await quietly(["gen", "--cwd", root])).toBe(0);
      const owned = readFileSync(join(root, "src", "gen", "openapi.json"), "utf8");
      expect(owned).toBe(await packagedOpenApi(join(root, "packaged")));
      expect(existsSync(join(root, "src", "gen", "schemas", "acme", "shop", "Product.strict.schema.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
