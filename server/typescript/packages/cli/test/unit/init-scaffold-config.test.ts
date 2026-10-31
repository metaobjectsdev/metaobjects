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
    // Codegen is opt-in: the scaffolded selection is EMPTY, and the config's job is to
    // say so and point at the catalog rather than to wire a shape nobody chose.
    expect(body).toContain("generators: []");
    expect(body).toContain("meta gen --list");
    expect(body).toContain("meta eject");
    expect(result.created).toContain("metaobjects.config.ts");
  });

  // The sentence sends a reader to `meta generator new` for what no catalog entry emits, so
  // it may not name an output the catalog ships.
  test("does not send a reader to hand-write what the catalog ships", async () => {
    await init({ cwd: tmp, quiet: true });
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    const sentence = /Need an output nothing in that catalog emits[^?]*\?/.exec(body.replace(/\n\s*\/\/\s*/g, " "))?.[0];
    expect(sentence).toBeDefined();
    for (const shipped of ["OpenAPI", "JSON Schema"]) expect(sentence).not.toContain(shipped);
  });

  // ADR-0034 Amendment 9: nothing is generated that the config does not declare, and
  // `meta init` declares nothing, documentation included. It writes no `docs` block (the 1.0
  // shape `meta gen` now refuses) and wires no docs generator; it says how to add one.
  test("writes no docs block and wires no docs generator, and says how to add one", async () => {
    await init({ cwd: tmp, quiet: true });
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(body).not.toMatch(/^\s*docs:\s*\{/m);
    expect(body).toMatch(/^\s*generators:\s*\[\],/m);
    expect(body).toContain("targets: { docs: { outDir:");
    expect(nextStepsBlock()).not.toContain("meta docs");
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

// ADR-0034 Amendment 2 — `meta init` copies NOTHING into codegen/generators/.
//
// The directory and its tsconfig are scaffolded because they are the LAYOUT the
// scaffold-and-own contract promises; what lands in them is the adopter's choice, made
// through `meta eject`. Ownership itself is unchanged: an ejected file is theirs, and
// `meta gen` runs their copy.
describe("meta init scaffolds the owned-codegen tier, empty (ADR-0034 Amendment 2)", () => {
  test("creates the directory and its tsconfig, and copies no generator into it", async () => {
    const result = await init({ cwd: tmp, quiet: true });
    expect(existsSync(join(tmp, "codegen/generators"))).toBe(true);
    expect(existsSync(join(tmp, "tsconfig.codegen.json"))).toBe(true);
    expect(result.created).toContain("tsconfig.codegen.json");
    for (const name of ["entity", "queries", "routes", "barrel", "names"]) {
      expect(existsSync(join(tmp, `codegen/generators/${name}.ts`)), name).toBe(false);
    }
    expect(result.created.filter((p) => p.startsWith("codegen/generators/"))).toEqual([]);
  });

  test("the scaffolded config imports no generator at all", async () => {
    await init({ cwd: tmp, quiet: true });
    const body = readFileSync(join(tmp, "metaobjects.config.ts"), "utf-8");
    expect(body).not.toMatch(/^import .* from "\.\/codegen\/generators\//m);
    // The package import appears ONLY as a commented example of how to wire one; an
    // uncommented line would be the default suite Amendment 2 removed.
    expect(body).not.toMatch(/^import .* from "@metaobjectsdev\/codegen-ts\/generators"/m);
    expect(body).toMatch(/^\s*\/\/\s+import \{ entityFile, queriesFile, barrel \} from "@metaobjectsdev\/codegen-ts\/generators";$/m);
  });

  test("an ejected generator is the copyable reference template, and re-init preserves it", async () => {
    await init({ cwd: tmp, quiet: true });

    const { ejectGenerator } = await import("../../src/commands/eject.js");
    await ejectGenerator({ cwd: tmp, name: "entity" });
    const entityPath = join(tmp, "codegen/generators/entity.ts");
    const entity = readFileSync(entityPath, "utf-8");
    expect(entity).toContain("REFERENCE TEMPLATE");
    // It imports the stable engine, never the packaged factory it is a copy of: an owned
    // generator that called the package's would not own what it emits.
    expect(entity).toContain('from "@metaobjectsdev/codegen-ts/engine"');
    expect(entity).not.toContain("@metaobjectsdev/codegen-ts/generators");

    // A hand edit survives `meta init --force` — init has no business in this
    // directory at all now, which is a stronger guarantee than the copier's old
    // preserve-if-present rule.
    writeFileSync(entityPath, entity + "\n// HAND-EDIT-SENTINEL\n");
    await init({ cwd: tmp, quiet: true, force: true });
    expect(readFileSync(entityPath, "utf-8")).toContain("HAND-EDIT-SENTINEL");
  });
});
