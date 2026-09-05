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
    // Asserted PER CELL. "the row contains a yes somewhere" passes when the flag landed in
    // the wrong column — and Excluded means the opposite of Filter/Sort, so a swap is
    // exactly the mistake worth catching.
    // `internalNote` is form-excluded and neither filterable nor sortable; `reference` is
    // filterable and therefore sortable by the documented default, which is the RESOLVED
    // answer a caller needs.
    const cellsOf = (name: string): string[] => {
      const row = ui.split("\n").find((l) => l.startsWith(`| \`${name}\``)) ?? "";
      return row.split("|").map((c) => c.trim());
    };
    // [ "", field, label, control, htmlType, rules, excluded, filter, sort, "" ]
    const note = cellsOf("internalNote");
    expect([note[6], note[7], note[8]]).toEqual(["yes", "", ""]);
    const ref = cellsOf("reference");
    expect([ref[6], ref[7], ref[8]]).toEqual(["", "yes", "yes"]);
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
    // ASSERT THE ROW, not the token. The embedded ledger under this index prints
    // `acme::shop::Order.reference` too (requirements-markdown renders every claim with
    // its dotted path), so a `toContain` on the address alone passes even if `nodeAddress`
    // regressed to the bare name — the one thing this index exists to get right. The
    // literal FQN is the retrieval key: `Order.reference` alone would collide with another
    // package's Order in a multi-package model.
    const row = page.split("\n").find((l) => l.startsWith("| `acme::shop::Order.reference`"));
    expect(row).toBeDefined();
    expect(row).toBe("| `acme::shop::Order.reference` | `field.string` | `orderReferenceIsStable` L5 (live) |");
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
    // The negative alone cannot fail — no input makes this renderer emit DDL. Pinned WITH
    // the positive half, so the pair says "it described the table AND did not restate the
    // statement", which is the property, and a renderer that emitted nothing at all would
    // now fail rather than pass on the absence.
    expect(page).toContain("The **DDL is not repeated here.**");
    expect(page).toContain("### `orders`");
    expect(page).toMatch(/\| `reference` \| `reference` \|/);
    expect(page).not.toContain("CREATE TABLE");
    expect(page).not.toContain("ALTER TABLE");
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

// A model exercising the shapes whose ENDPOINT, CONTROL or SCHEMA claim the page used to
// state wrongly: a TPH hierarchy (mounted under its base, never at its own name), a
// multi-word projection (mounted kebab-cased, not snake-cased), a `field.object`
// (rendered as a nested sub-form, not an input), a sourceless value carrying an enum (no
// column anywhere), and two relationships whose cardinality reads in opposite directions.
const SHAPES = {
  "metadata.root": {
    package: "acme::fleet",
    children: [
      {
        "object.entity": {
          name: "Owner",
          children: [
            { "source.rdb": { "@table": "owners" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "name", "@required": true } },
            { "field.enum": { name: "tier", "@values": ["standard", "fleet"] } },
            {
              "relationship.aggregation": {
                name: "vehicles", "@cardinality": "many", "@objectRef": "Vehicle",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Vehicle",
          "@discriminator": "kind",
          children: [
            { "source.rdb": { "@table": "vehicles" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "kind", "@required": true } },
            { "field.long": { name: "ownerId" } },
            { "identity.reference": { name: "ownerRef", "@fields": "ownerId", "@references": "Owner" } },
            {
              "relationship.association": {
                name: "owner", "@cardinality": "one", "@objectRef": "Owner",
              },
            },
            { "field.object": { name: "registeredTo", "@objectRef": "acme::fleet::Party" } },
            { "field.object": { name: "prior", isArray: true, "@objectRef": "acme::fleet::Party" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Car",
          extends: "Vehicle",
          "@discriminatorValue": "Car",
          children: [{ "field.int": { name: "doors" } }],
        },
      },
      // A sourceless value: it has no column anywhere, so its enum must not appear under
      // the schema page's Enums section, and it has no endpoint so it is not on ui.md.
      {
        "object.value": {
          name: "Party",
          children: [
            { "field.string": { name: "name" } },
            { "field.enum": { name: "kind", "@values": ["person", "company"] } },
          ],
        },
      },
      {
        "object.projection": {
          name: "OwnerSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_owner_summary" } },
            { "field.long": { name: "id", extends: "Owner.id" } },
            { "identity.primary": { name: "pk", extends: "Owner.pk" } },
            {
              "field.string": {
                name: "name",
                children: [{ "origin.passthrough": { "@from": "Owner.name" } }],
              },
            },
          ],
        },
      },
    ],
  },
};

describe("agent/ui.md — the endpoint it prints", () => {
  test("a TPH subtype is documented at the path the routes MOUNT it at", async () => {
    const ui = (await emit(await load(SHAPES))).get("agent/ui.md") ?? "";
    // `routes-file.ts` mounts the hierarchy from the BASE: the union at `Vehicle.$path`
    // and each subtype at `<base>/<lowercased @discriminatorValue>`. `Car` has no routes
    // file of its own, so `/cars` — its own `$path` — is an address nothing serves.
    expect(ui).toContain("Endpoint `/vehicles/car`.");
    expect(ui).not.toContain("`/cars`");
  });

  test("a TPH discriminator BASE is documented as having no form, not as writable", async () => {
    const ui = (await emit(await load(SHAPES))).get("agent/ui.md") ?? "";
    // `Vehicle` has a writable source and a write endpoint, and still gets NO form: the
    // form generator skips a discriminator base outright (you cannot create a base) and
    // the polymorphic mount is read-only by construction. Asking `servesWriteApi` here
    // announced a form for it. Its subtype `Car` DOES get one.
    expect(ui).toContain(
      "Endpoint `/vehicles` — **no form is generated** for a discriminator base; " +
        "each concrete subtype below has its own.",
    );
    expect(ui).toContain("Endpoint `/vehicles/car`.");
    // A read-only projection keeps its own reason.
    expect(ui).toContain("Endpoint `/owner-summaries` — **no form is generated** (read-only).");
  });

  test("a multi-word projection is documented KEBAB-cased, as its const emits it", async () => {
    const ui = (await emit(await load(SHAPES))).get("agent/ui.md") ?? "";
    // `renderProjectionDecl` emits `$path: "/owner-summaries"` and the read-only routes
    // mount `OwnerSummary.$path`. The snake-cased entity spelling is a different address.
    expect(ui).toContain("Endpoint `/owner-summaries`");
    expect(ui).not.toContain("/owner_summaries");
  });
});

describe("agent/ui.md — the control it prints", () => {
  test("a resolvable `field.object` is a nested sub-form, never a text input", async () => {
    const ui = (await emit(await load(SHAPES))).get("agent/ui.md") ?? "";
    const cells = (name: string): string[] =>
      (ui.split("\n").find((l) => l.startsWith(`| \`${name}\``)) ?? "").split("|").map((c) => c.trim());
    // The form generator recurses into `Party` as a <fieldset> and emits no input at all,
    // so the field's view kind (`text`, the subtype fallback) is not the control.
    expect(cells("registeredTo")[3]).toBe("nested sub-form");
    expect(cells("prior")[3]).toBe("nested sub-form (repeatable)");
    // And no HTML input type, because there is no <input>.
    expect(cells("registeredTo")[4]).toBe("");
    expect(ui).toContain("- `registeredTo` — expands `Party`.");
    expect(ui).toContain("- `prior` — expands `Party`, one group per element.");
  });
});

describe("agent/schema.md — the claims it makes about the model", () => {
  // The snapshot the fleet model produces, hand-built for the same reason the one above
  // is: this surface takes the physical schema as an ARGUMENT so codegen-ts owns none of
  // it. `owners` and `vehicles` are tables; `v_owner_summary` is a view. `Party` is in the
  // model and in NO table, which is the point.
  const fleetSchema = (): AgentSchemaInput => ({
    dialect: "postgres",
    tables: [
      {
        name: "owners",
        columns: [
          { name: "id", nullable: false, identity: "increment" },
          { name: "name", nullable: false },
          { name: "tier", nullable: true },
        ],
        indexes: [],
        foreignKeys: [],
        checks: [{ name: "owners_tier_check", expression: "tier IN ('standard','fleet')" }],
        primaryKey: ["id"],
      },
      {
        name: "vehicles",
        columns: [
          { name: "id", nullable: false, identity: "increment" },
          { name: "kind", nullable: false },
          { name: "owner_id", nullable: true },
          { name: "doors", nullable: true },
        ],
        indexes: [],
        foreignKeys: [
          { name: "vehicles_owner_fk", columns: ["owner_id"], refTable: "owners", refColumns: ["id"] },
        ],
        checks: [],
        primaryKey: ["id"],
      },
    ],
    views: [{ name: "v_owner_summary" }],
    provenance: new Map([
      ["public.owners", "acme::fleet::Owner"],
      ["public.vehicles", "acme::fleet::Vehicle"],
      ["public.v_owner_summary", "acme::fleet::OwnerSummary"],
    ]),
    columnType: () => "TEXT",
    qualify: (o) => `${o.schema ?? "public"}.${o.name}`,
  });

  test("the Enums section covers only enums the physical schema HOLDS", async () => {
    const page = (await emit(await load(SHAPES), { schema: fleetSchema() })).get("agent/schema.md") ?? "";
    // `Owner.tier` is a real column on a real table.
    expect(page).toContain("| `acme::fleet::Owner.tier` |");
    // `Party` is a sourceless `object.value`: it has no column anywhere, so a row for it
    // on the page that describes the DATABASE asserts a column that does not exist. The
    // walk used to cover every loaded object — abstracts and projections included.
    expect(page).not.toContain("acme::fleet::Party.kind");
  });

  test("the Enums section does not promise a CHECK the database may not carry", async () => {
    const page = (await emit(await load(SHAPES), { schema: fleetSchema() })).get("agent/schema.md") ?? "";
    // The old copy said flatly "The column carries a `CHECK`, so a value outside the set
    // is refused by the database" — untrue for an `@isArray` enum (migrate skips it) and
    // for a view column, and a SECOND derivation of `table.checks`, which is on the page
    // already and is the truth.
    expect(page).not.toContain("so a value outside the set is refused by the database");
    expect(page).toContain("that table's **Checks** above");
    expect(page).toContain("- `owners_tier_check`");
  });

  test("cardinality reads from the DECLARING side — `one` is many-to-one, never one-to-one", async () => {
    const page = (await emit(await load(SHAPES), { schema: fleetSchema() })).get("agent/schema.md") ?? "";
    // `@cardinality: one` means THIS entity holds the FK: many vehicles → one owner. The
    // old label said one-to-one, which is the direction that makes a reader write a lookup
    // expecting a single vehicle per owner.
    expect(page).toContain("- `acme::fleet::Vehicle.owner` · `association` · many-to-one → `Owner`");
    expect(page).toContain("- `acme::fleet::Owner.vehicles` · `aggregation` · one-to-many → `Vehicle`");
    expect(page).not.toContain("one-to-one");
  });

  test("a view carries its `origin.*` lineage, which is what makes it a derived artifact", async () => {
    const page = (await emit(await load(SHAPES), { schema: fleetSchema() })).get("agent/schema.md") ?? "";
    expect(page).toContain("## Views");
    expect(page).toContain("### `v_owner_summary`");
    expect(page).toContain("Declared by `acme::fleet::OwnerSummary`.");
    expect(page).toContain("| `name` | passthrough from `Owner.name` |");
  });
});
