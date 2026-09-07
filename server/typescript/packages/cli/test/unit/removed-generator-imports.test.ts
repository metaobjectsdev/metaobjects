// 1.0 removed entityFile / queriesFile / routesFile / barrel from
// `@metaobjectsdev/codegen-ts/generators`. Without a diagnostic the removal reaches an
// adopter as `(0, _index2.entityFile) is not a function` from the transpiled config —
// naming neither MetaObjects, nor the removal, nor the remedy. Observed on a real adopter
// estate before this check existed.
//
// BOTH arms matter. That subpath is the supported home of every generator with no ownable
// copy (promptRender, outputParser, routesFileHono, …); a check that fires on the PATH
// rather than the four NAMES would refuse to load five of the six estates surveyed at the
// cut, every one of them correct.
import { describe, test, expect } from "bun:test";
import { removedGeneratorImportError } from "../../src/lib/load-metaobjects-config.js";

const SUB = "@metaobjectsdev/codegen-ts/generators";

describe("removed generator imports", () => {
  test("names every removed import, and one eject command per name", () => {
    const msg = removedGeneratorImportError(
      `import { entityFile, queriesFile, routesFile, barrel } from "${SUB}";`,
    );
    expect(msg).toBeDefined();
    for (const n of ["entityFile", "queriesFile", "routesFile", "barrel"]) {
      expect(msg).toContain(n);
    }
    // `meta eject` takes at most ONE name, so a single four-name command would not run.
    for (const t of ["meta eject entity", "meta eject queries", "meta eject routes", "meta eject barrel"]) {
      expect(msg).toContain(t);
    }
    expect(msg).toContain("0.x-to-1.0.md");
  });

  test("stays silent on the non-ownable generators that legitimately live there", () => {
    expect(removedGeneratorImportError(
      `import { promptRender, outputParser, renderHelper } from "${SUB}";`,
    )).toBeUndefined();
    expect(removedGeneratorImportError(
      `import { routesFileHono, namesFile, callableFile } from "${SUB}";`,
    )).toBeUndefined();
  });

  test("does not fire on a same-named import from somewhere else", () => {
    // An owned copy is exactly this, and it must load.
    expect(removedGeneratorImportError(
      `import { entityFile } from "./codegen/generators/entity";`,
    )).toBeUndefined();
  });

  test("catches a mixed import — the removed half is still removed", () => {
    const msg = removedGeneratorImportError(
      `import { promptRender, entityFile } from "${SUB}";`,
    );
    expect(msg).toBeDefined();
    expect(msg).toContain("entityFile");
    expect(msg).toContain("meta eject entity");
  });

  test("catches renamed and type-only forms", () => {
    expect(removedGeneratorImportError(
      `import { entityFile as ef } from "${SUB}";`,
    )).toBeDefined();
    expect(removedGeneratorImportError(
      `import type { EntityFileOpts } from "${SUB}";`,
    )).toBeUndefined(); // a type-only opts import is not a call site; it fails at typecheck
  });
});
