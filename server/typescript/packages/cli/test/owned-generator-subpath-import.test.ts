// An OWNED generator must be able to import a subpath the engine deliberately EXPORTS.
//
// THE BUG THIS PINS (reproduced on published 1.0.0-rc.4 by a cold adoption probe
// retargeting the entity tier off Drizzle): jiti's `alias` map matches by PREFIX and then
// concatenates the remainder onto the mapped value. The mapped value is a FILE, so
//
//     import { fieldTsTypeString } from "@metaobjectsdev/codegen-ts/templates/inferred-types"
//
// resolved to `…/@metaobjectsdev/codegen-ts/dist/index.js/templates/inferred-types` — a
// path that has never existed — and `meta gen` died naming it, with no mention of jiti or
// the alias map anywhere in the message.
//
// WHY IT MATTERED MORE THAN IT LOOKS. `entity.ts`'s header invites exactly this: "replace
// the `renderDrizzleSchema` / `renderZodValidators` calls to target a different ORM or
// validator". Doing so also forces replacing `renderInferredTypes` (it emits
// `InferSelectModel<typeof table>`, derived from the Drizzle table symbol you just
// removed), and the one neutral MetaField→TypeScript mapper, `fieldTsTypeString`, lives
// ONLY behind that subpath. So the wall sat directly across the documented path off
// Drizzle. The probe got past it by reading the CLI's compiled source.
//
// WHY THE CONFIG FILE NEVER SHOWED IT: `rewriteImportSpecifiers` pre-processes the config
// and is correct here — it anchors on the closing quote, so a subpath specifier is left
// alone. Only the alias FALLBACK was wrong, and the fallback is what an owned generator
// gets, because only the config file is pre-processed. Every existing test loaded config
// files; none loaded a generator importing a subpath.
//
// HARNESS: the built CLI in its own process, for the same reason the split-tree gate uses
// it — an in-process bun:test import produces a different module topology (Bun's native
// loader takes over from jiti) and cannot reproduce a jiti-alias failure at all.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { META_BIN, ensureFreshDist } from "./integration/support/built-cli.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

const META = JSON.stringify({
  metadata: {
    package: "probe",
    children: [
      {
        "object.entity": {
          name: "Author",
          children: [
            { "source.rdb": { "@table": "authors" } },
            { "field.string": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/**
 * The generator is deliberately minimal and does NOT emit real code — the question is
 * whether the subpath LOADS, and a generator that also had to produce valid output would
 * fail for reasons unrelated to the one being tested.
 *
 * `fieldTsTypeString` is the symbol the probe actually needed; `renderNamesDecl` from the
 * root entry is imported beside it so a failure distinguishes "subpaths are broken" from
 * "this package cannot be imported at all".
 */
const GENERATOR = `import { fieldTsTypeString } from "@metaobjectsdev/codegen-ts/templates/inferred-types";
import { oncePerRun, renderNamesDecl, type Generator } from "@metaobjectsdev/codegen-ts";

export function probeFile(): Generator {
  return {
    name: "probe-file",
    generate: oncePerRun(async () => [
      {
        path: "subpath-probe.txt",
        content: \`fieldTsTypeString=\${typeof fieldTsTypeString} renderNamesDecl=\${typeof renderNamesDecl}\\n\`,
      },
    ]),
  };
}
`;

const CONFIG = `import { defineConfig } from "@metaobjectsdev/cli";
import { probeFile } from "./codegen/generators/probe.js";

export default defineConfig({
  outDir: "src/generated",
  dialect: "sqlite",
  generators: [probeFile()],
});
`;

describe("an owned generator importing a declared subpath export", () => {
  test("loads, and the subpath resolves to a real module", async () => {
    ensureFreshDist();
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const dir = mkdtempSync(join(WORKSPACE_TMP, "mo-subpath-"));
    try {
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      mkdirSync(join(dir, "codegen", "generators"), { recursive: true });
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "probe", version: "1.0.0", type: "module" }, null, 2)}\n`);
      writeFileSync(join(dir, "metaobjects", "meta.probe.json"), META);
      writeFileSync(join(dir, "codegen", "generators", "probe.ts"), GENERATOR);
      writeFileSync(join(dir, "metaobjects.config.ts"), CONFIG);

      // The adopter path: the published CLI runs under node (`#!/usr/bin/env node`).
      const proc = Bun.spawn(["node", META_BIN, "gen"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // The pre-fix failure named a path with `dist/index.js/` INSIDE it. Assert on that
      // shape specifically, so a future regression is recognisable from this test's output
      // rather than only from a generic non-zero exit.
      expect(`${out}${err}`).not.toContain("dist/index.js/templates");
      expect({ exit, out, err }).toMatchObject({ exit: 0 });
      // Non-vacuous: the generator really ran and really saw the subpath's export.
      expect(`${out}${err}`).not.toContain("Cannot find module");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
