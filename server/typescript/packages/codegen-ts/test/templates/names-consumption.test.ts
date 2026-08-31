// §A6 — the generated Drizzle binding REFERENCES <Entity>Names instead of embedding the
// physical names a second time.
//
// Both arms live here on purpose. Consumption is conditional (the names generator is
// opt-in under ADR-0034 scaffold-and-own — `meta gen` runs the adopter's own copies, so a
// packaged change cannot reach anyone who has ejected), and a conditional whose OFF arm is
// untested is how a default-off knob ships broken. The ABSENT arm passing BEFORE the change
// is what proves the change is additive.
//
// Both arms run through `runGen`, not through a hand-built RenderContext, so the whole
// chain is under test: namesFile()'s `emitsNames` marker → the runner's aggregation →
// ResolvedGenConfig.includeNames + RenderContext.includeNames → the template.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen, defineConfig } from "../../src/index.js";
import ts from "typescript";
import { entityFile, namesFile, queriesFile } from "../../src/generators/index.js";
import type { ExtStyle } from "../../src/render-context.js";

const FIXTURE = resolve(import.meta.dir, "../fixtures/trainer-website-shape.json");

const loader = new MetaDataLoader();
const loadResult = await loader.load([new FileSource(FIXTURE)]);
if (loadResult.errors.length > 0) {
  throw new Error(`Fixture load errors: ${loadResult.errors.join(", ")}`);
}
const metadataRoot = loadResult.root;

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-names-consume-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Generate `Subscriber.ts` with the names generator either wired in or absent. */
async function renderEntityWithGenerators(active: boolean, extStyle: ExtStyle = "js"): Promise<string> {
  const result = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle,
      dbImport: "~/server/db",
      dialect: "sqlite",
      generators: active ? [entityFile(), namesFile()] : [entityFile()],
    }),
    metadata: metadataRoot,
  });
  expect(result.warnings).toEqual([]);
  return readFileSync(join(tmp, "Subscriber.ts"), "utf-8");
}

describe("§A6 — the entity file consumes the names artifact", () => {
  test("with the names generator ACTIVE, the table binding references the constants", async () => {
    const out = await renderEntityWithGenerators(true);

    expect(out).toContain(`import { SubscriberNames } from "./Subscriber.names.js";`);
    expect(out).toContain("sqliteTable(SubscriberNames.name");
    expect(out).toContain("text(SubscriberNames.fields.createdAt.column)");

    // The literals are GONE, not merely joined by a constant. A generator that emitted the
    // reference while leaving the old spelling in place would satisfy every toContain above
    // and still be two independent spellings of one name — the exact defect §A6 removes.
    expect(out).not.toContain(`sqliteTable("subscribers"`);
    expect(out).not.toContain(`text("created_at")`);
    expect(out).not.toContain(`text("first_name")`);

    // ts-poet must dedupe the import to ONE line. Two physical ts-poet copies have twice
    // shipped duplicate import headers from this package (0.21.6's split Code tree, and the
    // queries generator's triple `import { eq }`), and both surfaced as TS2300.
    expect(out.split("\n").filter((l) => l.includes("Subscriber.names"))).toHaveLength(1);
  });

  test("with the names generator ABSENT, output is byte-identical to today", async () => {
    const out = await renderEntityWithGenerators(false);

    expect(out).toContain(`sqliteTable("subscribers"`);
    expect(out).toContain(`text("created_at")`);
    expect(out).not.toContain("SubscriberNames");
    expect(out).not.toContain(".names");
  });

  test("the import specifier follows extStyle, like every other cross-module reference", async () => {
    const out = await renderEntityWithGenerators(true, "none");
    expect(out).toContain(`import { SubscriberNames } from "./Subscriber.names";`);
  });

  // The reference is a RELATIVE sibling import, and the names artifact is not a registered
  // cross-target module — there is no `importBase` route to it the way there is to an entity
  // module. So the flag has to be scoped to the target that actually emits the artifact, or
  // an entity module routed to its own package would import `./<Entity>.names` from a
  // directory that holds no such file.
  test("an entity module on a DIFFERENT target than the names generator keeps the literals", async () => {
    const result = await runGen({
      config: defineConfig({
        outDir: join(tmp, "names"),
        extStyle: "js",
        dbImport: "~/server/db",
        dialect: "sqlite",
        targets: { db: { outDir: join(tmp, "db") } },
        generators: [entityFile({ target: "db" }), namesFile()],
      }),
      metadata: metadataRoot,
    });
    expect(result.warnings).toEqual([]);

    const entity = readFileSync(join(tmp, "db/Subscriber.ts"), "utf-8");
    expect(entity).toContain(`sqliteTable("subscribers"`);
    expect(entity).not.toContain("SubscriberNames");
    // The artifact really did land elsewhere — otherwise this test would pass for the
    // wrong reason (nothing emitted, nothing to import).
    expect(existsSync(join(tmp, "names/Subscriber.names.ts"))).toBe(true);
  });

  // Codegen tests must EXECUTE (or at minimum COMPILE) generated code, not just diff
  // strings: the whole point of §A6 is that a wrong name stops being an unread string. The
  // failure this catches is the one Step 0 fixed — a reference to a module that does not
  // resolve — plus a subtler one: `<Entity>Names` is `as const`, so its `name`/`column`
  // members carry LITERAL types, and Drizzle's InferSelectModel folds them into the row
  // type. A widened `string` there would silently change every generated type.
  test("entity + queries + names compile together against the real drizzle/zod types", async () => {
    // Inside the package so the program resolves drizzle-orm / zod from its node_modules.
    const dir = mkdtempSync(join(import.meta.dir, "tmp-names-compile-"));
    try {
      const result = await runGen({
        config: defineConfig({
          outDir: dir,
          extStyle: "js",
          dbImport: "~/server/db",
          dialect: "sqlite",
          generators: [entityFile({ allowlists: false }), queriesFile(), namesFile()],
        }),
        metadata: metadataRoot,
      });
      expect(result.warnings).toEqual([]);

      const program = ts.createProgram(result.files.map((f) => f.path), {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
