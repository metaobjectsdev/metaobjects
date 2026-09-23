// A missing DB driver says WHERE to install it, not only what (adopter estate finding F5).
//
// `import("pg")` resolves from the CLI's own install location. In a monorepo that is the
// package that depends on `@metaobjectsdev/cli`, which need not be the one that runs the
// app — so "install it: npm install pg" run in the wrong package changes nothing.
import { describe, test, expect } from "bun:test";
import { cliInstallRoot, missingDriverMessage } from "../src/lib/kysely.js";

describe("missing driver hint", () => {
  test("the install root is the project that holds @metaobjectsdev/cli", () => {
    expect(cliInstallRoot("file:///work/app/node_modules/@metaobjectsdev/cli/dist/src/lib/kysely.js"))
      .toBe("/work/app");
    // A pnpm store path still ends in node_modules/@metaobjectsdev/… — the LAST one wins.
    expect(cliInstallRoot(
      "file:///work/app/node_modules/.pnpm/x/node_modules/@metaobjectsdev/cli/dist/src/lib/kysely.js",
    )).toBe("/work/app/node_modules/.pnpm/x");
    // Run from a source checkout: no node_modules segment, so no root to name.
    expect(cliInstallRoot("file:///repo/server/typescript/packages/cli/src/lib/kysely.ts")).toBeUndefined();
  });

  test("the message names the package, the directory and the command", () => {
    const msg = missingDriverMessage("postgres", "pg", "/work/app", "npm install pg");
    expect(msg).toContain("'pg'");
    expect(msg).toContain("/work/app");
    expect(msg).toContain("@metaobjectsdev/cli");
    expect(msg).toContain("npm install pg");
  });
});
