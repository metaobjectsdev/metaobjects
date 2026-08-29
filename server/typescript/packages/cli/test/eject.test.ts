// FR-040 §4.2(a) — eject copies a reference template into the consumer's repo so they
// own it, for any generator in any package, at any time after init.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectGenerator } from "../src/commands/eject.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mo-eject-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("meta eject", () => {
  test("writes a UI-tier template and reports the local import line", async () => {
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("created");
    const src = await readFile(join(cwd, "codegen/generators/form.ts"), "utf8");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(r.importLine).toContain('from "./codegen/generators/form.js"');
  });

  test("ejects a server-tier template from codegen-ts too", async () => {
    const r = await ejectGenerator({ cwd, name: "routes-hono" });
    expect(r.status).toBe("created");
    expect(await readFile(join(cwd, "codegen/generators/routes-hono.ts"), "utf8"))
      .toContain("// targets:");
  });

  test("never clobbers a hand-edited generator", async () => {
    await mkdir(join(cwd, "codegen/generators"), { recursive: true });
    await writeFile(join(cwd, "codegen/generators/form.ts"), "// MINE\n", "utf8");
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("preserved");
    expect(await readFile(join(cwd, "codegen/generators/form.ts"), "utf8")).toBe("// MINE\n");
  });

  test("an unknown name errors and lists what IS ejectable", async () => {
    await expect(ejectGenerator({ cwd, name: "nope" })).rejects.toThrow(/form|hooks|entity/);
  });
});
