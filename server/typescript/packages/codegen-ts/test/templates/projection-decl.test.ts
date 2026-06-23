import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderProjectionDecl } from "../../src/templates/projection-decl.js";

// ---------------------------------------------------------------------------
// Unit tests for pathFromProjectionName (Fix 1 — pluralize() for sh/ch/x/z)
// ---------------------------------------------------------------------------
// pathFromProjectionName is not exported; exercise it via renderProjectionDecl
// output and inspect the $path constant. We create minimal projections named
// after the edge-case words to verify the correct URL segment.

/**
 * Build a minimal two-entity setup: a base table entity named `baseName`
 * and a projection named `projName` that extends it. Used to exercise
 * `pathFromProjectionName` via renderProjectionDecl.
 */
async function makeMinimalProjection(projName: string, baseName: string) {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: baseName,
            children: [
              { "source.rdb": { "@table": baseName.toLowerCase() + "s" } },
              { "field.int": { name: "id", } },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          },
        },
        {
          // FR-024 (B4b): a projection never extends an entity (the firehose is
          // removed) — its inclusive list + extends-bound identity anchor the base.
          "object.projection": {
            name: projName,
            children: [
              { "source.rdb": { "@kind": "view", "@table": `v_${projName.toLowerCase()}` } },
              { "field.int": { name: "id", extends: `${baseName}.id` } },
              { "identity.primary": { "name": "id", extends: `${baseName}.id` } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = result.root;
  const projection = root.objects().find((o) => o.name === projName)!;
  return { root, projection };
}

describe("pathFromProjectionName — pluralization edge cases", () => {
  test("BoxView → /box-views (x-ending uses pluralize())", async () => {
    // "BoxView" → pluralize("BoxView") = "BoxViews" → snake "box_views" → kebab "/box-views"
    const { root, projection } = await makeMinimalProjection("BoxView", "Box");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/box-views"');
  });

  test("WishView → /wish-views (sh-ending uses pluralize())", async () => {
    const { root, projection } = await makeMinimalProjection("WishView", "Wish");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/wish-views"');
  });

  test("ProgramSummary → /program-summaries (y-ending regression)", async () => {
    const { root, projection } = await makeMinimalProjection("ProgramSummary", "Program");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/program-summaries"');
  });

  test("CustomerSummary → /customer-summaries (y-ending regression)", async () => {
    const { root, projection } = await makeMinimalProjection("CustomerSummary", "Customer");
    const code = renderProjectionDecl(projection, root, { columnNamingStrategy: "snake_case", dialect: "sqlite" });
    expect(code).toContain('"/customer-summaries"');
  });
});

describe("renderProjectionDecl — typed view columns + allowlists gate", () => {
  // A passthrough projection over a jsonb + timestamp source. The view declaration
  // must carry TYPED columns (not an empty `{}`), honoring @dbColumnType, so the
  // generated view backs a typed `db.select()`. With allowlists:false it must NOT
  // import runtime-ts (dependency-free output).
  async function load() {
    const json = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [
          { "object.entity": {
            name: "Cfg",
            children: [
              { "source.rdb": { "@table": "cfgs" } },
              { "field.uuid": { name: "id" } },
              { "field.string": { name: "payloadJson", "@dbColumnType": "jsonb" } },
              { "field.timestamp": { name: "createdAt" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
            ],
          }},
          { "object.projection": {
            name: "CfgView",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_cfg" } },
              { "field.uuid": { name: "id", extends: "Cfg.id" } },
              { "field.string": { name: "payload", "@dbColumnType": "jsonb",
                children: [{ "origin.passthrough": { "@from": "Cfg.payloadJson" } }] } },
              { "field.timestamp": { name: "created_at",
                children: [{ "origin.passthrough": { "@from": "Cfg.createdAt" } }] } },
              { "identity.primary": { name: "id", extends: "Cfg.id" } },
            ],
          }},
        ],
      },
    });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
    const projection = result.root.objects().find((o) => o.name === "CfgView")!;
    return { root: result.root, projection };
  }

  test("emits typed pgView columns (jsonb/timestamp), not an empty map", async () => {
    const { root, projection } = await load();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case", dialect: "postgres", timestampMode: "date", allowlists: false,
    });
    expect(code).not.toContain("pgView(\"v_cfg\", {})");
    expect(code).toContain('jsonb("payload")');           // @dbColumnType honored
    expect(code).toContain('timestamp("created_at"');     // timestamp builder
    expect(code).toContain('uuid("id")');
  });

  test("allowlists:false omits the runtime-ts import", async () => {
    const { root, projection } = await load();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case", dialect: "postgres", timestampMode: "date", allowlists: false,
    });
    expect(code).not.toContain("@metaobjectsdev/runtime-ts");
  });

  test("allowlists:true (default) still emits the allowlists", async () => {
    const { root, projection } = await load();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case", dialect: "postgres", timestampMode: "date",
    });
    expect(code).toContain("FilterAllowlist");
  });
});

// ---------------------------------------------------------------------------
// Helper — load a Program + Week + ProgramSummary tri-entity setup.
// Returns { root, projection } — root is the loader's root MetaData (all
// top-level objects are direct children, from LoadResult.root), projection is ProgramSummary.
// ---------------------------------------------------------------------------
async function loadProjection() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
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
      ],
    },
  });

  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }

  const root = result.root;
  const projection = root
    .objects()
    .find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found in root");

  return { root, projection };
}

describe("renderProjectionDecl emits Drizzle view + Zod read schema + constants", () => {
  test("sqlite dialect uses sqliteView", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain("sqliteView");
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain("export const ProgramSummarySchema");
    expect(code).toContain("export const ProgramSummary");
    expect(code).toContain('$view:');
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain('$path:');
    expect(code).toContain('"/program-summaries"');

    // Read-only: no Insert/Update Zod schemas or types
    expect(code).not.toContain("ProgramSummaryInsert");
    expect(code).not.toContain("ProgramSummaryUpdate");
  });

  test("postgres dialect uses pgView", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "postgres",
    });

    expect(code).toContain("pgView");
    expect(code).not.toContain("sqliteView");
    expect(code).toContain('"v_program_summary"');
    expect(code).toContain("export const ProgramSummarySchema");
    expect(code).toContain("export const ProgramSummary");
  });

  test("declared extends-bound fields appear in schema and constants (FR-024 inclusive list)", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    // Program.id and Program.title are inherited; weekCount is projection-declared
    expect(code).toContain("id:");
    expect(code).toContain("title:");
    expect(code).toContain("weekCount:");
  });

  test("$entity constant matches projection name", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain('$entity: "ProgramSummary"');
  });

  test(".existing() is emitted on the view declaration", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    expect(code).toContain(".existing()");
  });

  test("emits FilterAllowlist, SortAllowlist, and Filter type", async () => {
    const { root, projection } = await loadProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "sqlite",
    });

    // All three filter symbols must be exported so routes can import them.
    expect(code).toContain("ProgramSummaryFilterAllowlist");
    expect(code).toContain("ProgramSummarySortAllowlist");
    expect(code).toContain("ProgramSummaryFilter");
  });
});

// ---------------------------------------------------------------------------
// Standalone read-only view-entity (NO `extends`).
// The read model only needs the view name + the entity's own fields — not the
// join/DDL resolution. A view whose base is not a writable metaobjects entity
// (e.g. one over legacy tables), or one that maps a deliberately narrowed set of
// columns (excluding a sensitive field), is authored as a standalone projection:
// explicit columns + source.rdb kind=view, no extends. Its SQL is hand-authored.
// ---------------------------------------------------------------------------
async function loadStandaloneProjection() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.projection": {
            name: "LobbyRoster",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_lobby_roster" } },
              { "field.string": { name: "sessionId" } },
              { "field.string": { name: "displayName" } },
              { "field.string": { name: "status" } },
              { "layout.dataGrid": { name: "default", "@fields": "displayName,status" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = result.root;
  const projection = root.objects().find((o) => o.name === "LobbyRoster")!;
  return { root, projection };
}

describe("renderProjectionDecl — standalone view-entity (no extends)", () => {
  test("generates the read model from own fields without throwing", async () => {
    const { root, projection } = await loadStandaloneProjection();
    const code = renderProjectionDecl(projection, root, {
      columnNamingStrategy: "snake_case",
      dialect: "postgres",
    });

    // View name comes from the read-only source @table (no join resolution).
    expect(code).toContain("pgView");
    expect(code).toContain('"v_lobby_roster"');
    expect(code).toContain(".existing()");
    // Own fields populate the schema + constants.
    expect(code).toContain("export const LobbyRosterSchema");
    expect(code).toContain("sessionId:");
    expect(code).toContain("displayName:");
    expect(code).toContain("status:");
    expect(code).toContain('$entity: "LobbyRoster"');
    expect(code).toContain('"/lobby-rosters"');
    // Still read-only — no write artifacts.
    expect(code).not.toContain("LobbyRosterInsert");
    expect(code).not.toContain("LobbyRosterUpdate");
  });
});
