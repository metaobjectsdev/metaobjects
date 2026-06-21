// Phase 2 proof — validation RIDES IN ON TYPE REGISTRATION. A downstream provider registers
// a brand-new type AND its validation (reference descriptors + an imperative validator) on
// the same TypeDefinition. Composing it into the registry is all it takes — the loader
// derives validation from the registry, so the custom type validates itself with NO
// separate wiring and NO core edits. (R2)

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import type { MetaDataTypeProvider } from "../src/provider.js";
import { TypeId, type TypeRegistry, type TypeDefinition } from "../src/registry.js";
import { MetaData } from "../src/shared/meta-data.js";

// A concrete node class for the downstream type (MetaData itself is abstract).
class WidgetNode extends MetaData {}

// The fake downstream provider: it registers a new type `widget.gauge` AND its validation —
// a reference descriptor on @feeds + an imperative range rule — on the SAME TypeDefinition,
// using its OWN error codes.
const widgetProvider: MetaDataTypeProvider = {
  id: "fake-widgets",
  description: "A downstream app's custom widget vocabulary + its validation.",
  registerTypes(registry: TypeRegistry): void {
    const def: TypeDefinition = {
      typeId: new TypeId("widget", "gauge"),
      description: "A downstream-defined gauge widget.",
      factory: (typeId, name) => new WidgetNode(typeId, name),
      childRules: [],
      attributes: [],
      references: [{ attr: "feeds", targetType: "object", errorCode: "ERR_WIDGET_FEED_UNRESOLVED" }],
      validate: (node, ctx) => {
        const min = Number(node.ownAttr("rangeMin"));
        const max = Number(node.ownAttr("rangeMax"));
        if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
          ctx.error("ERR_WIDGET_RANGE", node, `gauge "${node.name}" rangeMin ${min} > rangeMax ${max}`);
        }
      },
    };
    registry.register(def);
  },
};

describe("validation derived from the type registry — downstream extensibility", () => {
  it("a custom type validates itself just by being registered (no separate wiring)", async () => {
    // Compose core + the downstream provider. That's the ONLY wiring.
    const registry = composeRegistry([...coreProviders, widgetProvider]);

    const model = `
metadata.root:
  package: app
  children:
    - object.entity:
        name: Dashboard
        children:
          - field.long: { name: id }
          - identity.primary: { fields: [id] }
          - widget.gauge:
              name: speed
              feeds: NoSuchEntity
              rangeMin: 10
              rangeMax: 1
`;
    const loader = new MetaDataLoader({ registry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(model, { id: "app.yaml", format: "yaml" }),
    ]);
    const codes = errors.map((e) => (e as { code?: string }).code);

    // The reference descriptor on the type caught the dangling @feeds...
    expect(codes).toContain("ERR_WIDGET_FEED_UNRESOLVED");
    // ...and the type's imperative validator caught the inverted range — both with the
    // provider's OWN codes, via the loader's registry-derived walk. No core edits.
    expect(codes).toContain("ERR_WIDGET_RANGE");
  });

  it("a valid custom widget produces no widget errors", async () => {
    const registry = composeRegistry([...coreProviders, widgetProvider]);
    const good = `
metadata.root:
  package: app
  children:
    - object.entity:
        name: Dashboard
        children:
          - field.long: { name: id }
          - identity.primary: { fields: [id] }
          - widget.gauge: { name: speed, feeds: Dashboard, rangeMin: 0, rangeMax: 100 }
`;
    const loader = new MetaDataLoader({ registry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(good, { id: "app.yaml", format: "yaml" }),
    ]);
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).not.toContain("ERR_WIDGET_FEED_UNRESOLVED");
    expect(codes).not.toContain("ERR_WIDGET_RANGE");
  });
});
