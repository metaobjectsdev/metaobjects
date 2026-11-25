// ADR-0064 — the `meta gen` skip key covers the code of every generator package the config
// imports, `@metaobjectsdev/*` ones included, except the packages the CLI aliases onto its own
// engine (those are the engine, counted once as such).
//
// The defect this pins: the key dropped EVERY `@metaobjectsdev/*` import on the assumption
// that the CLI aliases it, while the engine half only hashes the CLI's own dependencies. A
// package the CLI does not depend on (an independent pack, say) was then hashed by nothing,
// so editing a linked copy's generator left the key unchanged and `meta gen` skipped over
// stale output.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genCommand } from "../src/commands/gen.js";
import {
  computeGenInputs, decideGenSkip, keyFor, withModel,
  type FingerprintEntry, type GenSelection,
} from "../src/lib/gen-fingerprint.js";
import { CLI_ALIASED_PACKAGES } from "../src/lib/load-metaobjects-config.js";
import { collectionLoadOptions } from "../src/lib/collection-load-options.js";
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { modelHashTree } from "@metaobjectsdev/codegen-ts";

// Throwaway projects live in RAM scratch. The config's engine import resolves anyway: the
// CLI rewrites it onto its own copy.
const SCRATCH = process.env.DEV_SCRATCH ?? tmpdir();
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A `@metaobjectsdev/*` package the CLI does not depend on, linked from a source checkout. */
const LINKED = "@metaobjectsdev/linked-generator-fixture";

const linkedSource = (text: string) => `export function linked() {
  return {
    name: "linked",
    generate() {
      return [{ path: "linked.txt", content: ${JSON.stringify(text)} }];
    },
  };
}
`;

/** A package the CLI aliases onto its engine (see `CLI_ALIASED_PACKAGES`). */
const ENGINE_PKG = "@metaobjectsdev/codegen-ts";

const ENGINE: FingerprintEntry[] = [{ kind: "engine", name: "(test)", hash: "fixed" }];
const SELECTION: GenSelection = { entities: [], generators: undefined, strict: false, baseline: "default" };

/** A package checked out at `<root>/<dir>` and linked into the project's node_modules, as
 *  a workspace member, a clone or `bun link` is. Returns its entry file. */
function linkPackage(root: string, dir: string, manifest: { name: string; dependencies?: Record<string, string> }, index: string): string {
  const source = join(root, dir);
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ version: "0.1.0", type: "module", main: "index.ts", ...manifest }) + "\n");
  writeFileSync(join(source, "index.ts"), index);
  mkdirSync(join(root, "node_modules", "@metaobjectsdev"), { recursive: true });
  symlinkSync(source, join(root, "node_modules", manifest.name), "dir");
  return join(source, "index.ts");
}

function makeProject(): { root: string; linkedIndex: string } {
  const root = mkdtempSync(join(SCRATCH, "gen-linked-"));
  made.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "metaobjects"));
  mkdirSync(join(root, ".metaobjects"));
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }) + "\n");
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), JSON.stringify({
    "metadata.root": { package: "shop", children: [{ "object.value": { name: "Note", children: [{ "field.string": { name: "text" } }] } }] },
  }) + "\n");

  // The linked package: its source lives outside any node_modules, as with a workspace
  // member, a clone or `bun link`, and the project's node_modules holds a symlink to it.
  const linkedIndex = linkPackage(root, "linked-checkout", { name: LINKED, dependencies: { [ENGINE_PKG]: "*" } }, linkedSource("first\n"));

  writeFileSync(join(root, "metaobjects.config.ts"), `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { linked } from "${LINKED}";
export default defineConfig({ outDir: "generated", generators: [linked()] });
`);
  return { root, linkedIndex };
}

async function inputsFor(root: string, engine?: FingerprintEntry[]) {
  const c = await resolveCollection(root);
  const model = await loadMemory(c.configDir, collectionLoadOptions(c));
  return withModel(computeGenInputs(root, c, c, SELECTION, engine), modelHashTree(model));
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

describe("the skip key covers a linked @metaobjectsdev/* generator package (ADR-0064)", () => {
  test("after a real gen, editing the linked package's generator makes the next gen render", async () => {
    const p = makeProject();
    expect(await quiet(() => genCommand([], p.root, "text"))).toBe(0);
    expect(readFileSync(join(p.root, "generated", "linked.txt"), "utf-8")).toBe("first\n");
    expect(decideGenSkip(await inputsFor(p.root))).toEqual({ skip: true, recorded: ["generated/linked.txt"] });

    writeFileSync(p.linkedIndex, linkedSource("second\n"));
    // The decision `meta gen` makes before rendering. (Rendering again here would prove nothing
    // more: this process already imported the linked module, and the runtime caches it.)
    expect(decideGenSkip(await inputsFor(p.root))).toEqual({ skip: false, reason: "an input changed" });
  });

  test("the linked package is hashed by content; editing it changes the key", async () => {
    const p = makeProject();
    const before = await inputsFor(p.root, ENGINE);
    const names = before.entries.filter((e) => e.kind === "generator-package").map((e) => e.name);
    expect(names).toContain(`${LINKED}/index.ts`);
    expect(CLI_ALIASED_PACKAGES.has(LINKED)).toBe(false);

    writeFileSync(p.linkedIndex, linkedSource("second\n"));
    expect(keyFor(await inputsFor(p.root, ENGINE), [])).not.toBe(keyFor(before, []));
  });

  test("an import the CLI aliases onto its engine is not hashed from the project's copy", async () => {
    // The config imports `@metaobjectsdev/codegen-ts`, and the linked package depends on it;
    // the CLI points both at its own copy, which the engine half counts. A linked copy in the
    // project's node_modules never runs, so editing it must leave the key alone.
    const p = makeProject();
    const fakeIndex = linkPackage(p.root, "engine-checkout", { name: ENGINE_PKG }, "export const v = 1;\n");
    expect(CLI_ALIASED_PACKAGES.has(ENGINE_PKG)).toBe(true);

    const before = await inputsFor(p.root, ENGINE);
    expect(before.entries.filter((e) => e.kind === "generator-package" && e.name.startsWith(`${ENGINE_PKG}/`))).toEqual([]);
    writeFileSync(fakeIndex, "export const v = 2;\n");
    expect(keyFor(await inputsFor(p.root, ENGINE), [])).toBe(keyFor(before, []));
  });
});
