// Tests for source-aware dispatch in renderEntityFile.
// Verifies that:
//   - projection entities route through renderProjectionDecl (view + Zod read schema)
//   - vanilla entities still go through the Drizzle-table path

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, resolveTableName } from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";
import { projectionViewName } from "../../src/projection/extract-view-spec.js";
import { isProjection } from "../../src/projection/projection-detector.js";
import { resolveObjectNames } from "../../src/names.js";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixture: ProgramSummary projection (extends Program, source.rdb @kind:view)
// ---------------------------------------------------------------------------

async function loadProjectionFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
          {
            "relationship.association": {
              name: "weeks",
              "@objectRef": "Week",
              "@cardinality": "many",
            },
          },
        ],
      },
    },
    {
      "object.entity": {
        name: "Week",
        children: [
          { "source.rdb": { "@table": "weeks" } },
          { "field.int": { name: "id", } },
          { "field.int": { name: "programId", } },
          { "identity.primary":   { "name": "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          { "field.string": { name: "title", extends: "Program.title" } },
          { "identity.primary": { "name": "id", extends: "Program.id" } },
          {
            "field.int": {
              name: "weekCount",
              children: [
                {
                  "origin.aggregate": {
                    "@agg": "count",
                    "@of": "Week.id",
                    "@via": "Program.weeks",
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ]);

  const projection = root.objects().find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

// ---------------------------------------------------------------------------
// Fixture: vanilla Post entity (source.rdb @kind:table)
// ---------------------------------------------------------------------------

async function loadVanillaFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Post",
        children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.objects().find((o) => o.name === "Post");
  if (!entity) throw new Error("Post not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderEntityFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits Drizzle view declaration (sqliteView for sqlite)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("sqliteView");
      expect(out).toContain("v_program_summary");
      expect(out).toContain(".existing()");
    });

    test("emits Zod read schema (ProgramSummarySchema)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("ProgramSummarySchema");
      expect(out).toContain("z.object");
    });

    test("emits constants block with $view and $path", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("$view");
      expect(out).toContain("$path");
      expect(out).toContain("/program-summaries");
    });

    test("does NOT emit Drizzle table declaration", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).not.toContain("sqliteTable");
    });

    test("does NOT emit Insert/Update Zod schemas", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });

    test("declared extends-bound fields appear in schema (FR-024 inclusive list)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderEntityFile(projection, ctx);
      // id and title are DECLARED extends-bound fields (the inclusive list)
      expect(out).toContain("id:");
      expect(out).toContain("title:");
      // weekCount is projection-declared
      expect(out).toContain("weekCount:");
    });

    test("postgres dialect emits pgView", async () => {
      const { root, projection } = await loadProjectionFixture();
      const ctx = makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/x",
        dbImport: "~/db",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
      });
      const out = renderEntityFile(projection, ctx);
      expect(out).toContain("pgView");
      expect(out).not.toContain("sqliteView");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits Drizzle table declaration (sqliteTable)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("sqliteTable");
    });

    test("emits Insert and Update Zod schemas", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("emits InferSelectModel type", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).toContain("InferSelectModel");
    });

    test("does NOT emit sqliteView", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderEntityFile(entity, ctx);
      expect(out).not.toContain("sqliteView");
    });
  });

  // A contract-only target (selfTarget.runtime === false) is the UI/wire-package
  // axis: no server runtime bindings at all. A projection keeps its Zod read
  // schema + inferred type but drops the Drizzle view; a write-through entity
  // renders as its plain shape (interface + Zod) instead of a Drizzle table.
  // Neither imports drizzle-orm. This replaces the old per-call includeViewDecl
  // flag — the decision now lives on the target's audience, not on each artifact.
  describe("contract-only target (runtime: false)", () => {
    function contractCtx(root: Parameters<typeof buildPkMap>[0]) {
      return makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/x",
        dbImport: "~/db",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
        selfTarget: {
          name: "shared", outDir: "/x", importBase: "@pkg/shared/generated",
          outputLayout: "flat", dbImport: "~/db", runtime: false,
        },
      });
    }

    test("projection: keeps Zod read schema + type, drops pgView + drizzle-orm", async () => {
      const { root, projection } = await loadProjectionFixture();
      const out = renderEntityFile(projection, contractCtx(root));
      // contract kept:
      expect(out).toContain("ProgramSummarySchema");
      expect(out).toContain("export type ProgramSummary");
      // runtime stripped:
      expect(out).not.toContain("pgView");
      expect(out).not.toContain(".existing()");
      expect(out).not.toContain("drizzle-orm");
    });

    test("write-through entity: renders plain shape, no pgTable / drizzle-orm", async () => {
      const { root, entity } = await loadVanillaFixture();
      const out = renderEntityFile(entity, contractCtx(root));
      // shape kept (Zod schema + a type for the entity):
      expect(out).toContain("z.object");
      expect(out).toContain("Post");
      // runtime stripped:
      expect(out).not.toContain("pgTable");
      expect(out).not.toContain("drizzle-orm");
      expect(out).not.toContain("InferSelectModel");
    });

    test("no runtime-ts allowlists in a contract target", async () => {
      const { root, projection } = await loadProjectionFixture();
      const out = renderEntityFile(projection, contractCtx(root));
      expect(out).not.toContain("@metaobjectsdev/runtime-ts");
      expect(out).not.toContain("FilterAllowlist");
    });
  });
});

// ---------------------------------------------------------------------------
// §A6 Task 1 — a projection's dbCol + view name/columns reference the names
// artifact. Own fixture (NOT loadProjectionFixture above): the discriminating
// assertion needs a field whose @column is deliberately NOT the snake_case of
// its field name (`callPurpose` -> `purpose_code`), so a re-derivation that
// ignored @column would produce `call_purpose` and this test would catch it.
// ---------------------------------------------------------------------------

async function loadProjectionNamesFixture(includeNames: boolean) {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          // Deliberately NOT the snake_case of the field name.
          { "field.string": { name: "callPurpose", "@column": "purpose_code" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          { "field.string": { name: "callPurpose", extends: "Program.callPurpose" } },
          { "identity.primary": { "name": "id", extends: "Program.id" } },
        ],
      },
    },
  ]);

  const projection = root.objects().find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    includeNames,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

describe("renderEntityFile — a projection's dbCol + view name/columns reference the names artifact (§A6)", () => {
  test("with the names generator ACTIVE, dbCol references the constant, honoring an inherited @column", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(true);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain("dbCol: ProgramSummaryNames.fields.callPurpose.column");
    // The literal must be GONE, not merely accompanied.
    expect(out).not.toContain('dbCol: "purpose_code"');
    // And the re-derivation trap: a naive snake_case-of-the-field-name transform
    // would have produced this instead of honoring the inherited @column.
    expect(out).not.toContain('dbCol: "call_purpose"');
  });

  test("with the names generator ACTIVE, the Drizzle view declaration references the view name + column constants", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(true);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain("sqliteView(ProgramSummaryNames.sources.primary.view");
    expect(out).toContain("ProgramSummaryNames.fields.callPurpose.column");
    expect(out).not.toContain('sqliteView("v_program_summary"');
    expect(out).not.toContain('"purpose_code"');
  });

  // §A6 Task 1 fix round 1 — the descriptor's $view is a SECOND, independent
  // embedding of the view's physical name, distinct from the Drizzle .existing()
  // decl the test above covers (view-decl.ts). Both must reference the constant,
  // or a reader cannot tell which spelling is authoritative.
  test("with the names generator ACTIVE, the descriptor's $view references the constant", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(true);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain("$view: ProgramSummaryNames.sources.primary.view");
    expect(out).not.toContain('$view: "v_program_summary"');
  });

  test("with the names generator NOT in the run, the projection keeps every literal", async () => {
    const { projection, ctx } = await loadProjectionNamesFixture(false);
    const out = renderEntityFile(projection, ctx);

    expect(out).toContain('dbCol: "purpose_code"');
    expect(out).toContain('sqliteView("v_program_summary"');
    expect(out).toContain('$view: "v_program_summary"');
    expect(out).not.toContain("ProgramSummaryNames");
  });
});

// ---------------------------------------------------------------------------
// §A6 Task 1 fix round 1 found, fix round 2 CLOSED: `projectionViewName()`
// (extract-view-spec.ts `viewName()`) and `resolveTableName()` (what
// `resolveObjectNames` — and every §A6 site — uses) used to be different
// resolvers. `viewName()` was own-only and picked the FIRST read-only source
// in declaration order, with no role filter; `resolveTableName()` filters by
// `role === "primary"`, order-independent. For a projection declaring a
// role:"replica" read-only source BEFORE its own role:"primary" one, the two
// disagreed — confirmed loadable (not a licensing violation) by this fixture.
// Round 2 fixed `viewName()` itself to select by role, same as
// `resolveTableName()` — this suite now pins that BOTH declaration orders
// agree, and that the ON and OFF arms bind the SAME view name (the
// role:"primary" source's) regardless of which was declared first. Kept
// own-only per its own original charter: `ERR_PROJECTION_INHERITED_SOURCE`
// (subtype-rules.ts) makes an inherited source unreachable here anyway.
// ---------------------------------------------------------------------------

async function loadMultiSourceProjectionFixture(includeNames: boolean, replicaFirst: boolean) {
  const primarySource = { "source.rdb": { name: "primarySrc", "@kind": "view", "@table": "v_primary_name", "@role": "primary" } };
  const replicaSource = { "source.rdb": { name: "replicaSrc", "@kind": "view", "@table": "v_replica_name", "@role": "replica" } };

  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Base",
        children: [
          { "source.rdb": { "@table": "bases" } },
          { "field.int": { name: "id" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "P",
        children: [
          ...(replicaFirst ? [replicaSource, primarySource] : [primarySource, replicaSource]),
          { "field.int": { name: "id", extends: "Base.id" } },
          { "identity.primary": { "name": "id", extends: "Base.id" } },
        ],
      },
    },
  ]);

  const projection = root.objects().find((o) => o.name === "P");
  if (!projection) throw new Error("P not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    includeNames,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

describe("renderEntityFile — a projection's role:primary source wins regardless of declaration order (§A6 fix round 2)", () => {
  test("replica declared FIRST: viewName()/projectionViewName() now agrees with resolveTableName() — both name the PRIMARY source", async () => {
    const { projection, ctx: ctxOff } = await loadMultiSourceProjectionFixture(false, true);
    // Sanity: this shape loads at all (not a licensing violation) — the whole point.
    expect(projection.name).toBe("P");
    // The OFF-arm literal comes straight from viewName()/projectionViewName() — post-fix,
    // role-filtered, so it now names the PRIMARY source even though the REPLICA source
    // was declared first in the fixture.
    const outOff = renderEntityFile(projection, ctxOff);
    expect(outOff).toContain('$view: "v_primary_name"');
    expect(outOff).toContain('sqliteView("v_primary_name"');
    expect(outOff).not.toContain("v_replica_name");
  });

  // The assertion that encodes why this was in Task 1's own scope (RULING R13): the ON
  // and OFF arms must bind the SAME physical view for the SAME metadata. Before this fix,
  // flipping ctx.includeNames — an unrelated generator toggle — silently changed which
  // database view a projection's generated code bound to. Now both arms agree.
  test("replica declared FIRST: the ON arm binds the SAME view name as the OFF arm — no generator-toggle-dependent rebind", async () => {
    const { projection: projOff, ctx: ctxOff } = await loadMultiSourceProjectionFixture(false, true);
    const { projection: projOn, ctx: ctxOn } = await loadMultiSourceProjectionFixture(true, true);

    const outOff = renderEntityFile(projOff, ctxOff);
    const outOn = renderEntityFile(projOn, ctxOn);

    expect(outOff).toContain('$view: "v_primary_name"');
    // The ON arm references the constant, but the constant's VALUE (asserted via
    // resolveObjectNames in the probe behind this fixture, and by construction — PNames.sources.primary.view
    // IS resolveTableName()'s answer) is the identical "v_primary_name" string.
    expect(outOn).toContain("$view: PNames.sources.primary.view");
    expect(outOn).toContain("sqliteView(PNames.sources.primary.view");
    expect(outOn).not.toContain("v_replica_name");
    // Neither arm ever emits the replica's name — this is the regression the fix closes.
  });

  test("primary declared FIRST: both resolvers already agreed, and still do after the fix", async () => {
    const { projection: projOff, ctx: ctxOff } = await loadMultiSourceProjectionFixture(false, false);
    const outOff = renderEntityFile(projOff, ctxOff);
    expect(outOff).toContain('$view: "v_primary_name"');

    const { projection, ctx } = await loadMultiSourceProjectionFixture(true, false);
    const outOn = renderEntityFile(projection, ctx);
    expect(outOn).toContain("$view: PNames.sources.primary.view");
  });
});

// §A6 fix round 2, ruling R13 part (b) — reachability of the DIFFERENT no-source
// fallback strings (`viewName()`'s "v_" + snake(name) vs `resolveTableName()`'s
// pluralize(snake(name))). Empirically: for a projection with ZERO own sources,
// `resolveObjectNames()` returns undefined (no primary source to find) BEFORE it
// ever calls `resolveTableName()` — so resolveTableName()'s fallback branch is
// never reached through this call graph at all, and no §A6 site ever has a names
// artifact to reference for such an object; the ON and OFF arms both fall through
// to viewName()'s OWN literal on the identical no-source condition. The two
// fallback STRINGS differ, but that difference is unreachable as an observable
// divergence — so the fallback was left unchanged, per the ruling.
describe("a sourceless projection (§A6 fix round 2, reachability check)", () => {
  async function loadSourcelessProjection() {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Base",
          children: [
            { "source.rdb": { "@table": "bases" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "Sourceless",
          children: [
            { "field.int": { name: "id", extends: "Base.id" } },
            { "identity.primary": { "name": "id", extends: "Base.id" } },
          ],
        },
      },
    ]);
    const projection = root.objects().find((o) => o.name === "Sourceless");
    if (!projection) throw new Error("Sourceless not found");
    return projection;
  }

  // Doubly unreachable, empirically: (1) `isProjection()` requires a read-only-KIND
  // source to be true at all — a sourceless `object.projection` is neither a projection
  // nor write-through by codegen's own dispatch (projection-detector.ts), so
  // `renderEntityFile` routes it through the plain value-object path and NEVER calls
  // `renderProjectionDecl`/`projectionViewName`/`viewName()` for it. (2) Even called
  // directly, `resolveObjectNames()` returns `undefined` for a sourceless object (no
  // primary source to find) BEFORE it ever calls `resolveTableName()` — so
  // `resolveTableName()`'s DIFFERENT no-source fallback (`pluralize(snake(name))` vs
  // `viewName()`'s `"v_" + snake(name)`) is never compared against `viewName()`'s
  // answer through any §A6 site. The two fallback STRINGS differ (asserted below,
  // calling both functions directly) but the divergence has no path to become
  // observable — so the fallback was left unchanged, per ruling R13(b).
  test("isProjection() is false — codegen's own dispatch never reaches viewName() for this shape", async () => {
    const projection = await loadSourcelessProjection();
    expect(isProjection(projection)).toBe(false);
  });

  test("resolveObjectNames() is undefined, so no §A6 site ever compares the two fallbacks", async () => {
    const projection = await loadSourcelessProjection();
    expect(resolveObjectNames(projection, "snake_case")).toBeUndefined();
  });

  test("the two fallback strings genuinely differ when called directly (documents the unreachable difference)", async () => {
    const projection = await loadSourcelessProjection();
    expect(projectionViewName(projection, "snake_case")).toBe("v_sourceless");
    expect(resolveTableName(projection)).toBe("sourcelesses");
    expect(projectionViewName(projection, "snake_case")).not.toBe(resolveTableName(projection));
  });
});
