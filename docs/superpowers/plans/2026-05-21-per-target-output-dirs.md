# Per-target Output Directories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a metaobjects TypeScript project route each generator's output to a different directory/package, emitting cross-target file references as extension-less package imports while keeping same-target references relative.

**Architecture:** A named `targets` registry (each target = `{ outDir, importBase, outputLayout, dbImport }`) resolved by config normalization. The runner derives the *entity-module target* (where entity files live) from the generator flagged `emitsEntityModule`, builds a per-generator `RenderContext` carrying `selfTarget` + `entityModuleTarget`, routes each emitted file to its target's `outDir`, and scopes collision detection by resolved full path. Templates resolve the entity-file import through a target-aware helper (`entityModuleSpecifier`): same target → relative (today's behavior); cross target → `importBase`-qualified, extension-less. When no `targets`/`target` are configured, a single synthesized `default` target makes every code path identical to today (byte-identical regen).

**Tech Stack:** TypeScript (ESM), Bun test runner, ts-poet (codegen), Biome (format). Reference impl: `server/typescript/packages/{codegen-ts, codegen-ts-react, codegen-ts-tanstack, cli}`.

**Spec:** `docs/superpowers/specs/2026-05-21-per-target-output-dirs-design.md`

**Branch:** `feat/per-target-output-dirs` (already created; the spec commit is on it).

**Run tests from `server/typescript`** (never the repo root): `cd server/typescript && bun test`. Single package: `cd server/typescript/packages/<pkg> && bun test`.

---

## File Structure

**`codegen-ts/src/import-path.ts`** — owns `OutputLayout`, the existing path/specifier helpers, and (new) `ResolvedTarget` + the target-aware resolvers `entityModuleSpecifier`, `siblingSpecifier`, `barrelModuleSpecifier`.

**`codegen-ts/src/metaobjects-config.ts`** — owns `TargetConfig` (user input), the new top-level `targets?` + `importBase?` fields, and `resolveTargets()` invoked by `normalizeConfig()`.

**`codegen-ts/src/generator.ts`** — `Generator` interface gains `target?: string` + `emitsEntityModule?: boolean`.

**`codegen-ts/src/render-context.ts`** — `RenderContext` gains `selfTarget` + `entityModuleTarget`; `makeRenderContext` synthesizes a default target when they're omitted (keeps existing callers byte-identical).

**`codegen-ts/src/runner.ts`** — resolves targets, derives the entity-module target, validates, builds a per-generator render context, routes files to per-target `outDir`, collisions keyed by full path.

**Generator factories** (`codegen-ts/src/generators/*.ts`, `codegen-ts-react/src/form-file.ts`, `codegen-ts-tanstack/src/*.ts`) — each gains a `target?` opt; `entityFile()` sets `emitsEntityModule: true`.

**Templates** (`codegen-ts/src/templates/{queries-file,routes-file,barrel}.ts`, `codegen-ts-tanstack/src/templates/{hooks-file,columns-file,grid-hook-file}.ts`, `codegen-ts-react/src/templates/form-file.ts`) — the entity's-own-file import switches from `crossEntitySpecifier(...)` to `entityModuleSpecifier(...)`; grid-hook's hardcoded `"./Entity.columns"` switches to `siblingSpecifier(...)`. FK/relations and `db` imports need **no change** (they already read `ctx.outputLayout`/`ctx.dbImport`, which the runner now scopes to `selfTarget`).

**`cli/src/commands/gen.ts`** — output shows project-root-relative paths instead of a single `outDir` header + basename rows.

---

## Task 1: Resolver primitives in `import-path.ts`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/import-path.ts`
- Test: `server/typescript/packages/codegen-ts/test/import-path.test.ts`

- [ ] **Step 1: Write failing tests** — append to `import-path.test.ts`:

```ts
import {
  type ResolvedTarget,
  entityModuleSpecifier,
  siblingSpecifier,
  barrelModuleSpecifier,
} from "../src/import-path.js";

const model = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "default", outDir: "db/gen", importBase: "@acme/db/generated",
  outputLayout: "package", dbImport: "../index", ...over,
});
const web = (over: Partial<ResolvedTarget> = {}): ResolvedTarget => ({
  name: "web", outDir: "web/gen", importBase: undefined,
  outputLayout: "package", dbImport: "../index", ...over,
});

describe("entityModuleSpecifier", () => {
  it("same target → relative (honors extStyle), package layout", () => {
    expect(entityModuleSpecifier(model(), model(), "acme::commerce", "Program", "none"))
      .toBe("./Program");
    expect(entityModuleSpecifier(model(), model(), "acme::commerce", "Program", "js"))
      .toBe("./Program.js");
  });
  it("same target → relative, flat layout", () => {
    expect(entityModuleSpecifier(model({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "acme::commerce", "Program", "none"))
      .toBe("./Program");
  });
  it("cross target, package layout → extension-less importBase path (extStyle ignored)", () => {
    expect(entityModuleSpecifier(web(), model(), "acme::commerce", "Program", "js"))
      .toBe("@acme/db/generated/acme/commerce/Program");
  });
  it("cross target, flat layout → importBase + entity, no package path", () => {
    expect(entityModuleSpecifier(web({ outputLayout: "flat" }), model({ outputLayout: "flat" }), "acme::commerce", "Program", "none"))
      .toBe("@acme/db/generated/Program");
  });
  it("cross target, entity at root package → importBase + entity", () => {
    expect(entityModuleSpecifier(web(), model(), undefined, "Tag", "none"))
      .toBe("@acme/db/generated/Tag");
  });
  it("cross target without importBase → throws", () => {
    expect(() => entityModuleSpecifier(web(), model({ importBase: undefined }), "acme::commerce", "Program", "none"))
      .toThrow(/importBase/);
  });
});

describe("siblingSpecifier", () => {
  it("always same-target relative, package layout", () => {
    expect(siblingSpecifier(web(), "acme::commerce", "Program.columns", "none")).toBe("./Program.columns");
  });
  it("honors extStyle", () => {
    expect(siblingSpecifier(web(), "acme::commerce", "Program.columns", "js")).toBe("./Program.columns.js");
  });
});

describe("barrelModuleSpecifier", () => {
  it("same target (package) → './<pkg-path>/<entity>'", () => {
    expect(barrelModuleSpecifier(model(), model(), "acme::commerce", "Program", "none"))
      .toBe("./acme/commerce/Program");
  });
  it("cross target → extension-less importBase path", () => {
    expect(barrelModuleSpecifier(web(), model(), "acme::commerce", "Program", "none"))
      .toBe("@acme/db/generated/acme/commerce/Program");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/import-path.test.ts`
Expected: FAIL — `ResolvedTarget`, `entityModuleSpecifier`, `siblingSpecifier`, `barrelModuleSpecifier` not exported.

- [ ] **Step 3: Implement** — append to `import-path.ts`:

```ts
/** A fully-resolved output destination. Import-identity belongs to the
 *  destination, not the generator. */
export interface ResolvedTarget {
  name: string;
  outDir: string;
  /** Package-specifier prefix others use to import modules produced here.
   *  Required only when another target imports from this one. */
  importBase: string | undefined;
  outputLayout: OutputLayout;
  dbImport: string;
}

/** importBase + (package path when package layout) + entity, extension-less. */
function crossTargetEntityPath(
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
): string {
  const base = entityTarget.importBase;
  if (base === undefined) {
    throw new Error(
      `Cannot emit cross-target import: target "${entityTarget.name}" has no importBase. ` +
      `Set importBase on the target that holds the entity modules.`,
    );
  }
  const pkgPath = entityTarget.outputLayout === "package" ? packageToPath(entityPkg) : "";
  return pkgPath === "" ? `${base}/${entityName}` : `${base}/${pkgPath}/${entityName}`;
}

/** Specifier to import entity `entityName` (in `entityPkg`, produced into
 *  `entityTarget`) from a file emitted into `selfTarget`. Same target → relative
 *  (extStyle honored); cross target → extension-less importBase path. */
export function entityModuleSpecifier(
  selfTarget: ResolvedTarget,
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
  extStyle: ExtStyle,
): string {
  if (selfTarget.name === entityTarget.name) {
    return crossEntitySpecifier(entityTarget.outputLayout, entityPkg, entityPkg, entityName, extStyle);
  }
  return crossTargetEntityPath(entityTarget, entityPkg, entityName);
}

/** A same-target sibling module (e.g. "<Entity>.columns"). Always relative,
 *  package-layout aware, extStyle honored. */
export function siblingSpecifier(
  selfTarget: ResolvedTarget,
  entityPkg: string | undefined,
  basename: string,
  extStyle: ExtStyle,
): string {
  return crossEntitySpecifier(selfTarget.outputLayout, entityPkg, entityPkg, basename, extStyle);
}

/** Barrel re-export specifier. Barrel sits at its target root, so same-target
 *  uses fromPkg=undefined (barrelEntrySpecifier); cross-target is the
 *  extension-less importBase path. */
export function barrelModuleSpecifier(
  selfTarget: ResolvedTarget,
  entityTarget: ResolvedTarget,
  entityPkg: string | undefined,
  entityName: string,
  extStyle: ExtStyle,
): string {
  if (selfTarget.name === entityTarget.name) {
    return barrelEntrySpecifier(entityTarget.outputLayout, entityPkg, entityName, extStyle);
  }
  return crossTargetEntityPath(entityTarget, entityPkg, entityName);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/import-path.test.ts`
Expected: PASS (all new + existing import-path tests).

- [ ] **Step 5: Export from package index** — in `codegen-ts/src/index.ts`, change line 37–38:

```ts
export { packageToPath, entityOutputPath, crossEntitySpecifier, barrelEntrySpecifier, relativeModuleSpecifier, entityModuleSpecifier, siblingSpecifier, barrelModuleSpecifier } from "./import-path.js";
export type { OutputLayout, ResolvedTarget } from "./import-path.js";
```

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/import-path.ts server/typescript/packages/codegen-ts/src/index.ts server/typescript/packages/codegen-ts/test/import-path.test.ts
git commit -m "feat(codegen-ts): target-aware import resolvers"
```

---

## Task 2: `targets` config + `resolveTargets`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/metaobjects-config.ts`
- Test: `server/typescript/packages/codegen-ts/test/metaobjects-config.test.ts`

- [ ] **Step 1: Write failing tests** — append to `metaobjects-config.test.ts`:

```ts
import { resolveTargets, DEFAULT_TARGET_NAME } from "../src/metaobjects-config.js";

describe("resolveTargets", () => {
  const base = { outDir: "db/gen", extStyle: "none" as const, dbImport: "../index", dialect: "sqlite" as const, generators: [] };

  test("synthesizes a 'default' target from top-level fields", () => {
    const t = resolveTargets({ ...base, importBase: "@acme/db/generated", outputLayout: "package" });
    expect(t[DEFAULT_TARGET_NAME]).toEqual({
      name: "default", outDir: "db/gen", importBase: "@acme/db/generated",
      outputLayout: "package", dbImport: "../index",
    });
  });

  test("default target: outputLayout defaults to 'flat', importBase undefined", () => {
    const t = resolveTargets({ ...base });
    expect(t.default.outputLayout).toBe("flat");
    expect(t.default.importBase).toBeUndefined();
  });

  test("named targets resolve; outputLayout + dbImport fall back to top-level, importBase does NOT inherit", () => {
    const t = resolveTargets({
      ...base, outputLayout: "package", importBase: "@acme/db/generated",
      targets: {
        api: { outDir: "api/gen", dbImport: "@acme/database" },
        web: { outDir: "web/gen" },
      },
    });
    expect(t.api).toEqual({ name: "api", outDir: "api/gen", importBase: undefined, outputLayout: "package", dbImport: "@acme/database" });
    expect(t.web).toEqual({ name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" });
  });

  test("named target may override outputLayout + importBase", () => {
    const t = resolveTargets({ ...base, targets: { x: { outDir: "x", outputLayout: "package", importBase: "@x/gen" } } });
    expect(t.x.outputLayout).toBe("package");
    expect(t.x.importBase).toBe("@x/gen");
  });
});

describe("normalizeConfig — targets", () => {
  test("normalized config carries resolved targets incl. default", () => {
    const c = normalizeConfig(defineConfig({
      outDir: "db/gen", extStyle: "none", dbImport: "../index", dialect: "sqlite",
      targets: { api: { outDir: "api/gen" } }, generators: [],
    }));
    expect(Object.keys(c.targets).sort()).toEqual(["api", "default"]);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/metaobjects-config.test.ts`
Expected: FAIL — `resolveTargets`, `DEFAULT_TARGET_NAME`, `config.targets` undefined.

- [ ] **Step 3: Implement** — in `metaobjects-config.ts`:

Add the import + types near the top (after existing imports):

```ts
import type { OutputLayout, ResolvedTarget } from "./import-path.js";
export type { ResolvedTarget };

export const DEFAULT_TARGET_NAME = "default";

/** User-facing per-target output config. */
export interface TargetConfig {
  outDir: string;
  importBase?: string;
  outputLayout?: OutputLayout;
  dbImport?: string;
}
```

Add `targets?` + `importBase?` to `MetaobjectsGenConfig`:

```ts
export interface MetaobjectsGenConfig extends ResolvedGenConfig {
  generators: Generator[];
  columnNamingStrategy?: ColumnNamingStrategy;
  apiPrefix?: string;
  /** Named output destinations. Generators reference one via `target`. */
  targets?: Record<string, TargetConfig>;
  /** importBase for the default target (top-level outDir). */
  importBase?: string;
}
```

Add `targets` to `NormalizedMetaobjectsGenConfig`:

```ts
export interface NormalizedMetaobjectsGenConfig extends MetaobjectsGenConfig {
  columnNamingStrategy: ColumnNamingStrategy;
  apiPrefix: string;
  outputLayout: OutputLayout;
  targets: Record<string, ResolvedTarget>;
}
```

Add `resolveTargets` and call it in `normalizeConfig`:

```ts
/** Synthesize the implicit "default" target from top-level fields and resolve
 *  each named target (outputLayout + dbImport fall back to top-level;
 *  importBase does NOT inherit — it is a per-target identity). */
export function resolveTargets(config: MetaobjectsGenConfig): Record<string, ResolvedTarget> {
  const layout: OutputLayout = config.outputLayout ?? "flat";
  const out: Record<string, ResolvedTarget> = {
    [DEFAULT_TARGET_NAME]: {
      name: DEFAULT_TARGET_NAME,
      outDir: config.outDir,
      importBase: config.importBase,
      outputLayout: layout,
      dbImport: config.dbImport,
    },
  };
  for (const [name, t] of Object.entries(config.targets ?? {})) {
    out[name] = {
      name,
      outDir: t.outDir,
      importBase: t.importBase,
      outputLayout: t.outputLayout ?? layout,
      dbImport: t.dbImport ?? config.dbImport,
    };
  }
  return out;
}
```

In `normalizeConfig`, add `targets: resolveTargets(config),` to the returned object.

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/metaobjects-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/metaobjects-config.ts server/typescript/packages/codegen-ts/test/metaobjects-config.test.ts
git commit -m "feat(codegen-ts): named targets config + resolveTargets"
```

---

## Task 3: `Generator` interface fields

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generator.ts`
- Test: `server/typescript/packages/codegen-ts/test/generator-helpers.test.ts`

- [ ] **Step 1: Write failing test** — append to `generator-helpers.test.ts`:

```ts
import { describe as describe2, it as it2, expect as expect2 } from "bun:test";
import type { Generator as Gen2 } from "../src/generator.js";

describe2("Generator interface — target fields", () => {
  it2("accepts optional target + emitsEntityModule", () => {
    const g: Gen2 = { name: "x", generate: async () => [], target: "web", emitsEntityModule: true };
    expect2(g.target).toBe("web");
    expect2(g.emitsEntityModule).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/generator-helpers.test.ts`
Expected: FAIL — `target`/`emitsEntityModule` not on `Generator` (type error at compile).

- [ ] **Step 3: Implement** — in `generator.ts`, extend the `Generator` interface:

```ts
export interface Generator {
  /** kebab-case identifier; surfaces in diagnostics + drift logs. */
  name: string;
  /** Optional per-entity filter applied via ctx.matches inside generate(). */
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
  /** Named output target (registry key). Defaults to "default". */
  target?: string;
  /** Marks the generator that produces entity modules — the runner uses its
   *  target as the entity-module target for cross-target import resolution. */
  emitsEntityModule?: boolean;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/generator-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generator.ts server/typescript/packages/codegen-ts/test/generator-helpers.test.ts
git commit -m "feat(codegen-ts): Generator gains target + emitsEntityModule"
```

---

## Task 4: `RenderContext` carries `selfTarget` + `entityModuleTarget`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/render-context.ts`
- Test: `server/typescript/packages/codegen-ts/test/render-context.test.ts` (new)

- [ ] **Step 1: Write failing test** — create `test/render-context.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { MetaRoot } from "@metaobjectsdev/metadata";
import { makeRenderContext } from "../src/render-context.js";
import type { ResolvedTarget } from "../src/import-path.js";

const root = new MetaRoot();
const baseInput = {
  dialect: "sqlite" as const, loadedRoot: root, outDir: "db/gen",
  dbImport: "../index", pkMap: new Map(), relationMap: new Map(),
};

describe("makeRenderContext — targets", () => {
  it("synthesizes a default selfTarget from outDir/outputLayout/dbImport when omitted", () => {
    const ctx = makeRenderContext({ ...baseInput, outputLayout: "package" });
    expect(ctx.selfTarget).toEqual({
      name: "default", outDir: "db/gen", importBase: undefined,
      outputLayout: "package", dbImport: "../index",
    });
    expect(ctx.entityModuleTarget).toEqual(ctx.selfTarget);
  });

  it("passes through explicit selfTarget + entityModuleTarget", () => {
    const em: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index" };
    const web: ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" };
    const ctx = makeRenderContext({ ...baseInput, outputLayout: "package", selfTarget: web, entityModuleTarget: em });
    expect(ctx.selfTarget.name).toBe("web");
    expect(ctx.entityModuleTarget.importBase).toBe("@acme/db/generated");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/render-context.test.ts`
Expected: FAIL — `selfTarget`/`entityModuleTarget` not present.

- [ ] **Step 3: Implement** — in `render-context.ts`:

Add the import + interface fields:

```ts
import type { OutputLayout, ResolvedTarget } from "./import-path.js";
```

In `RenderContext`, add:

```ts
  /** The target THIS generator emits to (drives path layout + same-target imports). */
  selfTarget: ResolvedTarget;
  /** Where entity files live (drives cross-target entity imports). */
  entityModuleTarget: ResolvedTarget;
```

In `RenderContextInput`, add both to the omit + optional set:

```ts
export type RenderContextInput = Omit<RenderContext, "extStyle" | "omImport" | "columnNamingStrategy" | "apiPrefix" | "outputLayout" | "packageOf" | "selfTarget" | "entityModuleTarget"> & {
  extStyle?: ExtStyle;
  omImport?: string;
  columnNamingStrategy?: ColumnNamingStrategy;
  apiPrefix?: string;
  outputLayout?: OutputLayout;
  packageOf?: Map<string, string | undefined>;
  selfTarget?: ResolvedTarget;
  entityModuleTarget?: ResolvedTarget;
};
```

In `makeRenderContext`, synthesize the default and set both:

```ts
export function makeRenderContext(opts: RenderContextInput): RenderContext {
  const outputLayout = opts.outputLayout ?? "flat";
  const defaultTarget: ResolvedTarget = opts.selfTarget ?? {
    name: "default",
    outDir: opts.outDir,
    importBase: undefined,
    outputLayout,
    dbImport: opts.dbImport,
  };
  return {
    ...opts,
    extStyle: opts.extStyle ?? "none",
    omImport: opts.omImport ?? "../index",
    columnNamingStrategy: opts.columnNamingStrategy ?? "snake_case",
    apiPrefix: opts.apiPrefix ?? "",
    outputLayout,
    packageOf: opts.packageOf ?? new Map(),
    selfTarget: defaultTarget,
    entityModuleTarget: opts.entityModuleTarget ?? defaultTarget,
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/render-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/render-context.ts server/typescript/packages/codegen-ts/test/render-context.test.ts
git commit -m "feat(codegen-ts): RenderContext carries selfTarget + entityModuleTarget"
```

---

## Task 5: Runner — resolve targets, route files, validate

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/runner.ts`
- Test: `server/typescript/packages/codegen-ts/test/runner.test.ts`

- [ ] **Step 1: Write failing tests** — append to `runner.test.ts`:

```ts
describe("runGen — multi-target", () => {
  test("routes each generator's files to its target outDir; collision scoped per full path", async () => {
    const loader = new FileMetaDataLoader();
    const { root } = await loader.loadFiles([FIXTURE]);
    const apiDir = join(tmp, "api");

    const entity: Generator = {
      name: "entity-file", emitsEntityModule: true,
      generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// entity" })),
    };
    const routes: Generator = {
      name: "routes-file", target: "api",
      generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// routes" })),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite",
        importBase: "@acme/db/generated",
        targets: { api: { outDir: apiDir } },
        generators: [entity, routes],
      }),
      metadata: root,
    });

    // same relative path "Post.ts" in two targets is NOT a collision
    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      join(apiDir, "Post.ts"), join(tmp, "Post.ts"),
    ].sort());
    expect(readFileSync(join(tmp, "Post.ts"), "utf-8")).toContain("// entity");
    expect(readFileSync(join(apiDir, "Post.ts"), "utf-8")).toContain("// routes");
  });

  test("unknown target name → throws listing valid targets", async () => {
    const loader = new FileMetaDataLoader();
    const { root } = await loader.loadFiles([FIXTURE]);
    const g: Generator = { name: "x", target: "nope", generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "" })) };
    await expect(runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite", generators: [g] }),
      metadata: root,
    })).rejects.toThrow(/unknown target "nope".*default/);
  });

  test("cross-target without importBase on entity-module target → throws", async () => {
    const loader = new FileMetaDataLoader();
    const { root } = await loader.loadFiles([FIXTURE]);
    const entity: Generator = { name: "entity-file", emitsEntityModule: true, generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "" })) };
    const routes: Generator = { name: "routes-file", target: "api", generate: perEntity((e) => ({ path: `${e.name}.routes.ts`, content: "" })) };
    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite",
        targets: { api: { outDir: join(tmp, "api") } }, // no importBase anywhere
        generators: [entity, routes],
      }),
      metadata: root,
    })).rejects.toThrow(/importBase/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/runner.test.ts`
Expected: FAIL — files all land in `tmp` (collision or wrong dir); no validation errors thrown.

- [ ] **Step 3: Implement** — rewrite the body of `runGen` from the "Build the shared RenderContext" comment (step 2) onward. Replace the section that builds `renderContext`, runs generators, and writes, with:

```ts
  // 2. Resolve targets + entity-module target.
  const config = normalizeConfig(opts.config);
  const targets = config.targets;
  const targetOf = (g: Generator): ResolvedTarget => {
    const name = g.target ?? DEFAULT_TARGET_NAME;
    const t = targets[name];
    if (!t) {
      throw new Error(
        `Generator "${g.name}" references unknown target "${name}". ` +
        `Valid targets: ${Object.keys(targets).join(", ")}.`,
      );
    }
    return t;
  };
  // Validate all target references up front.
  for (const g of config.generators) targetOf(g);

  const entityGen = config.generators.find((g) => g.emitsEntityModule);
  const entityModuleTarget = entityGen ? targetOf(entityGen) : targets[DEFAULT_TARGET_NAME]!;

  const needsCrossTarget = config.generators.some(
    (g) => (g.target ?? DEFAULT_TARGET_NAME) !== entityModuleTarget.name,
  );
  if (needsCrossTarget && entityModuleTarget.importBase === undefined) {
    throw new Error(
      `Target "${entityModuleTarget.name}" holds the entity modules that other ` +
      `targets import, but has no importBase. Set importBase on it (e.g. ` +
      `"@your-pkg/database/generated").`,
    );
  }

  // 3. Build shared render state once.
  const pkMap = buildPkMap(root);
  const relationMap = buildRelationMap(root);
  const packageOf = new Map<string, string | undefined>(
    root.objects().map((o) => [o.name, o.package]),
  );

  // 4. Run each generator with a per-target render context; collect with full path.
  const emitted: { fullPath: string; content: string; relPath: string; generatedBy: string }[] = [];
  for (const generator of config.generators) {
    const selfTarget = targetOf(generator);
    const renderContext = makeRenderContext({
      dialect: config.dialect,
      loadedRoot: root,
      outDir: selfTarget.outDir,
      dbImport: selfTarget.dbImport,
      extStyle: config.extStyle,
      columnNamingStrategy: config.columnNamingStrategy,
      apiPrefix: config.apiPrefix,
      outputLayout: selfTarget.outputLayout,
      pkMap,
      relationMap,
      packageOf,
      selfTarget,
      entityModuleTarget,
    });
    const ctx: GenContext = {
      entities: safeEntities,
      loadedRoot: root,
      matches: (e) => generator.filter?.(e) ?? true,
      config: {
        outDir: selfTarget.outDir,
        extStyle: config.extStyle,
        dbImport: selfTarget.dbImport,
        dialect: config.dialect,
        outputLayout: selfTarget.outputLayout,
      },
      renderContext,
      warn: (msg) => warnings.push(`[${generator.name}] ${msg}`),
    };

    let files: EmittedFile[];
    try {
      files = await generator.generate(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${generator.name}] ${msg}`);
    }

    for (const file of files) {
      const fullPath = join(selfTarget.outDir, file.path);
      const collision = emitted.find((prev) => prev.fullPath === fullPath);
      if (collision) {
        throw new Error(
          `Output path collision: "${fullPath}" emitted by both ` +
          `"${collision.generatedBy}" and "${generator.name}". ` +
          `Adjust one generator's filter or output path.`,
        );
      }
      emitted.push({ fullPath, content: file.content, relPath: file.path, generatedBy: generator.name });
    }
  }

  // 5. Write phase.
  const writes: WriteResult[] = [];
  for (const file of emitted) {
    const result = decideAndWrite(file.fullPath, file.content, strategy);
    writes.push(result);
    if (result.status === "refused") {
      warnings.push(
        `Refused to overwrite ${file.fullPath}: file exists without @generated header. ` +
        `Move to a different outDir, delete the file, or add the header to opt in.`,
      );
    }
  }

  return { files: writes, warnings };
}
```

Update the imports at the top of `runner.ts`:

```ts
import { normalizeConfig, DEFAULT_TARGET_NAME } from "./metaobjects-config.js";
import type { ResolvedTarget } from "./import-path.js";
```

Delete the now-unused `packageOf`/`renderContext`/`makeRenderContext` block that was between the old steps 2 and 3 (the single shared `makeRenderContext({ ... outDir: config.outDir ... })` call), since it's replaced by the per-generator version. Keep `buildPkMap`, `buildRelationMap`, `makeRenderContext` imports.

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/runner.test.ts`
Expected: PASS (new multi-target + existing happy-path/error tests — note existing tests assert `result.files.map(f=>f.path)` are full `join(tmp, …)` paths, which still holds).

- [ ] **Step 5: Run full codegen-ts suite to catch regressions**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS. The golden tests (`test/golden/*`) must be unchanged — single-target config → `selfTarget === entityModuleTarget` → relative imports → byte-identical.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/runner.ts server/typescript/packages/codegen-ts/test/runner.test.ts
git commit -m "feat(codegen-ts): runner routes files per target + validates"
```

---

## Task 6: Thread `target` through core generator factories

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/{entity-file,queries-file,routes-file,barrel}.ts`
- Test: `server/typescript/packages/codegen-ts/test/generators/factories.test.ts`

- [ ] **Step 1: Write failing tests** — append to `factories.test.ts`:

```ts
import { entityFile } from "../../src/generators/entity-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { barrel } from "../../src/generators/barrel.js";

describe("factories — target wiring", () => {
  it("entityFile sets emitsEntityModule and accepts target", () => {
    expect(entityFile().emitsEntityModule).toBe(true);
    expect(entityFile({ target: "model" }).target).toBe("model");
  });
  it("routesFile/queriesFile/barrel accept target", () => {
    expect(routesFile({ target: "api" }).target).toBe("api");
    expect(queriesFile({ target: "model" }).target).toBe("model");
    expect(barrel({ target: "model" }).target).toBe("model");
  });
  it("target is undefined when unset (back-compat)", () => {
    expect(entityFile().target).toBeUndefined();
    expect(barrel().target).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/generators/factories.test.ts`
Expected: FAIL — `emitsEntityModule` undefined; `barrel()` takes no opts; `target` not set.

- [ ] **Step 3: Implement** — in each factory, set `target` from opts and (entityFile only) `emitsEntityModule: true`.

`entity-file.ts` — set both on the generator object:

```ts
export const entityFile = function entityFile(opts?: EntityFileOpts): Generator {
  const generator: Generator = {
    name: "entity-file",
    emitsEntityModule: true,
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("entity-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.ts`),
        content: await formatTs(renderEntityFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<EntityFileOpts>;
```

And extend `EntityFileOpts`:

```ts
export interface EntityFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}
```

`queries-file.ts` — add `target?: string` to `QueriesFileOpts`; in the factory add `if (opts?.target) generator.target = opts.target;` before `return generator;`.

`routes-file.ts` — add `target?: string` to `RoutesFileOpts`; the factory uses an object literal `return { name, filter, generate }`. Change it to build a `generator` const and append `target`:

```ts
export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "routes-file",
    filter: (e: MetaObject) => e.ownAttr("emitRoutes") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("routes-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.routes.ts`),
        content: await formatTs(renderRoutesFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<RoutesFileOpts>;
```

`barrel.ts` — add a `BarrelOpts` interface + opts param:

```ts
import { oncePerRun, type Generator, type GeneratorFactory } from "../generator.js";
import { renderBarrel } from "../templates/barrel.js";
import { formatTs } from "../format.js";

export interface BarrelOpts {
  target?: string;
}

export const barrel = function barrel(opts?: BarrelOpts): Generator {
  const generator: Generator = {
    name: "barrel",
    generate: oncePerRun(async (entities, ctx) => ({
      path: "index.ts",
      content: await formatTs(
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: e.package })),
          ctx.renderContext!.extStyle,
          ctx.renderContext!.selfTarget,
          ctx.renderContext!.entityModuleTarget,
        ),
      ),
    })),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<BarrelOpts>;
```

(Note: `renderBarrel`'s new signature is implemented in Task 8. Until then this won't compile — that's expected; Task 6 and Task 8 land together conceptually. To keep each task green, do Task 8's `renderBarrel` change *before* running tests here, OR temporarily keep the old `renderBarrel(entries, extStyle, layout)` call using `ctx.renderContext!.selfTarget.outputLayout` and update in Task 8. **Chosen approach:** keep barrel's body change minimal here — pass `ctx.renderContext!.selfTarget.outputLayout` to the existing 3-arg `renderBarrel` — and do the signature change in Task 8.)

Minimal barrel body for this task (keeps the existing `renderBarrel` 3-arg signature):

```ts
      content: await formatTs(
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: e.package })),
          ctx.renderContext!.extStyle,
          ctx.renderContext!.selfTarget.outputLayout,
        ),
      ),
```

Also export `BarrelOpts` from `generators/index.ts`:

```ts
export { barrel, type BarrelOpts } from "./barrel.js";
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/generators/factories.test.ts && bun test`
Expected: PASS (full suite still green; golden unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generators/
git add server/typescript/packages/codegen-ts/test/generators/factories.test.ts
git commit -m "feat(codegen-ts): core generator factories accept target; entityFile flags emitsEntityModule"
```

---

## Task 7: Thread `target` through React + TanStack factories

**Files:**
- Modify: `server/typescript/packages/codegen-ts-react/src/form-file.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/{tanstack-query,tanstack-grid,tanstack-grid-hook}.ts`
- Test: `server/typescript/packages/codegen-ts-tanstack/test/` (add to an existing factory/spec test or create `test/factory-target.test.ts`); `server/typescript/packages/codegen-ts-react/test/` similarly.

- [ ] **Step 1: Write failing test** — create `codegen-ts-tanstack/test/factory-target.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { tanstackQuery } from "../src/tanstack-query.js";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { tanstackGridHook } from "../src/tanstack-grid-hook.js";

describe("tanstack factories — target", () => {
  it("accept target opt", () => {
    expect(tanstackQuery({ target: "web" }).target).toBe("web");
    expect(tanstackGrid({ target: "web" }).target).toBe("web");
    expect(tanstackGridHook({ target: "web" }).target).toBe("web");
  });
  it("target undefined when unset", () => {
    expect(tanstackQuery().target).toBeUndefined();
  });
});
```

And `codegen-ts-react/test/factory-target.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { formFile } from "../src/form-file.js";

describe("formFile factory — target", () => {
  it("accepts target opt", () => {
    expect(formFile({ target: "web" }).target).toBe("web");
  });
  it("target undefined when unset", () => {
    expect(formFile().target).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test test/factory-target.test.ts`
Run: `cd server/typescript/packages/codegen-ts-react && bun test test/factory-target.test.ts`
Expected: FAIL — `target` not set / opts type missing `target`.

- [ ] **Step 3: Implement** — for each of `tanstackQuery`, `tanstackGrid`, `tanstackGridHook`, `formFile`:
  1. Add `target?: string;` to the opts interface (`TanstackQueryOpts`, `TanstackGridOpts`, `TanstackGridHookOpts`, `FormFileOpts`).
  2. Each factory returns an object literal `{ name, filter, generate }`. Change to assign to a `generator: Generator` const, then `if (opts?.target) generator.target = opts.target;` before returning.

Example for `tanstack-query.ts`:

```ts
export const tanstackQuery = function tanstackQuery(opts?: TanstackQueryOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "tanstack-query",
    filter: (e: MetaObject) => e.ownAttr("emitTanstack") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("tanstack-query: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.hooks.ts`),
        content: await formatTs(renderHooksFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<TanstackQueryOpts | void>;
```

Apply the same shape to `tanstackGrid`, `tanstackGridHook` (keep their existing `filter`/`generate` bodies verbatim), and `formFile` (keep its `filter`/`generate` body verbatim).

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test`
Run: `cd server/typescript/packages/codegen-ts-react && bun test`
Expected: PASS (factory-target tests + existing golden/template tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/src/form-file.ts server/typescript/packages/codegen-ts-react/test/factory-target.test.ts
git add server/typescript/packages/codegen-ts-tanstack/src/tanstack-query.ts server/typescript/packages/codegen-ts-tanstack/src/tanstack-grid.ts server/typescript/packages/codegen-ts-tanstack/src/tanstack-grid-hook.ts server/typescript/packages/codegen-ts-tanstack/test/factory-target.test.ts
git commit -m "feat(codegen-ts-react,codegen-ts-tanstack): factories accept target"
```

---

## Task 8: Core templates emit cross-target imports

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/{queries-file,routes-file,barrel}.ts`
- Test: `server/typescript/packages/codegen-ts/test/templates/{queries-file,barrel}.test.ts`, `server/typescript/packages/codegen-ts/test/projection/routes-file.test.ts` (or a new `test/templates/cross-target.test.ts`)

- [ ] **Step 1: Write failing test** — create `test/templates/cross-target.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { FileMetaDataLoader } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";
import { makeRenderContext } from "../../src/render-context.js";
import type { ResolvedTarget } from "../../src/import-path.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "single-entity.json");

async function ctxFor(self: ResolvedTarget, em: ResolvedTarget) {
  const { root } = await new FileMetaDataLoader().loadFiles([FIXTURE]);
  const entity = root.objects()[0]!;
  const ctx = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: self.outDir, dbImport: self.dbImport,
    extStyle: "none", outputLayout: self.outputLayout,
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    packageOf: new Map(root.objects().map((o) => [o.name, o.package])),
    selfTarget: self, entityModuleTarget: em, apiPrefix: "/api",
  });
  return { entity, ctx };
}

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index" };
const api:   ResolvedTarget = { name: "api", outDir: "api/gen", importBase: undefined, outputLayout: "package", dbImport: "@acme/database" };

describe("queries-file — same target stays relative", () => {
  it("imports entity via './<Entity>'", async () => {
    const { entity, ctx } = await ctxFor(model, model);
    expect(renderQueriesFile(entity, ctx)).toContain(`from "./${entity.name}"`);
  });
});

describe("routes-file — cross target", () => {
  it("imports entity via importBase package path, db via per-target dbImport", async () => {
    const { entity, ctx } = await ctxFor(api, model);
    const out = renderRoutesFile(entity, ctx);
    expect(out).toContain(`from "@acme/db/generated/${entity.name}"`);   // flat-package: Post has no package in fixture
    expect(out).toContain(`from "@acme/database"`);                       // per-target db import
    expect(out).not.toContain(`from "./${entity.name}"`);
  });
});
```

(The `single-entity.json` fixture's entity `Post` has no package, so package layout yields `@acme/db/generated/Post`. If the fixture entity *does* declare a package, adjust the expected path accordingly — verify by opening the fixture.)

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts && bun test test/templates/cross-target.test.ts`
Expected: FAIL — routes still emits `./Post` and `../index`.

- [ ] **Step 3: Implement** — switch the entity's-own-file import to `entityModuleSpecifier`:

`templates/queries-file.ts` — replace the `crossEntitySpecifier(...)` call (lines ~23–29) with:

```ts
import { entityModuleSpecifier, relativeModuleSpecifier } from "../import-path.js";
// ...
  const entityFileName = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    obj.package,
    entityName,
    ctx.extStyle,
  );
```

(Leave the `relativeModuleSpecifier(ctx.outputLayout, obj.package, ctx.dbImport)` db line **unchanged** — `ctx.outputLayout`/`ctx.dbImport` already reflect `selfTarget`. Drop the now-unused `crossEntitySpecifier` import if nothing else uses it.)

`templates/routes-file.ts` — same swap for `entityFileSpec` (lines ~32–38):

```ts
import { entityModuleSpecifier, relativeModuleSpecifier } from "../import-path.js";
// ...
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );
```

(Leave the `dbImportSpec = relativeModuleSpecifier(ctx.outputLayout, entity.package, ctx.dbImport)` line unchanged.)

`templates/barrel.ts` — change `renderBarrel` to take the two targets and use `barrelModuleSpecifier`:

```ts
import { GENERATED_HEADER } from "../constants.js";
import { type ExtStyle } from "../render-context.js";
import { barrelModuleSpecifier, type ResolvedTarget } from "../import-path.js";

export interface BarrelEntry {
  name: string;
  package: string | undefined;
}

export function renderBarrel(
  entries: BarrelEntry[],
  extStyle: ExtStyle,
  selfTarget: ResolvedTarget,
  entityModuleTarget: ResolvedTarget,
): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const exports = sorted
    .map((e) => `export * from ${JSON.stringify(barrelModuleSpecifier(selfTarget, entityModuleTarget, e.package, e.name, extStyle))};`)
    .join("\n");
  return `// ${GENERATED_HEADER} — DO NOT EDIT.\n${exports}\n`;
}
```

Then update `generators/barrel.ts` to the 4-arg call (the full version from Task 6 Step 3):

```ts
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: e.package })),
          ctx.renderContext!.extStyle,
          ctx.renderContext!.selfTarget,
          ctx.renderContext!.entityModuleTarget,
        ),
```

Update `test/templates/barrel.test.ts` callers of `renderBarrel` to pass `ResolvedTarget`s instead of a layout string. Minimal helper at the top of that test:

```ts
import type { ResolvedTarget } from "../../src/import-path.js";
const tgt = (outputLayout: "flat" | "package"): ResolvedTarget =>
  ({ name: "default", outDir: "x", importBase: "@acme/db/generated", outputLayout, dbImport: "../index" });
```

Then each existing `renderBarrel(entries, "none", "flat")` becomes `renderBarrel(entries, "none", tgt("flat"), tgt("flat"))`, and `"package"` likewise. (Same-target → identical relative output as before, so assertions stay the same.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS — cross-target test green; golden tests unchanged (single-target config → relative).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/ server/typescript/packages/codegen-ts/src/generators/barrel.ts
git add server/typescript/packages/codegen-ts/test/templates/cross-target.test.ts server/typescript/packages/codegen-ts/test/templates/barrel.test.ts
git commit -m "feat(codegen-ts): queries/routes/barrel templates resolve entity import per target"
```

---

## Task 9: TanStack + React templates emit cross-target imports

**Files:**
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/{hooks-file,columns-file,grid-hook-file}.ts`
- Modify: `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`
- Test: `server/typescript/packages/codegen-ts-tanstack/test/cross-target.test.ts` (new), `server/typescript/packages/codegen-ts-react/test/cross-target.test.ts` (new)

- [ ] **Step 1: Write failing test** — create `codegen-ts-tanstack/test/cross-target.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { FileMetaDataLoader } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";
import { makeRenderContext, buildPkMap, buildRelationMap, type ResolvedTarget } from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "../src/templates/hooks-file.js";

// Reuse a tanstack fixture with a packaged entity + dataGrid layout.
const FIXTURE = resolve(import.meta.dir, "fixtures", "subscriber.json"); // adjust to an existing tanstack test fixture

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index" };
const web:   ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" };

describe("hooks-file — cross target", () => {
  it("imports entity via importBase package path", async () => {
    const { root } = await new FileMetaDataLoader().loadFiles([FIXTURE]);
    const entity = root.objects()[0]!;
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: web.outDir, dbImport: web.dbImport,
      extStyle: "none", outputLayout: "package",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
      packageOf: new Map(root.objects().map((o) => [o.name, o.package])),
      selfTarget: web, entityModuleTarget: model,
    });
    const out = renderHooksFile(entity, ctx);
    expect(out).toContain("@acme/db/generated/");
    expect(out).toContain(`/${entity.name}"`);
    expect(out).not.toContain(`from "./${entity.name}"`);
  });
});
```

(Open `codegen-ts-tanstack/test/` to find an existing fixture with a packaged entity; point `FIXTURE` at it. If none has a package, create `test/fixtures/packaged-entity.json` with `metadata.root.package = "acme::commerce"` and one `object.entity` named `Program` with a `field.string` + `identity.primary`.)

Create `codegen-ts-react/test/cross-target.test.ts` analogously, calling `renderFormFile` and asserting the import uses `@acme/db/generated/…/<Entity>` and not `./<Entity>`.

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test test/cross-target.test.ts`
Run: `cd server/typescript/packages/codegen-ts-react && bun test test/cross-target.test.ts`
Expected: FAIL — still emit `./<Entity>`.

- [ ] **Step 3: Implement** — swap the entity import in each template, and route grid-hook→columns through `siblingSpecifier`:

In `hooks-file.ts` (line ~26), `columns-file.ts` (line ~203), `grid-hook-file.ts` (line ~52), `form-file.ts` (line ~68): replace each `crossEntitySpecifier(ctx.outputLayout, entity.package, entity.package, entity.name, ctx.extStyle)` call with:

```ts
entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, entity.package, entity.name, ctx.extStyle)
```

Update each file's import from `@metaobjectsdev/codegen-ts` to bring in `entityModuleSpecifier` (and `siblingSpecifier` for grid-hook), dropping `crossEntitySpecifier` where no longer used. Example for `hooks-file.ts`:

```ts
import { GENERATED_HEADER, isProjection, pluralize, entityModuleSpecifier } from "@metaobjectsdev/codegen-ts";
```

In `grid-hook-file.ts`, also replace the hardcoded columns import (line ~82):

```ts
      ? code`import { ${filterPresetImports.join(", ")} } from ${JSON.stringify(siblingSpecifier(ctx.selfTarget, entity.package, `${entityName}.columns`, ctx.extStyle))};\n`
```

and import `siblingSpecifier`:

```ts
import { GENERATED_HEADER, entityModuleSpecifier, siblingSpecifier } from "@metaobjectsdev/codegen-ts";
```

Note `columns-file.ts` and `form-file.ts` build `entityModule`/`entityFileSpec` once near the top of the render fn — keep the variable name, just change the right-hand side to `entityModuleSpecifier(...)`.

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test`
Run: `cd server/typescript/packages/codegen-ts-react && bun test`
Expected: PASS — cross-target tests green; existing golden (`codegen-ts-tanstack/test/golden/*`) unchanged (same-target → relative, including grid-hook→columns now via `siblingSpecifier`, which yields identical `./<Entity>.columns` for flat/same-package).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts-tanstack/src/templates/ server/typescript/packages/codegen-ts-tanstack/test/cross-target.test.ts server/typescript/packages/codegen-ts-tanstack/test/fixtures/
git add server/typescript/packages/codegen-ts-react/src/templates/form-file.ts server/typescript/packages/codegen-ts-react/test/cross-target.test.ts server/typescript/packages/codegen-ts-react/test/fixtures/
git commit -m "feat(codegen-ts-react,codegen-ts-tanstack): templates resolve entity import per target; grid-hook→columns via siblingSpecifier"
```

---

## Task 10: CLI gen output for multiple roots

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/gen.ts`
- Test: `server/typescript/packages/cli/test/unit/output-gen.test.ts` (extend) or `test/integration/gen-multi-target.test.ts` (new — covered in Task 11)

- [ ] **Step 1: Write failing test** — append to `cli/test/unit/output-gen.test.ts` a case asserting multi-root paths render distinctly. First inspect the existing test to match its import of `formatGenResult`/`GenFileEntry`. Add:

```ts
it("renders distinct paths for files in different roots", () => {
  const out = formatGenResult({
    files: [
      { path: "packages/database/src/generated/acme/commerce/Program.ts", status: "new", info: "" },
      { path: "apps/api/src/generated/acme/commerce/Program.routes.ts", status: "new", info: "" },
    ],
    outDir: "(multiple targets)",
    dialect: "sqlite", dryRun: false, warnings: [],
  }, { isTTY: false });
  expect(out).toContain("packages/database/src/generated/acme/commerce/Program.ts");
  expect(out).toContain("apps/api/src/generated/acme/commerce/Program.routes.ts");
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server/typescript/packages/cli && bun test test/unit/output-gen.test.ts`
Expected: FAIL — `gen.ts` currently passes basename-only paths (`f.path.split("/").pop()`), so the full paths never reach the formatter.

(The `formatGenResult` formatter itself already prints whatever `path` it's given — no change needed there. The fix is in `gen.ts` mapping. If the test above exercises `formatGenResult` directly it will already pass; in that case make the failing test exercise the `gen.ts` mapping instead. Practical choice: keep this as a `gen.ts` behavior test inside the integration test in Task 11, and skip a standalone unit test here.)

- [ ] **Step 3: Implement** — in `gen.ts`, change the file mapping + header so each row is the path relative to `projectRoot`:

```ts
import { relative } from "node:path";
// ...
  const files: GenFileEntry[] = result.files.map((f) => ({
    path: relative(projectRoot, f.path),
    status: mapStatus(f.status),
    info: "",
  }));

  const targetDirs = Array.from(new Set(
    (forgeConfig.targets ? Object.values(forgeConfig.targets).map((t) => t.outDir) : [])
      .concat([forgeConfig.outDir]),
  ));
  const output = formatGenResult({
    files,
    outDir: targetDirs.length > 1 ? targetDirs.join(", ") : forgeConfig.outDir,
    dialect: forgeConfig.dialect,
    dryRun: cliConfig.dryRun,
    warnings: [],
  }, { isTTY: !!process.stdout.isTTY });
```

(`result.files[].path` is the absolute full path from `decideAndWrite`; `relative(projectRoot, …)` yields a clean project-root-relative display.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/typescript/packages/cli && bun test test/unit/output-gen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/commands/gen.ts server/typescript/packages/cli/test/unit/output-gen.test.ts
git commit -m "feat(cli): gen output shows project-root-relative paths across targets"
```

---

## Task 11: Build dists + full suite + CLI multi-target integration

**Files:**
- Test: `server/typescript/packages/cli/test/integration/gen-multi-target.test.ts` (new)

- [ ] **Step 1: Write failing integration test** — model it on `cli/test/integration/gen-sqlite.test.ts` (open it first to copy the scaffold: temp project dir, `metaobjects/` files, a `metaobjects.config.ts`, then invoke `genCommand`). Configure two targets and assert cross-target imports + file placement:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genCommand } from "../../src/commands/gen.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "meta-multitarget-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("routes generated to api target import entity via importBase; hooks to web target", async () => {
  // metaobjects/ with a packaged entity (mirror gen-sqlite.test.ts fixture authoring)
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.commerce.json"), JSON.stringify({
    "metadata.root": { package: "acme::commerce", children: [
      { "object.entity": { name: "Program", children: [
        { "field.int": { name: "id" } },
        { "field.string": { name: "title" } },
        { "identity.primary": { "@fields": ["id"] } },
      ] } },
    ] },
  }));
  // .metaobjects/config.json (mirror gen-sqlite.test.ts)
  mkdirSync(join(dir, ".metaobjects"), { recursive: true });
  writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify({ dialect: "sqlite" }));
  // metaobjects.config.ts with two targets
  writeFileSync(join(dir, "metaobjects.config.ts"), `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
export default defineConfig({
  outDir: "packages/database/src/generated",
  importBase: "@acme/database/generated",
  extStyle: "none", dbImport: "../index", dialect: "sqlite", outputLayout: "package", apiPrefix: "/api",
  targets: {
    api: { outDir: "apps/api/src/generated", dbImport: "@acme/database" },
    web: { outDir: "apps/web/src/generated" },
  },
  generators: [ entityFile(), queriesFile(), routesFile({ target: "api" }), tanstackQuery({ target: "web" }) ],
});
`);

  const code = await genCommand([], dir);
  expect(code).toBe(0);

  const entityPath = join(dir, "packages/database/src/generated/acme/commerce/Program.ts");
  const routesPath = join(dir, "apps/api/src/generated/acme/commerce/Program.routes.ts");
  const hooksPath  = join(dir, "apps/web/src/generated/acme/commerce/Program.hooks.ts");
  expect(existsSync(entityPath)).toBe(true);
  expect(existsSync(routesPath)).toBe(true);
  expect(existsSync(hooksPath)).toBe(true);

  const routes = readFileSync(routesPath, "utf-8");
  expect(routes).toContain('@acme/database/generated/acme/commerce/Program');
  expect(routes).toContain('@acme/database');                    // per-target db import
  expect(routes).not.toContain('"./Program"');

  const hooks = readFileSync(hooksPath, "utf-8");
  expect(hooks).toContain('@acme/database/generated/acme/commerce/Program');
  expect(hooks).not.toContain('"./Program"');
});
```

(Open `gen-sqlite.test.ts` and mirror its exact metadata + `.metaobjects/config.json` authoring — field subtypes, identity shape, and how it points `@metaobjectsdev/*` at the workspace. Adjust the fixture above to match conventions.)

- [ ] **Step 2: Build dists (CLI resolves codegen from built dist)**

Run:
```bash
cd server/typescript
bun run --filter '@metaobjectsdev/codegen-ts' build
bun run --filter '@metaobjectsdev/codegen-ts-react' build
bun run --filter '@metaobjectsdev/codegen-ts-tanstack' build
bun run --filter '@metaobjectsdev/cli' build
```
(If a package lacks a `build` script, check its `package.json`; some build via `tsc -p tsconfig.build.json`. Use whatever the package defines.)

- [ ] **Step 3: Run the integration test, verify pass**

Run: `cd server/typescript/packages/cli && bun test test/integration/gen-multi-target.test.ts`
Expected: PASS.

- [ ] **Step 4: Full monorepo suite + typecheck**

Run:
```bash
cd server/typescript && bun test
cd server/typescript && bun run --filter '*' typecheck
```
Expected: All green (1784+ existing tests + new). Golden snapshots unchanged.

- [ ] **Step 5: Conformance harness**

Run the conformance suite the way `spec/conformance-tests.md` / the CI workflow invokes it for TS (inspect `.github/workflows` for the exact command if unsure).
Expected: green — this change does not touch the metamodel or serializer.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/cli/test/integration/gen-multi-target.test.ts
git add server/typescript/packages/*/dist
git commit -m "test(cli): end-to-end multi-target gen; rebuild dists"
```

(If `dist/` is gitignored, omit it from the commit — just ensure it's rebuilt locally for the downstream check.)

---

## Task 12: Downstream verification in downstream-consumer (verify only — do NOT commit)

**Files:** none in this repo. Work in `/home/doug/Development/downstream-consumer` without committing.

- [ ] **Step 1: Snapshot current state** — note `git status` in downstream-consumer so any edits can be reverted:

```bash
cd /home/doug/Development/downstream-consumer && git status
```

- [ ] **Step 2: Edit `metaobjects.config.ts`** to route the three targets:

```ts
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  outDir: "packages/database/src/generated",
  importBase: "@acme/database/generated",
  extStyle: "none", dbImport: "../index", dialect: "sqlite",
  columnNamingStrategy: "snake_case", apiPrefix: "/api", outputLayout: "package",
  targets: {
    api: { outDir: "apps/api/src/generated", dbImport: "@acme/database" },
    web: { outDir: "apps/web/src/generated" },
  },
  generators: [
    entityFile(), queriesFile(), barrel(),
    routesFile({ target: "api" }),
    formFile({ target: "web" }), tanstackQuery({ target: "web" }),
    tanstackGrid({ target: "web" }), tanstackGridHook({ target: "web" }),
  ],
});
```

- [ ] **Step 3: Ensure the api/web apps expose an `exports`/path mapping** so `@acme/database/generated/*` resolves (it already does in the database package). The web/api apps already import from `@acme/database/generated/*` via `moduleResolution: "bundler"`, so no change should be needed. Delete the now-stale generated files in the old single location if needed before regen.

- [ ] **Step 4: Regenerate + build**

```bash
cd /home/doug/Development/downstream-consumer
pnpm -F @acme/database meta:gen
pnpm build
```
Expected: gen writes entity/queries to `packages/database`, routes to `apps/api`, hooks/grid/form/columns to `apps/web`; build passes. Generated routes/hooks import the entity module as `@acme/database/generated/...`.

- [ ] **Step 5: Confirm the dependency-graph win** — the database package no longer needs react/tanstack/fastify (it only emits Drizzle + Zod now). Verify no `.tsx`/`.routes.ts`/`.hooks.ts` remain under `packages/database/src/generated`.

- [ ] **Step 6: Revert downstream-consumer changes (do not commit)**

```bash
cd /home/doug/Development/downstream-consumer && git checkout -- . && git clean -fd  # restore generated tree + config
```
(Confirm with `git status` that the working tree matches Step 1.)

- [ ] **Step 7: Report** the downstream result (pass/fail, any friction) back to the user. The feature + tests are already committed in the metaobjects repo on `feat/per-target-output-dirs`.

---

## Self-Review (completed during planning)

**Spec coverage:**
- Named targets registry + per-generator `target` → Tasks 2, 3, 6, 7.
- Entity-module target via `emitsEntityModule` → Tasks 3, 5, 6.
- Cross-target extension-less import format → Task 1 (resolver) + Tasks 8, 9 (templates).
- Per-target `dbImport` override → Tasks 2, 5 (threading) verified in Tasks 8, 11.
- `siblingSpecifier` for grid-hook→columns → Tasks 1, 9.
- Single barrel in its target → Tasks 1 (`barrelModuleSpecifier`), 6, 8.
- RenderContext threading → Task 4.
- Path routing + full-path collision + validation → Task 5.
- CLI multi-root output → Task 10.
- Backward-compat byte-identical regen → guarded by existing golden tests run in Tasks 5, 6, 8, 9, 11.
- Downstream validation (no commit) → Task 12.
- Rebuild dists → Task 11.

**Placeholder scan:** none — every code/test step shows concrete content; fixture-authoring steps point at the exact existing test to mirror.

**Type consistency:** `ResolvedTarget` defined once in `import-path.ts`, re-exported from config + package index; `entityModuleSpecifier`/`siblingSpecifier`/`barrelModuleSpecifier` signatures are identical across the resolver definition (Task 1), template call sites (Tasks 8–9), and `renderBarrel` (Task 8). `DEFAULT_TARGET_NAME` defined in config (Task 2), used in runner (Task 5). `selfTarget`/`entityModuleTarget` field names consistent across RenderContext (Task 4), runner (Task 5), and all templates (Tasks 8–9).
