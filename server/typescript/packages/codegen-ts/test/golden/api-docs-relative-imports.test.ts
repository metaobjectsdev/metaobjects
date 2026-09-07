// api-docs RELATIVE-IMPORT + Hono-auto-detect gate.
//
// Two staff-review findings this gate locks in:
//
//   Fix 1 (HEADLINE) — the api-docs CODE BLOCKS must show `./`-prefixed RELATIVE
//   import specifiers so a copy-paste consumer COMPILES. The real generated code
//   imports its siblings relatively (`from "./Product"`), but the api-docs used
//   to render BARE specifiers (`from "Product.queries"`), which only resolve with
//   a non-default `baseUrl` — a verbatim copy-paste failed with TS2307. This gate:
//     (a) asserts the rendered import HEADERS (human page + agent group header +
//         the example import block) are `./`-prefixed, and
//     (b) actually `tsc`-compiles a consumer written FROM the rendered AGENT-API.md
//         import block + CRUD example AGAINST the REAL generated entity+queries
//         code — proving the imports RESOLVE (no TS2307) and the CRUD call
//         type-checks. (Scoped to the CRUD/entity surface — the extractor/render
//         `./payloads.js` generator bug is a sibling task.)
//
//   Fix 2 — api-docs must DOCUMENT Hono routes when the Hono routes generator is
//   in the run. The builder gates rest-hono on `includeHonoRoutes`; the api-docs
//   GENERATOR now AUTO-DETECTS that flag from the active generator suite
//   (`ctx.config.includeHonoRoutes`, aggregated by the runner from a
//   `routesFileHono` generator's `emitsHonoRoutes` marker).

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { routesFileHono } from "../../src/generators/index.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { buildApiModel, type ApiModel } from "../../src/generators/api-model.js";
import { renderEntityApiPage, renderAgentApi } from "../../src/generators/api-doc-render.js";
import { frameworkTemplatesProvider } from "../../src/render-engine/framework-provider.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { runGen, defineConfig } from "../../src/index.js";
import type { Generator, GenContext, EmittedFile } from "../../src/generator.js";

const provider = frameworkTemplatesProvider;

// A simple CRUD entity (PK `id`, one required string field) — enough to exercise
// the full model / data-access / validation / REST surface + a worked example.
const CHILDREN = [
  {
    "object.entity": {
      name: "Product",
      children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
        { "source.rdb": { "@table": "products" } },
      ],
    },
  },
];

async function loadRoot() {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::shop", children: CHILDREN } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function loadModel(opts?: { includeHonoRoutes?: boolean }): Promise<ApiModel> {
  const root = await loadRoot();
  return buildApiModel(root, { loadedRoot: root, ...(opts ?? {}) });
}

// ---------------------------------------------------------------------------
// Fix 1 — rendered import specifiers are `./`-prefixed (RELATIVE).
// ---------------------------------------------------------------------------

describe("Fix 1: rendered api-docs import specifiers are `./`-prefixed (copy-paste resolves)", () => {
  test("human page: each `import { … } from \"…\"` block is `./`-prefixed, never bare", async () => {
    const model = await loadModel();
    const unit = model.units.find((u) => u.node === "Product")!;
    const out = renderEntityApiPage(unit, provider);
    // The corrected, copy-paste-correct forms.
    expect(out).toContain(`import { findProductById } from "./Product.queries"`);
    expect(out).toContain(`import { Product } from "./Product"`);
    expect(out).toContain(`import { productRoutes } from "./Product.routes"`);
    // No BARE specifier leaked through.
    expect(out).not.toContain(`from "Product.queries"`);
    expect(out).not.toContain(`from "Product.routes"`);
    expect(out).not.toMatch(/from "Product"\n/);
  });

  test("human page Example block: the example imports are `./`-prefixed", async () => {
    const model = await loadModel();
    const unit = model.units.find((u) => u.node === "Product")!;
    const out = renderEntityApiPage(unit, provider);
    // The worked-example fenced block imports the CRUD helpers relatively.
    expect(out).toContain(`from "./Product.queries";`);
    expect(out).not.toContain(`from "Product.queries";`);
  });

  test("agent form: every group import header + example imports are `./`-prefixed", async () => {
    const model = await loadModel();
    const out = renderAgentApi(model, provider);
    expect(out).toContain(
      `import { findProductById, listProducts, createProduct, updateProduct, deleteProductById } from "./Product.queries"`,
    );
    expect(out).toContain(`import { Product, ProductInsertSchema, ProductUpdateSchema } from "./Product"`);
    expect(out).toContain(`import { productRoutes } from "./Product.routes"`);
    // No bare header anywhere in the agent form.
    const bareHeaders = out
      .split("\n")
      .filter((l) => /^`import \{ .* \} from "(?!\.\/)/.test(l));
    expect(bareHeaders).toEqual([]);
  });

  test("package layout: the relative prefix folds under the package path", async () => {
    // The entity-derived modules fold under the entity's OWN package in package
    // layout (matching the emitting generator), so give Product an explicit
    // package so the folded path is exercised.
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            children: [
              {
                "object.entity": {
                  name: "Product",
                  package: "acme::shop",
                  children: [
                    { "field.long": { name: "id" } },
                    { "field.string": { name: "name", "@required": true } },
                    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                    { "source.rdb": { "@table": "products" } },
                  ],
                },
              },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    const model = buildApiModel(res.root, { loadedRoot: res.root, outputLayout: "package" });
    const unit = model.units.find((u) => u.node === "Product")!;
    const out = renderEntityApiPage(unit, provider);
    // package layout → the importPath is already package-folded; the prefix is `./`.
    expect(out).toContain(`from "./acme/shop/Product.queries"`);
    expect(out).toContain(`from "./acme/shop/Product"`);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — the REAL compile gate: a consumer written from AGENT-API.md compiles
// against the REAL generated entity+queries code (no TS2307, CRUD type-checks).
// ---------------------------------------------------------------------------

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

/** Run one generator with a structural GenContext (mirrors the accuracy gate). */
async function runGenerator(
  gen: Generator,
  root: Awaited<ReturnType<typeof loadRoot>>,
  projectRoot: string,
  configExtra?: Record<string, unknown>,
): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot,
    config: {
      outDir: "/tmp",
      extStyle: "none",
      dbImport: "~/db",
      dialect: "sqlite",
      ...(configExtra ?? {}),
    } as never,
    renderContext,
    warn: () => {},
  };
  return gen.generate(ctx);
}

/** Pull the FIRST ```ts fenced block whose body contains `marker`. */
function tsBlockContaining(md: string, marker: string): string {
  const re = /```ts\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const body = m[1]!;
    if (body.includes(marker)) return body;
  }
  throw new Error(`no \`\`\`ts block containing "${marker}"`);
}

// Ambient stubs for the external packages the generated entity+queries import.
// The compile gate's job is to prove the api-docs' OWN relative imports resolve
// + the CRUD call type-checks — NOT to re-type-check drizzle/zod, so these are
// intentionally permissive.
const ENGINE_STUBS = `declare module "drizzle-orm" {
  export type InferInsertModel<T> = any;
  export type InferSelectModel<T> = any;
  export const eq: any;
}
declare module "drizzle-orm/sqlite-core" {
  export const integer: any;
  export const sqliteTable: any;
  export const text: any;
  // Arity must cover every argument the generated \`Db\` alias supplies — real
  // drizzle takes four (resultKind, runResult, fullSchema, schema) and the alias
  // now names three, since leaving the SCHEMA parameter at drizzle's
  // \`Record<string, never>\` default rejected a \`drizzle(client, { schema })\` db.
  // A stub too narrow here fails with TS2707, not with anything about the docs.
  export type BaseSQLiteDatabase<A = any, B = any, C = any, D = any> = any;
}
declare module "drizzle-orm/node-postgres" {
  export const drizzle: any;
}
declare module "pg" {
  export const Pool: any;
}
declare module "zod" {
  export const z: any;
  // The generated entity file derives \`<Entity>Patch = z.input<typeof <Entity>UpdateSchema>\`,
  // which uses \`z\` as a TYPE namespace (real zod merges the value with a namespace of
  // input/infer/output helpers). The stub must expose those or \`z.input\` is TS2503 here,
  // even though the code compiles cleanly against real zod.
  export namespace z {
    type input<T> = any;
    type infer<T> = any;
    type output<T> = any;
  }
}
declare module "@metaobjectsdev/runtime-ts/drizzle-fastify" {
  export type FilterAllowlist = any;
  export type SortAllowlist = any;
}
`;

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program);
}

describe("Fix 1: a CRUD consumer from AGENT-API.md COMPILES against the REAL generated code (no TS2307)", () => {
  test("the doc's `./`-prefixed imports RESOLVE + the CRUD example type-checks", async () => {
    const root = await loadRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), "api-docs-relimports-proj-"));
    TEMP_DIRS.push(projectRoot);

    // 1. Generate the REAL entity + queries code for Product (flat layout).
    const entityFiles = await runGenerator(entityFile(), root, projectRoot);
    const queriesFiles = await runGenerator(queriesFile(), root, projectRoot);

    // 2. Build the api-docs agent form for the SAME model.
    const model = buildApiModel(root, { loadedRoot: root });
    const agent = renderAgentApi(model, provider);

    // 3. Lay out a temp output dir exactly as a consumer's generated dir: the
    //    real generated files at the root + a consumer that copy-pastes the
    //    doc's import header + CRUD example body.
    const dir = mkdtempSync(join(tmpdir(), "api-docs-relimports-"));
    TEMP_DIRS.push(dir);
    const write = (rel: string, body: string) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    };
    for (const f of [...entityFiles, ...queriesFiles]) write(f.path, f.content);
    write("engine-stubs.d.ts", ENGINE_STUBS);

    // The consumer: the queries group import header (verbatim from the agent
    // form) + the worked CRUD example body (verbatim) wrapped in an async fn so
    // top-level await is legal.
    const queriesHeader = agent
      .split("\n")
      .map((l) => l.replace(/^`|`$/g, ""))
      .find((l) => /^import \{ .* \} from "\.\/Product\.queries"$/.test(l));
    expect(queriesHeader, "agent form carries a ./Product.queries import header").toBeDefined();
    const exampleBody = tsBlockContaining(agent, "createProduct(db,");

    const consumer = `${queriesHeader}
declare const db: any;
export async function run() {
${exampleBody}
  // Type-check that the CRUD return types flow through.
  const _name: string | undefined = found?.name;
  return { created, found, updated, removed, _name };
}
`;
    write("consumer.ts", consumer);

    // 4. tsc the consumer against the real generated files. The headline
    //    assertion: NO TS2307 (module-not-found) on the doc's imports.
    const fileList = [
      ...entityFiles.map((f) => f.path),
      ...queriesFiles.map((f) => f.path),
      "engine-stubs.d.ts",
      "consumer.ts",
    ];
    const diags = compile(dir, fileList);
    const ts2307 = diags.filter((d) => d.code === 2307);
    const ts2307Msgs = ts2307.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
    expect(ts2307Msgs, `module-not-found (TS2307) from the doc's imports:\n${ts2307Msgs.join("\n")}`).toEqual([]);

    // And the consumer type-checks cleanly overall (the CRUD calls are valid).
    const all = diags.map(
      (d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
    expect(all, `consumer did not type-check:\n${all.join("\n")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — api-docs auto-documents Hono when routesFileHono is in the run.
// ---------------------------------------------------------------------------

const HONO_CHILDREN = CHILDREN;

describe("Fix 2: api-docs documents Hono routes when the Hono generator is in the run", () => {
  test("ctx.config.includeHonoRoutes drives the builder — Hono symbols are documented", async () => {
    const root = await loadRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), "api-docs-hono-"));
    TEMP_DIRS.push(projectRoot);

    // The api-docs generator, run with includeHonoRoutes in its ctx.config
    // (which the runner aggregates from a routesFileHono in the suite).
    const files = await runGenerator(apiDocsFile(), root, projectRoot, {
      outputLayout: "flat",
      includeHonoRoutes: true,
    });
    const agentFile = files.find((f) => f.path.endsWith("AGENT-API.md"))!;
    expect(agentFile, "AGENT-API.md emitted").toBeDefined();
    // The Hono CRUD registrar is documented.
    expect(agentFile.content).toContain(`register${"Product"}Routes`);
    expect(agentFile.content).toContain(`./Product.routes.hono`);
  });

  test("without includeHonoRoutes, NO Hono symbols are documented (Fastify only)", async () => {
    const root = await loadRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), "api-docs-nohono-"));
    TEMP_DIRS.push(projectRoot);
    const files = await runGenerator(apiDocsFile(), root, projectRoot, { outputLayout: "flat" });
    const agentFile = files.find((f) => f.path.endsWith("AGENT-API.md"))!;
    expect(agentFile.content).not.toContain("registerProductRoutes");
    expect(agentFile.content).not.toContain("routes.hono");
  });

  test("the routesFileHono generator carries the emitsHonoRoutes marker (runner aggregates it)", () => {
    const hono = routesFileHono();
    expect((hono as Generator & { emitsHonoRoutes?: boolean }).emitsHonoRoutes).toBe(true);
    // The default Fastify routes generator does NOT carry it.
    const fastify = routesFile();
    expect((fastify as Generator & { emitsHonoRoutes?: boolean }).emitsHonoRoutes).not.toBe(true);
  });

  // ADR-0025: `meta docs` is the single docs door. apiDocsFile() left in a `meta gen`
  // config is WARNED + SKIPPED by the runner — it no longer emits docs/api/ here. The
  // Hono auto-documentation behavior (ctx.config.includeHonoRoutes driving the api model)
  // is still gated by the three sibling tests above, which invoke apiDocsFile() directly.
  // (Previously this test ran apiDocsFile() through runGen and asserted docs/api/AGENT-API.md
  // contents — that exercised the now-deprecated generator-in-config door.)
  test("runGen: api-docs in a meta gen config is warned + skipped (no docs/api output) — ADR-0025", async () => {
    const root = await loadRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), "api-docs-rungen-"));
    TEMP_DIRS.push(projectRoot);

    const outDir = mkdtempSync(join(tmpdir(), "api-docs-rungen-skip-"));
    TEMP_DIRS.push(outDir);
    const result = await runGen({
      config: defineConfig({
        outDir,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "sqlite",
        generators: [entityFile(), queriesFile(), routesFile(), routesFileHono(), apiDocsFile()],
      }),
      metadata: root,
      projectRoot,
    });

    // (a) the deprecated generator was warned + pointed at `meta docs`.
    const warn = result.warnings.find((w) => /api-docs/.test(w) && /meta docs/.test(w));
    expect(warn).toBeDefined();

    // (b) it was SKIPPED — no docs/api/ output exists.
    const fs = require("node:fs");
    expect(fs.existsSync(join(outDir, "docs/api/AGENT-API.md"))).toBe(false);
    expect(result.files.some((f) => f.path.includes(`docs${require("node:path").sep}api`))).toBe(false);

    // (c) the normal generators still ran.
    expect(result.files.some((f) => f.path.endsWith("Product.ts"))).toBe(true);
  });
});
