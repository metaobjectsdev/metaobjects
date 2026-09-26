// ADR-0034 Amendment 3 (2026-09-24) — ejecting a helper hands over ALL of its code: the
// generator, and the adapter source its output imports. Unit-level: what is copied, from
// where, and how a copy is reported against the package it came from. The end-to-end proof
// (eject → gen → tsc → boot on SQLite) is `integration/eject-owned-runtime.test.ts`.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ejectRuntime, runtimeClosure, resolveRuntimePackage, runtimeCopyStatus, runtimeInstall,
} from "../src/lib/runtime-eject.js";
import { ejectGenerator } from "../src/commands/eject.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mo-eject-runtime-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("the adapter closure", () => {
  const { srcRoot } = resolveRuntimePackage();

  test("the Fastify adapter reaches the filter parser, error envelopes and pagination — and no core module", () => {
    const { files, packages } = runtimeClosure(srcRoot, ["drizzle-fastify"]);
    for (const f of [
      "drizzle-fastify/index.ts",
      "drizzle-fastify/filter-parser.ts",
      "drizzle-fastify/list-params.ts",
      "drizzle-fastify/mount-m2m.ts",
      "drizzle-fastify/mount-read-only.ts",
      "drizzle-fastify/route-error-handler.ts",
      "route-errors.ts",
      "constraint-errors.ts",
    ]) expect(files).toContain(f);
    // The metadata-driven runtime (ObjectManager and friends) is CORE and is not copied.
    expect(files).not.toContain("object-manager.ts");
    expect(files.some((f) => f.startsWith("hono/"))).toBe(false);
    expect(packages).toContain("@metaobjectsdev/metadata");
    expect(packages).not.toContain("@metaobjectsdev/runtime-ts");
    expect(packages).toEqual(expect.arrayContaining(["drizzle-orm", "fastify", "qs"]));
  });

  test("the Hono adapter does not drag in Fastify", () => {
    const { files, packages } = runtimeClosure(srcRoot, ["hono"]);
    expect(files).toContain("hono/index.ts");
    expect(files).not.toContain("drizzle-fastify/index.ts");
    expect(packages).not.toContain("fastify");
    expect(packages).toContain("hono");
  });

  test("the entity module's allowlist types are one file with no framework import", () => {
    const { files, packages } = runtimeClosure(srcRoot, ["allowlists"]);
    expect(files).toEqual(["drizzle-fastify/filter-allowlist.ts"]);
    expect(packages).toEqual(["@metaobjectsdev/metadata"]);
  });

  test("the install set pins third-party ranges from the runtime package and adds @types/qs", () => {
    const { runtime, dev } = runtimeInstall(["qs", "fastify", "@metaobjectsdev/metadata"]);
    expect(runtime.get("qs")).toBeDefined();
    expect(runtime.get("fastify")).toBeDefined();
    expect(runtime.get("@metaobjectsdev/metadata")).toMatch(/^\^/);
    expect(dev.has("@types/qs")).toBe(true);
  });
});

describe("meta eject copies the adapter beside the generator", () => {
  test("copies verbatim, never clobbers without --force, and reports each copy against the package", async () => {
    const first = await ejectRuntime(cwd, ["routes"], false);
    expect(first.files.every((f) => f.status === "created")).toBe(true);
    const { srcRoot } = resolveRuntimePackage();
    const index = join(cwd, "codegen/runtime/drizzle-fastify/index.ts");
    expect(await readFile(index, "utf8")).toBe(readFileSync(join(srcRoot, "drizzle-fastify/index.ts"), "utf8"));

    let status = await runtimeCopyStatus(cwd);
    expect(status.length).toBe(first.files.length);
    expect(status.every((r) => r.verdict === "identical")).toBe(true);

    // The adopter fixes something in their copy.
    await writeFile(index, `${await readFile(index, "utf8")}\nexport const LOCAL_FIX = 1;\n`, "utf8");
    // A file of their own beside it.
    await mkdir(join(cwd, "codegen/runtime/auth"), { recursive: true });
    await writeFile(join(cwd, "codegen/runtime/auth/guard.ts"), "export const g = 1;\n", "utf8");

    const again = await ejectRuntime(cwd, ["routes"], false);
    const indexRow = again.files.find((f) => f.path === "codegen/runtime/drizzle-fastify/index.ts");
    expect(indexRow?.status).toBe("preserved");
    expect(indexRow?.comparison?.verdict).toBe("differs");
    expect(await readFile(index, "utf8")).toContain("LOCAL_FIX");

    status = await runtimeCopyStatus(cwd);
    expect(status.find((r) => r.path.endsWith("drizzle-fastify/index.ts"))).toMatchObject({ verdict: "differs", localOnly: 1 });
    expect(status.find((r) => r.path.endsWith("auth/guard.ts"))?.verdict).toBe("not-in-package");

    const forced = await ejectRuntime(cwd, ["routes"], true);
    expect(forced.files.find((f) => f.path.endsWith("drizzle-fastify/index.ts"))?.status).toBe("replaced");
    expect(await readFile(index, "utf8")).not.toContain("LOCAL_FIX");
  });

  test("ejecting a generator whose output imports no adapter copies nothing", async () => {
    const r = await ejectRuntime(cwd, ["queries", "barrel", "form"], false);
    expect(r.files).toEqual([]);
    expect(existsSync(join(cwd, "codegen/runtime"))).toBe(false);
  });

  test("ejectGenerator reports the runtime files it copied", async () => {
    const r = await ejectGenerator({ cwd, name: "routes-hono" });
    expect(r.runtime?.files.some((f) => f.path === "codegen/runtime/hono/index.ts")).toBe(true);
    expect(existsSync(join(cwd, "codegen/runtime/hono/index.ts"))).toBe(true);
  });
});
