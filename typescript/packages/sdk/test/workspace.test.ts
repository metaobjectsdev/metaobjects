import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkspace,
  resolveExtendsOrder,
  extractPnpmPackages,
} from "../src/workspace.js";

function makeManifest(name: string, opts: { extends?: string[]; metaobjectsPackage?: string } = {}): string {
  return JSON.stringify({
    name,
    version: "1.0.0",
    ...(opts.metaobjectsPackage !== undefined ? { metaobjectsPackage: opts.metaobjectsPackage } : {}),
    extends: opts.extends ?? [],
  });
}

function scaffoldPackage(root: string, relPath: string, manifestContent: string): string {
  const pkgDir = join(root, relPath);
  const metaDir = join(pkgDir, ".meta");
  mkdirSync(join(metaDir, "memory"), { recursive: true });
  writeFileSync(join(metaDir, "package.meta.json"), manifestContent);
  return pkgDir;
}

describe("extractPnpmPackages", () => {
  test("parses simple list", () => {
    const yaml = "packages:\n  - 'packages/*'\n  - 'apps/*'\n";
    expect(extractPnpmPackages(yaml)).toEqual(["packages/*", "apps/*"]);
  });

  test("parses unquoted patterns", () => {
    const yaml = "packages:\n  - packages/*\n  - apps/*\n";
    expect(extractPnpmPackages(yaml)).toEqual(["packages/*", "apps/*"]);
  });

  test("ignores comments and other top-level keys", () => {
    const yaml = `# config
packages:
  - 'packages/*'

onlyBuiltDependencies: esbuild
`;
    expect(extractPnpmPackages(yaml)).toEqual(["packages/*"]);
  });

  test("returns empty for missing packages key", () => {
    expect(extractPnpmPackages("foo: bar\n")).toEqual([]);
  });
});

describe("discoverWorkspace — pnpm-workspace.yaml", () => {
  test("finds packages via pnpm-workspace.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-pnpm-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      scaffoldPackage(root, "packages/shared", makeManifest("@acme/shared", { metaobjectsPackage: "acme::shared" }));
      scaffoldPackage(root, "packages/billing", makeManifest("@acme/billing", {
        metaobjectsPackage: "acme::billing",
        extends: ["@acme/shared"],
      }));

      const ws = await discoverWorkspace(join(root, "packages/billing"));
      expect(ws).toBeDefined();
      expect(ws!.root).toBe(root);
      expect(ws!.packages.length).toBe(2);
      expect(ws!.findByName("@acme/shared")).toBeDefined();
      expect(ws!.findByMetaobjectsPackage("acme::billing")).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walks up from a deep subdirectory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-walkup-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      scaffoldPackage(root, "packages/web", makeManifest("@acme/web", { metaobjectsPackage: "acme::web" }));
      const deep = join(root, "packages/web/src/feature");
      mkdirSync(deep, { recursive: true });

      const ws = await discoverWorkspace(deep);
      expect(ws).toBeDefined();
      expect(ws!.packages[0]!.manifest.name).toBe("@acme/web");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("discoverWorkspace — package.json workspaces", () => {
  test("finds packages via array form", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-pkgjson-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }),
      );
      scaffoldPackage(root, "apps/web", makeManifest("@acme/web", { metaobjectsPackage: "acme::web" }));
      scaffoldPackage(root, "apps/api", makeManifest("@acme/api", { metaobjectsPackage: "acme::api" }));

      const ws = await discoverWorkspace(join(root, "apps/web"));
      expect(ws).toBeDefined();
      expect(ws!.packages.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds packages via object form (workspaces.packages)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-pkgjson-obj-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "mono", workspaces: { packages: ["packages/*"] } }),
      );
      scaffoldPackage(root, "packages/x", makeManifest("@acme/x", { metaobjectsPackage: "acme::x" }));

      const ws = await discoverWorkspace(join(root, "packages/x"));
      expect(ws).toBeDefined();
      expect(ws!.packages.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("discoverWorkspace — root-level .meta", () => {
  test("includes root-level .meta if present", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-rootmeta-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      scaffoldPackage(root, ".", makeManifest("@acme/main", { metaobjectsPackage: "acme::main" }));
      scaffoldPackage(root, "packages/shared", makeManifest("@acme/shared", { metaobjectsPackage: "acme::shared" }));

      const ws = await discoverWorkspace(root);
      expect(ws).toBeDefined();
      expect(ws!.packages.length).toBe(2);
      expect(ws!.findByMetaobjectsPackage("acme::main")).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("discoverWorkspace — no workspace found", () => {
  test("returns undefined when no workspace config exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-none-"));
    try {
      const ws = await discoverWorkspace(root);
      expect(ws).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns undefined when workspace exists but no .meta/ packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-empty-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      mkdirSync(join(root, "packages/foo"), { recursive: true });
      const ws = await discoverWorkspace(root);
      expect(ws).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveExtendsOrder", () => {
  test("returns deps in topological order — deps first, target last", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-order-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      const sharedDir = scaffoldPackage(root, "packages/shared", makeManifest("@acme/shared", { metaobjectsPackage: "acme::shared" }));
      const billingDir = scaffoldPackage(root, "packages/billing", makeManifest("@acme/billing", {
        metaobjectsPackage: "acme::billing",
        extends: ["@acme/shared"],
      }));

      const ws = await discoverWorkspace(billingDir);
      const order = resolveExtendsOrder(ws!, join(billingDir, ".meta"));
      expect(order.map((p) => p.manifest.name)).toEqual(["@acme/shared", "@acme/billing"]);
      void sharedDir;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles diamond dependency (D extends B,C; both extend A)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-diamond-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      scaffoldPackage(root, "packages/a", makeManifest("@acme/a", { metaobjectsPackage: "acme::a" }));
      scaffoldPackage(root, "packages/b", makeManifest("@acme/b", { metaobjectsPackage: "acme::b", extends: ["@acme/a"] }));
      scaffoldPackage(root, "packages/c", makeManifest("@acme/c", { metaobjectsPackage: "acme::c", extends: ["@acme/a"] }));
      const dDir = scaffoldPackage(root, "packages/d", makeManifest("@acme/d", {
        metaobjectsPackage: "acme::d",
        extends: ["@acme/b", "@acme/c"],
      }));

      const ws = await discoverWorkspace(dDir);
      const order = resolveExtendsOrder(ws!, join(dDir, ".meta"));
      const names = order.map((p) => p.manifest.name);

      // A must come before B, C; B and C must come before D
      expect(names.indexOf("@acme/a")).toBeLessThan(names.indexOf("@acme/b"));
      expect(names.indexOf("@acme/a")).toBeLessThan(names.indexOf("@acme/c"));
      expect(names.indexOf("@acme/b")).toBeLessThan(names.indexOf("@acme/d"));
      expect(names.indexOf("@acme/c")).toBeLessThan(names.indexOf("@acme/d"));
      // A appears exactly once
      expect(names.filter((n) => n === "@acme/a").length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-cycle-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      scaffoldPackage(root, "packages/a", makeManifest("@acme/a", { metaobjectsPackage: "acme::a", extends: ["@acme/b"] }));
      const bDir = scaffoldPackage(root, "packages/b", makeManifest("@acme/b", {
        metaobjectsPackage: "acme::b",
        extends: ["@acme/a"],
      }));

      const ws = await discoverWorkspace(bDir);
      expect(() => resolveExtendsOrder(ws!, join(bDir, ".meta"))).toThrow(/cycle/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on missing dep", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-missing-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      const aDir = scaffoldPackage(root, "packages/a", makeManifest("@acme/a", {
        metaobjectsPackage: "acme::a",
        extends: ["@acme/nonexistent"],
      }));

      const ws = await discoverWorkspace(aDir);
      expect(() => resolveExtendsOrder(ws!, join(aDir, ".meta"))).toThrow(/nonexistent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
