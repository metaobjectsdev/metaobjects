import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, nextStepsBlock } from "../../src/commands/init.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "forge-init-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("meta init scaffolds metaobjects.config.ts", () => {
  test("writes a default metaobjects.config.ts at project root", async () => {
    const result = await init({ cwd: tmp, quiet: true });
    expect(existsSync(join(tmp, "metaobjects.config.ts"))).toBe(true);
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(body).toContain(`import { defineConfig } from "@metaobjectsdev/cli"`);
    expect(body).toContain(`entityFile()`);
    expect(body).toContain(`queriesFile()`);
    expect(body).toContain(`routesFile()`);
    expect(body).toContain(`barrel()`);
    expect(result.created).toContain("metaobjects.config.ts");
  });

  test("does NOT route neutral docs through meta gen (ADR-0021 D1: meta docs is the single door)", async () => {
    // docsFile() is the INTERNAL engine of the `meta docs` command, not a `meta gen`
    // config generator. Scaffolding it into metaobjects.config.ts would resurrect the
    // exact second-door the @deprecated note on docsFile() forbids. Discoverability of
    // neutral docs is via the `meta docs` command (surfaced in the next-steps block),
    // not the generators array.
    await init({ cwd: tmp, quiet: true });
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(body).not.toContain("docsFile");
    // ADR-0025: apiDocsFile() likewise is the INTERNAL engine of `meta docs`'s api
    // surface, not a generators-array entry. The scaffold expresses docs intent via a
    // `docs:` config block consumed by `meta docs`, not via a deprecated generator.
    expect(body).not.toContain("apiDocsFile");
    expect(body).toContain("docs:");
    expect(body).toContain("surfaces:");
    expect(nextStepsBlock()).toContain("meta docs");
  });

  test("does not overwrite an existing metaobjects.config.ts on subsequent runs", async () => {
    await init({ cwd: tmp, quiet: true });
    const before = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    writeFileSync(join(tmp, "metaobjects.config.ts"), before + "\n// HAND-EDIT-SENTINEL\n");
    // force: true required — metaobjects/ already exists from the first call
    await init({ cwd: tmp, quiet: true, force: true });
    const after = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(after).toContain("HAND-EDIT-SENTINEL");
  });

  test("--refresh-docs does not touch metaobjects.config.ts", async () => {
    await init({ cwd: tmp, quiet: true });
    const before = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    await init({ cwd: tmp, quiet: true, refreshDocs: true });
    const after = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(after).toBe(before);
  });

  test("does NOT create legacy forge.config.ts", async () => {
    await init({ cwd: tmp, quiet: true });
    expect(existsSync(join(tmp, "forge.config.ts"))).toBe(false);
  });
});

// ADR-0034 scaffold-and-own — `meta init` copies the codegen reference templates into
// the consumer repo (codegen/generators/*.ts), and the scaffolded config imports those
// OWNED local copies instead of the deprecated package `/generators` export.
describe("meta init scaffolds OWNED codegen generators (ADR-0034)", () => {
  const GENERATORS = ["entity", "queries", "routes", "barrel"] as const;

  test("writes codegen/generators/{entity,queries,routes,barrel}.ts", async () => {
    const result = await init({ cwd: tmp, quiet: true });
    for (const name of GENERATORS) {
      const rel = `codegen/generators/${name}.ts`;
      expect(existsSync(join(tmp, rel))).toBe(true);
      expect(result.created).toContain(rel);
    }
  });

  test("owned generators are the copyable reference templates (REFERENCE TEMPLATE header)", async () => {
    await init({ cwd: tmp, quiet: true });
    const entity = readFileSync(join(tmp, "codegen/generators/entity.ts"), "utf-8");
    expect(entity).toContain("REFERENCE TEMPLATE");
    // They import the stable engine, never the deprecated `/generators` export.
    expect(entity).toContain('from "@metaobjectsdev/codegen-ts"');
    expect(entity).not.toContain("@metaobjectsdev/codegen-ts/generators");
  });

  test("the scaffolded config imports each owned generator locally", async () => {
    await init({ cwd: tmp, quiet: true });
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(body).toContain('import { entityFile } from "./codegen/generators/entity"');
    expect(body).toContain('import { queriesFile } from "./codegen/generators/queries"');
    expect(body).toContain('import { routesFile } from "./codegen/generators/routes"');
    expect(body).toContain('import { barrel } from "./codegen/generators/barrel"');
    expect(body).not.toContain("@metaobjectsdev/codegen-ts/generators");
  });

  test("re-init with --force preserves a hand-edited owned generator", async () => {
    await init({ cwd: tmp, quiet: true });
    const entityPath = join(tmp, "codegen/generators/entity.ts");
    const edited = readFileSync(entityPath, "utf-8") + "\n// HAND-EDIT-SENTINEL\n";
    writeFileSync(entityPath, edited);
    const result = await init({ cwd: tmp, quiet: true, force: true });
    expect(readFileSync(entityPath, "utf-8")).toContain("HAND-EDIT-SENTINEL");
    expect(result.preserved).toContain("codegen/generators/entity.ts");
  });
});
