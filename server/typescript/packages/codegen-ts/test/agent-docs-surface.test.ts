// The `agent` docs surface — the three pages an agent reads before touching a tier.
//
// What these tests are FOR, beyond "it renders": every one of them pins a way the surface
// could state something untrue. A page an agent is told to trust is worse than no page when
// it is wrong, so the assertions are about the claims, not the layout.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { agentDocsFile } from "../src/generators/agent-docs-file.js";
import { renderAgentSchemaPage } from "../src/generators/agent-schema-page.js";
import type { AgentSchemaInput, SchemaColumnLike } from "../src/generators/agent-schema-input.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

async function load(model: unknown): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function makeCtx(root: MetaRoot): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext: makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/tmp",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
}

async function emit(root: MetaRoot, opts?: Parameters<typeof agentDocsFile>[0]): Promise<Map<string, string>> {
  const files = await agentDocsFile(opts).generate(makeCtx(root));
  return new Map(files.map((f) => [f.path, f.content]));
}

// A model with an entity that has a UI, a prompt payload that has none, and one claimed
// field. Deliberately small: each page is asserted on the claim it could get wrong.
const MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          "@description": "A customer's placed order.",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "reference", "@required": true, "@filterable": true } },
            { "field.enum": { name: "status", "@values": ["open", "closed"] } },
            { "field.string": { name: "internalNote", "@formExclude": true } },
            {
              "layout.dataGrid": {
                name: "default",
                "@columns": ["reference", "status"],
                "@defaultSortField": "reference",
                "@defaultSortOrder": "desc",
                "@pageSize": 25,
              },
            },
          ],
        },
      },
      // No source ⇒ no endpoint ⇒ no generated UI. It must not appear on ui.md.
      {
        "object.value": {
          name: "OrderBlurbPayload",
          children: [{ "field.string": { name: "reference" } }],
        },
      },
      {
        "requirement.functional": {
          name: "orderReferenceIsStable",
          "@level": 5,
          "@status": "live",
          "@statement": "An order's reference never changes once issued",
          "@counterexample": "A reference rewritten by a later import",
          "@implementedBy": ["acme::shop::Order.reference"],
        },
      },
    ],
  },
};

describe("agent/ui.md", () => {
  test("documents only objects with a generated endpoint — never a sourceless value", async () => {
    const files = await emit(await load(MODEL));
    const ui = files.get("agent/ui.md");
    expect(ui).toBeDefined();
    expect(ui).toContain("acme::shop::Order");
    // The regression this replaces: gating on "has fields" put a prompt payload on the
    // page under a heading announcing an endpoint derived from its name — an address that
    // does not exist, stated as fact.
    expect(ui).not.toContain("OrderBlurbPayload");
    expect(ui).not.toContain("order_blurb_payloads");
  });

  test("names the control the FORM renders, and the enum is a dropdown", async () => {
    const ui = (await emit(await load(MODEL))).get("agent/ui.md") ?? "";
    expect(ui).toMatch(/\| `status` \|[^|]*\| `dropdown` \|/);
    expect(ui).toMatch(/\| `reference` \|[^|]*\| `text` \|/);
  });

  test("carries the three columns the descriptor does not: excluded, filter, sort", async () => {
    const ui = (await emit(await load(MODEL))).get("agent/ui.md") ?? "";
    // `internalNote` is form-excluded; `reference` is filterable and therefore sortable by
    // the documented default, which is the RESOLVED answer a caller needs.
    const noteRow = ui.split("\n").find((l) => l.startsWith("| `internalNote`")) ?? "";
    const refRow = ui.split("\n").find((l) => l.startsWith("| `reference`")) ?? "";
    expect(noteRow.split("|").map((c) => c.trim())).toContain("yes");
    expect(refRow.split("|").filter((c) => c.trim() === "yes").length).toBe(2);
  });

  test("renders the declared grid", async () => {
    const ui = (await emit(await load(MODEL))).get("agent/ui.md") ?? "";
    expect(ui).toContain("**Grid `default`**");
    expect(ui).toContain("default sort: `reference:desc`");
    expect(ui).toContain("page size: 25");
  });
});

describe("agent/requirements.md", () => {
  test("the node index keys a MEMBER claim by its full address, not the bare name", async () => {
    const page = (await emit(await load(MODEL))).get("agent/requirements.md") ?? "";
    expect(page).toContain("## Node index");
    // The literal FQN is the retrieval key. `Order.reference` alone would collide with
    // another package's Order in a multi-package model.
    expect(page).toContain("`acme::shop::Order.reference`");
    expect(page).toContain("`field.string`");
    expect(page).toContain("`orderReferenceIsStable` L5 (live)");
  });

  test("embeds the ledger WITHOUT a second H1, so the outline survives", async () => {
    const page = (await emit(await load(MODEL))).get("agent/requirements.md") ?? "";
    const h1s = page.split("\n").filter((l) => /^# /.test(l));
    expect(h1s).toEqual(["# Requirements"]);
    expect(page).toContain("## The ledger");
    // The entry nests UNDER that section rather than escaping it as a sibling.
    expect(page).toContain("### orderReferenceIsStable");
  });

  test("emits NO file for a model with no ledger — the on-by-default contract", async () => {
    const noLedger = {
      "metadata.root": {
        package: "acme::shop",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders" } },
                { "field.long": { name: "id" } },
              ],
            },
          },
        ],
      },
    };
    const files = await emit(await load(noLedger));
    expect(files.has("agent/requirements.md")).toBe(false);
  });
});

describe("agent/schema.md", () => {
  // A hand-built input rather than a real snapshot: the surface takes the physical schema
  // as an ARGUMENT precisely so codegen-ts owns none of it, and a test that reached for
  // migrate-ts would be asserting the dependency the design removed. The real snapshot is
  // exercised end-to-end by the CLI's docs-drift integration test.
  const column = (name: string, over: Partial<SchemaColumnLike> = {}): SchemaColumnLike => ({
    name,
    nullable: false,
    ...over,
  });
  const input = (over: Partial<AgentSchemaInput> = {}): AgentSchemaInput => ({
    dialect: "postgres",
    tables: [
      {
        name: "orders",
        columns: [column("id", { identity: "increment" }), column("reference")],
        indexes: [{ name: "orders_reference_uk", columns: ["reference"], unique: true }],
        foreignKeys: [],
        checks: [],
        primaryKey: ["id"],
      },
    ],
    views: [],
    provenance: new Map([["public.orders", "acme::shop::Order"]]),
    columnType: (c) => (c.name === "id" ? "BIGINT" : "VARCHAR(64)"),
    qualify: (o) => `${o.schema ?? "public"}.${o.name}`,
    ...over,
  });

  test("a composite unique is labelled composite — a bare `unique` here would be false", async () => {
    const composite = input({
      tables: [
        {
          name: "orders",
          columns: [column("id"), column("reference"), column("status")],
          indexes: [
            { name: "orders_ref_status_uk", columns: ["reference", "status"], unique: true },
          ],
          foreignKeys: [],
          checks: [],
          primaryKey: ["id"],
        },
      ],
    });
    const page = (await emit(await load(MODEL), { schema: composite })).get("agent/schema.md") ?? "";
    // `reference` alone is NOT unique. Saying it is sends a reader to write a lookup that
    // returns more than one row.
    const row = page.split("\n").find((l) => l.startsWith("| `reference`")) ?? "";
    expect(row).toContain("unique (composite)");
    expect(row).not.toMatch(/\| unique \|/);
    // A single-column unique still reads plainly.
    const single = (await emit(await load(MODEL), { schema: input() })).get("agent/schema.md") ?? "";
    expect(single.split("\n").find((l) => l.startsWith("| `reference`")) ?? "").toContain("| unique |");
  });

  test("names the declaring object and maps each column back to its field", async () => {
    const files = await emit(await load(MODEL), { schema: input() });
    const page = files.get("agent/schema.md") ?? "";
    expect(page).toContain("Declared by `acme::shop::Order`.");
    // The column→field mapping is the one thing the snapshot alone cannot supply, and it
    // is what an agent needs to go from a query it is reading to the metadata to edit.
    expect(page).toMatch(/\| `reference` \| `reference` \| `field.string` \| `VARCHAR\(64\)` \|/);
    expect(page).toContain("auto-increment");
    expect(page).toContain("orders_reference_uk");
  });

  test("nudges when the model declares no description — the highest-value content", async () => {
    const page = (await emit(await load(MODEL), { schema: input() })).get("agent/schema.md") ?? "";
    // The MODEL's `@description` lives on the entity, but this page reads descriptions off
    // the SNAPSHOT (where migrate threads them to emit COMMENT ON), and this hand-built
    // input carries none — so the nudge is correct here and its absence below proves it is
    // conditional rather than unconditional boilerplate.
    expect(page).toContain("Nothing in this model declares a `description`");

    const described = input({
      tables: [
        {
          name: "orders",
          description: "A customer's placed order.",
          columns: [column("id"), column("reference", { description: "The public order id." })],
          indexes: [],
          foreignKeys: [],
          checks: [],
          primaryKey: ["id"],
        },
      ],
    });
    const withDesc = (await emit(await load(MODEL), { schema: described })).get("agent/schema.md") ?? "";
    expect(withDesc).not.toContain("Nothing in this model declares a `description`");
    expect(withDesc).toContain("> A customer's placed order.");
    expect(withDesc).toContain("- `reference` — The public order id.");
  });

  test("cites the migrations instead of restating the DDL", async () => {
    const page = (await emit(await load(MODEL), { schema: input() })).get("agent/schema.md") ?? "";
    expect(page).toContain("The **DDL is not repeated here.**");
    expect(page).not.toContain("CREATE TABLE");
  });

  test("emits NO schema page when no schema is supplied", async () => {
    const files = await emit(await load(MODEL));
    expect(files.has("agent/schema.md")).toBe(false);
    // The other two still emit — a missing dialect must not take the whole surface down.
    expect(files.has("agent/ui.md")).toBe(true);
    expect(files.has("agent/requirements.md")).toBe(true);
  });

  test("renders nothing at all for an empty schema", () => {
    expect(renderAgentSchemaPage(input({ tables: [], views: [] }), {
      declaredBy: new Map(),
      viewLineage: new Map(),
      relationships: [],
      enums: [],
    })).toBe("");
  });
});
