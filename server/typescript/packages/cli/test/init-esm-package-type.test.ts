// `meta init` must leave a project whose FIRST `tsc` succeeds.
//
// It did not. `npm init -y` now writes `"type": "commonjs"` explicitly, and a stock
// `tsc --init` on TypeScript 7 enables `verbatimModuleSyntax` — so the documented
// first-touch path (npm init -y → npm i @metaobjectsdev/cli → meta init → meta gen →
// npx tsc) produced ~94 errors:
//
//     codegen/generators/barrel.ts(14,3): error TS1295: ECMAScript imports and
//     exports cannot be written in a CommonJS file under 'verbatimModuleSyntax'.
//
// across every scaffolded generator and every generated file. Reproduced against
// published 0.21.4.
//
// Why the existing gate could not see it: `codegen-ts/test/nodenext-safe-imports.test.ts`
// builds a programmatic ts.createProgram with NO verbatimModuleSyntax and NO
// package.json context, then filters diagnostics to TS2835 alone — so it is blind to
// every first-touch compile failure except the one it was written for.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "init-esm-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const readPkg = () => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;

describe("meta init — ESM package type", () => {
  test('sets "type": "module" on the `npm init -y` shape (explicit commonjs)', async () => {
    // This is the exact manifest `npm init -y` writes today — the reported path.
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0", type: "commonjs", main: "index.js",
    }, null, 2) + "\n");

    const result = await init({ cwd: dir, quiet: true });

    expect(readPkg().type).toBe("module");
    const warned = result.warnings.join("\n");
    expect(warned).toContain('"type": "module"');
    // The message must REPORT the edit, not instruct the user to make it. It is the
    // last line `meta init` prints, so an imperative there reads as an unmet TODO —
    // a scaffold that had just done the right thing looked like it had failed. The
    // substring assertion above cannot tell the two phrasings apart, which is how
    // the imperative survived; this pins the tense.
    expect(warned).toContain("for you");
    expect(warned).not.toMatch(/^meta: set `"type"/m);
  });

  test("sets it when the manifest has no type field at all", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }, null, 2) + "\n");
    await init({ cwd: dir, quiet: true });
    expect(readPkg().type).toBe("module");
  });

  test("leaves an already-ESM project alone, and says nothing about it", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", type: "module" }, null, 2) + "\n");
    const result = await init({ cwd: dir, quiet: true });
    expect(readPkg().type).toBe("module");
    // No warning: there is nothing for the user to act on.
    expect(result.warnings.join("\n")).not.toContain('"type": "module"');
  });

  test("REFUSES to convert a project that has real CommonJS sources — warns instead", async () => {
    // Changing a module system out from under working code is not ours to do. The
    // adopter gets a specific instruction rather than a broken app.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", type: "commonjs" }, null, 2) + "\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "server.js"), "const express = require('express');\nmodule.exports = express;\n");

    const result = await init({ cwd: dir, quiet: true });

    expect(readPkg().type).toBe("commonjs");
    const warned = result.warnings.join("\n");
    expect(warned).toContain("CommonJS sources");
    expect(warned).toContain("sub-directory");   // the escape hatch is named
  });

  test("warns rather than inventing a manifest when there is no package.json", async () => {
    const result = await init({ cwd: dir, quiet: true });
    expect(result.warnings.join("\n")).toContain("no package.json found");
  });

  test("preserves the manifest's existing indentation", async () => {
    // Reformatting someone's package.json is a gratuitous diff in their repo.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }, null, 4) + "\n");
    await init({ cwd: dir, quiet: true });
    const raw = readFileSync(join(dir, "package.json"), "utf8");
    expect(raw).toContain('\n    "name"');
  });
});

describe("meta init — the scaffold's own dependencies", () => {
  test("declares what codegen/generators/ imports, so the scaffold typechecks", async () => {
    // ADR-0034 puts real source in the adopter's repo; installing only the CLI left
    // those files with unresolvable imports (10x TS2307 on files init had just written).
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", type: "commonjs" }, null, 2) + "\n");
    const result = await init({ cwd: dir, quiet: true });
    const dev = readPkg().devDependencies as Record<string, string>;
    // ts-poet is deliberately absent: the scaffolded templates import its combinators
    // via @metaobjectsdev/codegen-ts so generated-code composition shares ONE ts-poet
    // instance with the engine (see the gen-split-tree gate), and a project-local
    // ts-poet is the second physical copy that used to split it.
    expect(Object.keys(dev).sort()).toEqual(
      ["@metaobjectsdev/codegen-ts", "@metaobjectsdev/metadata"],
    );
    expect(result.warnings.join("\n")).toContain("Run your package manager's install");
  });

  test("never overwrites a pin the project already chose", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "x", type: "commonjs",
      devDependencies: { "ts-poet": "6.0.0" },
      dependencies: { "@metaobjectsdev/codegen-ts": "0.1.0" },
    }, null, 2) + "\n");
    await init({ cwd: dir, quiet: true });
    const pkg = readPkg();
    expect((pkg.devDependencies as Record<string, string>)["ts-poet"]).toBe("6.0.0");
    expect((pkg.dependencies as Record<string, string>)["@metaobjectsdev/codegen-ts"]).toBe("0.1.0");
    // …and still adds only the genuinely-missing one.
    expect((pkg.devDependencies as Record<string, string>)["@metaobjectsdev/metadata"]).toBeDefined();
  });
});
