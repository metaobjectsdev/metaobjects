// A removed generator factory has TWO doors into a project, and both get a diagnostic.
//
// `removedGeneratorImportError` reads the config SOURCE, so it fires when the config itself
// imports the removed factory from "@metaobjectsdev/codegen-ts/generators" and can name the
// file and the import. `removedGeneratorRuntimeError` recovers the same answer from the
// THROW, for a removed export imported by a module the config imports — an owned generator
// under `codegen/generators/` is the usual one — where the source scan sees a clean config.
//
// Without them the removal reaches an adopter as whatever the runtime says about a missing
// export, which names neither MetaObjects, nor the removal, nor what to do.
//
// The one removed factory today is `mermaidErDiagram` (1.1): `meta docs` draws the diagram.

import { describe, test, expect } from "bun:test";
import {
  removedGeneratorImportError,
  removedGeneratorRuntimeError,
} from "../../src/lib/load-metaobjects-config.js";

describe("removedGeneratorImportError", () => {
  test("names the import, the removal and what replaced it", () => {
    const msg = removedGeneratorImportError(
      `import { entityFile, mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";`,
    );
    expect(msg).toContain('imports mermaidErDiagram from "@metaobjectsdev/codegen-ts/generators"');
    expect(msg).toContain("1.1 removed that generator");
    expect(msg).toContain("`meta docs` draws the ER diagram");
    expect(msg).toContain("delete the import and the `mermaidErDiagram()` entry");
    // The file it used to write is the other thing an upgrade leaves behind.
    expect(msg).toContain("docs/model.md");
  });

  test("sees through an alias, a type import, single quotes and a multi-line list", () => {
    for (const source of [
      `import { mermaidErDiagram as er } from "@metaobjectsdev/codegen-ts/generators";`,
      `import { mermaidErDiagram } from '@metaobjectsdev/codegen-ts/generators';`,
      `import {\n  entityFile,\n  mermaidErDiagram,\n} from "@metaobjectsdev/codegen-ts/generators";`,
    ]) {
      expect(removedGeneratorImportError(source)).toContain("mermaidErDiagram");
    }
  });

  test("stays out of the way of every import that still resolves", () => {
    for (const source of [
      `import { entityFile, routesFile, docsFile } from "@metaobjectsdev/codegen-ts/generators";`,
      // The same symbol from somewhere else is the project's own, not the removed one.
      `import { mermaidErDiagram } from "./codegen/generators/my-diagram.js";`,
      // The diagram builder `meta docs` uses is public and stays.
      `import { renderMermaidErBlock } from "@metaobjectsdev/codegen-ts";`,
      "",
    ]) {
      expect(removedGeneratorImportError(source)).toBeUndefined();
    }
  });
});

describe("removedGeneratorRuntimeError", () => {
  test("recognises a transpiled config's shape", () => {
    const msg = removedGeneratorRuntimeError(
      new TypeError("(0 , _generators.mermaidErDiagram) is not a function"),
    );
    expect(msg).toContain('mermaidErDiagram is no longer exported from "@metaobjectsdev/codegen-ts/generators"');
    expect(msg).toContain("`meta docs` draws the ER diagram");
  });

  test("recognises native ESM's two spellings of a missing export", () => {
    // Matching is on the SYMBOL and the fact of a missing export, not on one message
    // shape: the shape belongs to whichever runtime loaded the module.
    for (const message of [
      "The requested module '@metaobjectsdev/codegen-ts/generators' does not provide an export named 'mermaidErDiagram'",
      "Export named 'mermaidErDiagram' not found in module '/x/codegen-ts/dist/generators/index.js'.",
      "mermaidErDiagram is not a function",
    ]) {
      expect(removedGeneratorRuntimeError(new SyntaxError(message))).toContain("1.1 removed that generator");
    }
  });

  test("says WHERE to look, since the throw cannot name the file", () => {
    const msg = removedGeneratorRuntimeError(new TypeError("mermaidErDiagram is not a function"));
    expect(msg).toContain("codegen/generators/");
    expect(msg).toContain("a module the config imports");
  });

  test("stays out of the way of unrelated errors", () => {
    expect(removedGeneratorRuntimeError(new TypeError("foo is not a function"))).toBeUndefined();
    expect(removedGeneratorRuntimeError(new Error("mermaidErDiagram exploded"))).toBeUndefined();
    expect(removedGeneratorRuntimeError(undefined)).toBeUndefined();
  });

  test("a non-Error throw does not crash the diagnostic", () => {
    expect(removedGeneratorRuntimeError("mermaidErDiagram is not a function")).toContain("`meta docs`");
  });
});

describe("the two doors agree", () => {
  test("both name the removal and the replacement", () => {
    const fromSource = removedGeneratorImportError(
      `import { mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";`,
    );
    const fromThrow = removedGeneratorRuntimeError(new TypeError("mermaidErDiagram is not a function"));
    for (const needle of ["1.1 removed that generator", "`meta docs` draws the ER diagram", "run `meta docs`"]) {
      expect(fromSource).toContain(needle);
      expect(fromThrow).toContain(needle);
    }
  });
});
