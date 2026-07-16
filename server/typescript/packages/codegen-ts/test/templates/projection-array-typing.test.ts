// Issue #204 — a projection (view) field bound to a base array / jsonb column via
// `extends` must carry the base field's `isArray` / `storage:jsonb` through into
// BOTH the Drizzle `.existing()` view column AND the Zod read schema, so the two
// agree with each other and with the Kotlin port. Before the fix, projection-decl
// dropped `.array()` from the view column (it extracted only `.notNull()` from the
// column modifiers) and never array-wrapped the Zod scalar line — so a `text[]`
// column generated as scalar `text(...)` / `z.string()`.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderProjectionDecl } from "../../src/templates/projection-decl.js";

/** Base entity with an array column + a projection that binds it via extends. */
async function renderArrayProjection(dialect: "postgres" | "sqlite"): Promise<string> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Widget",
            children: [
              { "source.rdb": { "@table": "widgets" } },
              { "field.int": { name: "id" } },
              // text[] column (scalar array).
              { "field.string": { name: "conditions", isArray: true } },
              { "identity.primary": { name: "id", "@fields": "id" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "WidgetView",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_widget" } },
              { "field.int": { name: "id", extends: "Widget.id" } },
              // Pure-extends passthrough of the array column (the #204 shape).
              { "field.string": { name: "conditions", extends: "Widget.conditions" } },
              { "identity.primary": { name: "id", extends: "Widget.id" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const projection = result.root.objects().find((o) => o.name === "WidgetView")!;
  return renderProjectionDecl(projection, result.root, { columnNamingStrategy: "snake_case", dialect });
}

/** The single line declaring `conditions` in the emitted section (view col or zod). */
function lineFor(out: string, field: string, afterMarker: string): string {
  const section = out.split(afterMarker)[1] ?? "";
  return section.split("\n").find((l) => l.includes(`${field}:`))?.trim() ?? "";
}

describe("#204 — projection array field carries isArray through extends (postgres)", () => {
  test("Drizzle view column emits .array() for a text[] passthrough", async () => {
    const out = await renderArrayProjection("postgres");
    // The view column line: `conditions: text("conditions").array()`.
    const viewLine = lineFor(out, "conditions", "View = ");
    expect(viewLine).toContain(".array()");
  });

  test("Zod read schema array-wraps the scalar column", async () => {
    const out = await renderArrayProjection("postgres");
    const zodLine = lineFor(out, "conditions", "Schema = z.object({");
    expect(zodLine).toMatch(/z\.array\(z\.string\(\)\)/);
  });
});

describe("#204 — projection array field carries isArray through extends (sqlite)", () => {
  test("Drizzle view column narrows to string[] via $type (sqlite json array)", async () => {
    const out = await renderArrayProjection("sqlite");
    const viewLine = lineFor(out, "conditions", "View = ");
    // SQLite has no native array; the array-ness rides a `.$type<string[]>()`.
    expect(viewLine).toContain("$type<string[]>()");
  });

  test("Zod read schema array-wraps the scalar column", async () => {
    const out = await renderArrayProjection("sqlite");
    const zodLine = lineFor(out, "conditions", "Schema = z.object({");
    expect(zodLine).toMatch(/z\.array\(z\.string\(\)\)/);
  });
});

// The jsonb / objectRef half of #204: an extends-bound `field.object` passthrough
// resolves its @objectRef + storage through extends (prior super-resolution work),
// so the Drizzle view column and the Zod read schema AGREE — jsonb().$type<VO>()
// and <VO>InsertSchema, never scalar `string`. Regression guard.
describe("#204 — projection field.object jsonb passthrough agrees across Drizzle + Zod", () => {
  async function renderJsonbProjection(): Promise<string> {
    const json = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Profile", children: [{ "field.string": { name: "tier" } }] } },
          {
            "object.entity": {
              name: "Widget",
              children: [
                { "source.rdb": { "@table": "widgets" } },
                { "field.int": { name: "id" } },
                { "field.object": { name: "profile", "@objectRef": "Profile", "@storage": "jsonb" } },
                { "identity.primary": { name: "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.projection": {
              name: "WidgetView",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_widget" } },
                { "field.int": { name: "id", extends: "Widget.id" } },
                { "field.object": { name: "profile", extends: "Widget.profile" } },
                { "identity.primary": { name: "id", extends: "Widget.id" } },
              ],
            },
          },
        ],
      },
    });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
    const projection = result.root.objects().find((o) => o.name === "WidgetView")!;
    return renderProjectionDecl(projection, result.root, { columnNamingStrategy: "snake_case", dialect: "postgres" });
  }

  test("Drizzle view column is jsonb().$type<Profile>(), NOT scalar", async () => {
    const out = await renderJsonbProjection();
    const viewLine = lineFor(out, "profile", "View = ");
    expect(viewLine).toContain("jsonb(");
    expect(viewLine).toContain("$type<Profile>()");
  });

  test("Zod read schema is the VO schema, NOT z.string()", async () => {
    const out = await renderJsonbProjection();
    const zodLine = lineFor(out, "profile", "Schema = z.object({");
    expect(zodLine).toContain("ProfileInsertSchema");
    expect(zodLine).not.toContain("z.string()");
  });
});
