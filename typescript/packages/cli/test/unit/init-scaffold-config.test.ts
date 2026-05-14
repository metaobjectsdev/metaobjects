import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "forge-init-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("forge init scaffolds metaforge.config.ts", () => {
  test("writes a default metaforge.config.ts at project root", async () => {
    const result = await init({ cwd: tmp, quiet: true });
    expect(existsSync(join(tmp, "metaforge.config.ts"))).toBe(true);
    const body = readFileSync(join(tmp, "metaforge.config.ts"), "utf-8");
    expect(body).toContain(`import { defineConfig } from "@metaforge/cli"`);
    expect(body).toContain(`entityFile()`);
    expect(body).toContain(`queriesFile()`);
    expect(body).toContain(`routesFile()`);
    expect(body).toContain(`barrel()`);
    expect(result.created).toContain("metaforge.config.ts");
  });

  test("does not overwrite an existing metaforge.config.ts on subsequent runs", async () => {
    await init({ cwd: tmp, quiet: true });
    const before = readFileSync(join(tmp, "metaforge.config.ts"), "utf-8");
    writeFileSync(join(tmp, "metaforge.config.ts"), before + "\n// HAND-EDIT-SENTINEL\n");
    // force: true required — metaobjects/ already exists from the first call
    await init({ cwd: tmp, quiet: true, force: true });
    const after = readFileSync(join(tmp, "metaforge.config.ts"), "utf-8");
    expect(after).toContain("HAND-EDIT-SENTINEL");
  });

  test("--refresh-docs does not touch metaforge.config.ts", async () => {
    await init({ cwd: tmp, quiet: true });
    const before = readFileSync(join(tmp, "metaforge.config.ts"), "utf-8");
    await init({ cwd: tmp, quiet: true, refreshDocs: true });
    const after = readFileSync(join(tmp, "metaforge.config.ts"), "utf-8");
    expect(after).toBe(before);
  });

  test("does NOT create legacy forge.config.ts", async () => {
    await init({ cwd: tmp, quiet: true });
    expect(existsSync(join(tmp, "forge.config.ts"))).toBe(false);
  });
});
