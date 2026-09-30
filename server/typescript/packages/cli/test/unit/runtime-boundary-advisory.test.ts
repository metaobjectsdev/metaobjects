// An ejected entity/routes generator imports the owned adapter copy in codegen/runtime/
// by a relative path. In a monorepo whose output sits in a workspace package that path
// leaves the package and the package's build rejects it (found upgrading a pnpm monorepo:
// `TS6059 … is not under 'rootDir'`). meta gen warns, naming the package.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRuntimeBoundaryCrossings, runtimeBoundaryWarnings } from "../../src/lib/runtime-boundary-advisory.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project(): string {
  const d = mkdtempSync(join(tmpdir(), "mo-rt-boundary-"));
  dirs.push(d);
  writeFileSync(join(d, "package.json"), "{}");
  mkdirSync(join(d, "codegen/runtime/drizzle-fastify"), { recursive: true });
  writeFileSync(join(d, "codegen/runtime/drizzle-fastify/index.ts"), "export {};\n");
  return d;
}

function gen(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe("runtime boundary advisory", () => {
  test("a file in a workspace package importing ../codegen/runtime is named", () => {
    const root = project();
    mkdirSync(join(root, "apps/api"), { recursive: true });
    writeFileSync(join(root, "apps/api/package.json"), "{}");
    const f = gen(root, "apps/api/src/generated/User.routes.ts",
      `import { mountCrudRoutes } from "../../../../codegen/runtime/drizzle-fastify/index";\n`);
    const found = findRuntimeBoundaryCrossings(root, [f]);
    expect(found).toEqual([{ packageDir: "apps/api", example: "apps/api/src/generated/User.routes.ts" }]);
    const [w] = runtimeBoundaryWarnings(found);
    expect(w).toContain(`runtimeImport: "@metaobjectsdev/runtime-ts"`);
    expect(w).toContain("apps/api/");
  });

  test("a single-package project is not flagged", () => {
    const root = project();
    const f = gen(root, "src/generated/User.routes.ts",
      `import { mountCrudRoutes } from "../../codegen/runtime/drizzle-fastify/index";\n`);
    expect(findRuntimeBoundaryCrossings(root, [f])).toEqual([]);
  });

  test("output that imports the published package is not flagged", () => {
    const root = project();
    mkdirSync(join(root, "apps/api"), { recursive: true });
    writeFileSync(join(root, "apps/api/package.json"), "{}");
    const f = gen(root, "apps/api/src/generated/User.routes.ts",
      `import { mountCrudRoutes } from "@metaobjectsdev/runtime-ts/drizzle-fastify";\n`);
    expect(findRuntimeBoundaryCrossings(root, [f])).toEqual([]);
  });

  test("a runtime copy moved inside the package is not flagged", () => {
    const root = project();
    mkdirSync(join(root, "apps/api/codegen/runtime/drizzle-fastify"), { recursive: true });
    writeFileSync(join(root, "apps/api/package.json"), "{}");
    const f = gen(root, "apps/api/src/generated/User.routes.ts",
      `import { mountCrudRoutes } from "../../codegen/runtime/drizzle-fastify/index";\n`);
    expect(findRuntimeBoundaryCrossings(root, [f])).toEqual([]);
  });
});
