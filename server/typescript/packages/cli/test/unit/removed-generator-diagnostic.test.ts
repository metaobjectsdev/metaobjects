// A removed generator factory reaches a project as a failed import, and the config load turns
// that failure into a diagnostic.
//
// `removedGeneratorRuntimeError` recovers the answer from the THROW, so it covers a live
// import wherever it is: in `metaobjects.config.ts` itself, or in a module the config imports
// (an owned generator under `codegen/generators/` is the usual one).
//
// Without it the removal reaches an adopter as whatever the runtime says about a missing
// export, which names neither MetaObjects, nor the removal, nor what to do.
//
// The one removed factory today is `mermaidErDiagram` (1.1): `meta docs` draws the diagram.

import { describe, test, expect } from "bun:test";
import { removedGeneratorRuntimeError } from "../../src/lib/load-metaobjects-config.js";

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

  test("names the remedy and both places the import can be, since the throw cannot name the file", () => {
    const msg = removedGeneratorRuntimeError(new TypeError("mermaidErDiagram is not a function"));
    expect(msg).toContain("in your metaobjects.config.ts or in a module the config imports");
    expect(msg).toContain("codegen/generators/");
    expect(msg).toContain("delete the import and the `mermaidErDiagram()` entry");
    expect(msg).toContain("run `meta docs`");
    // The file it used to write is the other thing an upgrade leaves behind.
    expect(msg).toContain("docs/model.md");
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
