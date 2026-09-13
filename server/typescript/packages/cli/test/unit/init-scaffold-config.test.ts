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
    // ...and does NOT narrow `surfaces`. The resolver defaults to all four, and its
    // own rationale is that `agent` must default ON "so the always-on agent-context
    // pointer can name the files: a pointer to a page an adopter has to opt into is a
    // pointer at nothing." The scaffold used to write ["model", "api"], switching off
    // `requirements` and `agent` for every scaffolded project and defeating exactly
    // that. Asserted as an ABSENCE because the correct scaffold says nothing here.
    expect(body).not.toMatch(/^\s*surfaces:\s*\[/m);
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
    expect(body).not.toContain("@metaobjectsdev/codegen-ts/generators");
  });

  test("an ejected generator is the copyable reference template, and re-init preserves it", async () => {
    await init({ cwd: tmp, quiet: true });

    const { ejectGenerator } = await import("../../src/commands/eject.js");
    await ejectGenerator({ cwd: tmp, name: "entity" });
    const entityPath = join(tmp, "codegen/generators/entity.ts");
    const entity = readFileSync(entityPath, "utf-8");
    expect(entity).toContain("REFERENCE TEMPLATE");
    // It imports the stable engine, never the deprecated `/generators` export.
    expect(entity).toContain('from "@metaobjectsdev/codegen-ts"');
    expect(entity).not.toContain("@metaobjectsdev/codegen-ts/generators");

    // A hand edit survives `meta init --force` — init has no business in this
    // directory at all now, which is a stronger guarantee than the copier's old
    // preserve-if-present rule.
    writeFileSync(entityPath, entity + "\n// HAND-EDIT-SENTINEL\n");
    await init({ cwd: tmp, quiet: true, force: true });
    expect(readFileSync(entityPath, "utf-8")).toContain("HAND-EDIT-SENTINEL");
  });
});
