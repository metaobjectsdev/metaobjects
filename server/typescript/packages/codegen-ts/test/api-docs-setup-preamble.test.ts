// api-docs setup-preamble drift gate.
//
// The Setup preamble the api-docs render emits (api-doc-render.ts) names REAL
// runtime exports in PROSE — `drizzle`/`InMemoryProvider`/`Provider`/
// `loadDirectory`. Prose is not type-checked, so a future rename of one of these
// exports would silently make the preamble teach a hallucinated import. This
// test closes that last drift vector by asserting the referenced APIs actually
// exist (for the packages we own) and are change-detected (for the adopter-owned
// driver import), AND that the rendered preamble TEXT still names these exact
// symbols.

import { describe, test, expect } from "bun:test";
import { InMemoryProvider, type Provider } from "@metaobjectsdev/render";
import * as render from "@metaobjectsdev/render";
import { loadDirectory } from "@metaobjectsdev/metadata";
import * as metadata from "@metaobjectsdev/metadata";
import { drizzle } from "drizzle-orm/node-postgres";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel } from "../src/generators/api-model.js";
import { renderAgentApi, renderEntityApiPage } from "../src/generators/api-doc-render.js";
import { frameworkTemplatesProvider } from "../src/render-engine/framework-provider.js";

describe("setup-preamble: the runtime exports it names actually exist", () => {
  // --- @metaobjectsdev/render: InMemoryProvider (value) + Provider (type) ---
  test("`InMemoryProvider` is a constructable class the preamble can `new`", () => {
    expect(typeof InMemoryProvider).toBe("function");
    // The preamble shows `new InMemoryProvider({ ... })` — prove it constructs.
    const p = new InMemoryProvider({ "group/source": "Hello {{name}}" });
    expect(p).toBeInstanceOf(InMemoryProvider);
    // And `InMemoryProvider` is the symbol the package surface exposes.
    expect("InMemoryProvider" in render).toBe(true);
  });

  test("`Provider` is a real (type-level) export of @metaobjectsdev/render", () => {
    // `Provider` is a TYPE export, so it has no runtime value. Bind a value to it
    // — this only compiles if the type is actually exported; a rename/removal is
    // a build-time failure (tsc gate), which is exactly the drift we want caught.
    const provider: Provider = new InMemoryProvider({ "group/source": "x" });
    expect(provider).toBeDefined();
  });

  // --- @metaobjectsdev/metadata: loadDirectory (and NOT loadMemory) ---
  test("`loadDirectory` is a function the preamble can call", () => {
    expect(typeof loadDirectory).toBe("function");
    expect("loadDirectory" in metadata).toBe(true);
  });

  test("there is NO `loadMemory` export — the preamble cannot regress to it", () => {
    expect("loadMemory" in metadata).toBe(false);
    expect((metadata as Record<string, unknown>).loadMemory).toBeUndefined();
  });

  // --- drizzle-orm/node-postgres: drizzle (adopter-owned driver, resolvable as
  //     a devDependency of codegen-ts, so we can verify the export too) ---
  test("`drizzle` (drizzle-orm/node-postgres) is a callable factory", () => {
    expect(typeof drizzle).toBe("function");
  });
});

describe("setup-preamble: the rendered TEXT names these exact symbols (change-detected)", () => {
  // A minimal model that exercises all three setup handles (db via the entity
  // CRUD example, provider + root via the template extractor/render example).
  const CHILDREN = [
    {
      "object.entity": {
        name: "Widget",
        children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: "name" } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          { "source.rdb": { "@table": "widgets" } },
        ],
      },
    },
    {
      "object.value": {
        name: "WidgetVO",
        children: [{ "field.string": { name: "headline", "@required": true } }],
      },
    },
    {
      "template.output": {
        name: "WidgetSummary",
        "@kind": "document",
        "@payloadRef": "WidgetVO",
        "@textRef": "out/widget-summary",
        "@format": "json",
      },
    },
  ];

  async function load() {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({ "metadata.root": { package: "acme::shop", children: CHILDREN } }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    return buildApiModel(res.root, { loadedRoot: res.root });
  }

  test("agent preamble references drizzle / InMemoryProvider / loadDirectory by their real names", async () => {
    const model = await load();
    const out = renderAgentApi(model, frameworkTemplatesProvider);
    // db handle — adopter-owned driver import, change-detected against this test.
    expect(out).toContain(`import { drizzle } from "drizzle-orm/node-postgres"`);
    expect(out).toContain(`drizzle(`);
    // provider handle — owned export.
    expect(out).toContain(`import { InMemoryProvider } from "@metaobjectsdev/render"`);
    // root handle — owned export; must be loadDirectory, never loadMemory.
    expect(out).toContain(`import { loadDirectory } from "@metaobjectsdev/metadata"`);
    expect(out).not.toContain("loadMemory");
  });

  test("per-unit human page preamble references the same real export names", async () => {
    const model = await load();
    const widget = model.units.find((u) => u.node === "Widget")!;
    const page = renderEntityApiPage(widget, frameworkTemplatesProvider);
    // The Widget entity example uses `db`, so its page carries the db handle.
    expect(page).toContain(`import { drizzle } from "drizzle-orm/node-postgres"`);
    expect(page).toContain(`drizzle(`);
    expect(page).not.toContain("loadMemory");
  });
});
