// ADR-0034's removal has TWO doors, and only one of them was covered.
//
// `removedGeneratorImportError` reads the config SOURCE, so it fires when the config itself
// imports `entityFile` / `barrel` / … from "@metaobjectsdev/codegen-ts/generators". A
// polyglot adopter estate showed the other door: its config imported an OWNED generator —
// `./codegen/generators/entityFileTyped`, the exact shape `meta eject` writes — and THAT
// file carried the stale import. The source scan saw a clean config, and what the adopter
// got was `(0 , _generators.entityFile) is not a function`, exit 2, naming no file, no
// symbol origin and no remedy: the precise failure the first door exists to prevent.

import { describe, test, expect } from "bun:test";
import {
  removedGeneratorImportError,
  removedGeneratorRuntimeError,
} from "../../src/lib/load-metaobjects-config.js";

describe("removedGeneratorRuntimeError", () => {
  test("recognises Bun's transpiled shape", () => {
    const msg = removedGeneratorRuntimeError(
      new TypeError("(0 , _generators.entityFile) is not a function"),
    );
    expect(msg).toBeDefined();
    expect(msg).toContain("meta eject entity");
    expect(msg).toContain("ADR-0034");
    expect(msg).toContain("0.x-to-1.0.md");
  });

  test("recognises Node's plain shape", () => {
    // Matching is on the SYMBOL, not the message shape — the shape belongs to whichever
    // transpiler ran, and an adopter's runtime is not ours to choose.
    const msg = removedGeneratorRuntimeError(new TypeError("barrel is not a function"));
    expect(msg).toContain("meta eject barrel");
  });

  test("says WHERE to look, since the throw cannot name the file", () => {
    const msg = removedGeneratorRuntimeError(new TypeError("entityFile is not a function"))!;
    expect(msg).toContain("codegen/generators/");
    expect(msg).toMatch(/module (the|your) config imports/);
  });

  test("stays out of the way of unrelated TypeErrors", () => {
    expect(removedGeneratorRuntimeError(new TypeError("foo is not a function"))).toBeUndefined();
    expect(removedGeneratorRuntimeError(new Error("entityFile exploded"))).toBeUndefined();
    expect(removedGeneratorRuntimeError(undefined)).toBeUndefined();
  });

  test("a non-Error throw does not crash the diagnostic", () => {
    expect(removedGeneratorRuntimeError("entityFile is not a function")).toContain("meta eject entity");
  });
});

describe("the two doors agree", () => {
  test("both name the removal, the remedy and the guide", () => {
    const fromSource = removedGeneratorImportError(
      `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`,
    )!;
    const fromThrow = removedGeneratorRuntimeError(new TypeError("entityFile is not a function"))!;
    for (const needle of ["ADR-0034", "meta eject entity", "0.x-to-1.0.md §11"]) {
      expect(fromSource).toContain(needle);
      expect(fromThrow).toContain(needle);
    }
  });
});
