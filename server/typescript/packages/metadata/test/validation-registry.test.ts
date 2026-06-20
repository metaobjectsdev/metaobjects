// Phase 2 prototype proof — a DOWNSTREAM provider registers a brand-new type the core
// knows nothing about, plus its declarative reference descriptor AND its imperative
// validator, and the SAME validation walk validates it. No core edits. (R2)

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import type { MetaDataTypeProvider } from "../src/provider.js";
import { TypeId, type TypeRegistry, type TypeDefinition } from "../src/registry.js";
import { MetaData } from "../src/shared/meta-data.js";
import { defaultValidationRegistry } from "../src/loader/validation-registry.js";

// A concrete node class for the downstream type (MetaData itself is abstract).
class WidgetNode extends MetaData {}

// The fake downstream provider: it teaches the registry a new type, `widget.gauge`.
const widgetProvider: MetaDataTypeProvider = {
  id: "fake-widgets",
  description: "A downstream app's custom widget vocabulary.",
  registerTypes(registry: TypeRegistry): void {
    const def: TypeDefinition = {
      typeId: new TypeId("widget", "gauge"),
      description: "A downstream-defined gauge widget.",
      factory: (typeId, name) => new WidgetNode(typeId, name),
      childRules: [],
      attributes: [],
    };
    registry.register(def);
  },
};

const MODEL = `
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

describe("validation registry — downstream provider extensibility", () => {
  it("validates a custom type's reference AND imperative rule, with no core changes", async () => {
    // (1) Type vocabulary: core providers + the downstream widget provider.
    const registry = composeRegistry([...coreProviders, widgetProvider]);

    // (2) Validation: core reference descriptors + the widget's OWN descriptor + validator,
    //     all registered by the (fake) downstream side — using its own error codes.
    const validationRegistry = defaultValidationRegistry()
      .registerReference("widget", "gauge", {
        attr: "feeds",
        targetType: "object",
        errorCode: "ERR_WIDGET_FEED_UNRESOLVED",
      })
      .registerValidator("widget", "gauge", (node, ctx) => {
        const min = Number(node.ownAttr("rangeMin"));
        const max = Number(node.ownAttr("rangeMax"));
        if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
          ctx.error("ERR_WIDGET_RANGE", node, `gauge "${node.name}" rangeMin ${min} > rangeMax ${max}`);
        }
      });

    const loader = new MetaDataLoader({ registry, validationRegistry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(MODEL, { id: "app.yaml", format: "yaml" }),
    ]);
    const codes = errors.map((e) => (e as { code?: string }).code);

    // The declarative reference descriptor caught the dangling @feeds...
    expect(codes).toContain("ERR_WIDGET_FEED_UNRESOLVED");
    // ...and the imperative validator caught the inverted range — both for a type core
    // has never heard of, via the same recursive root.validate(ctx) walk.
    expect(codes).toContain("ERR_WIDGET_RANGE");
  });

  it("a valid custom widget produces no widget errors", async () => {
    const registry = composeRegistry([...coreProviders, widgetProvider]);
    const validationRegistry = defaultValidationRegistry()
      .registerReference("widget", "gauge", {
        attr: "feeds",
        targetType: "object",
        errorCode: "ERR_WIDGET_FEED_UNRESOLVED",
      })
      .registerValidator("widget", "gauge", (node, ctx) => {
        const min = Number(node.ownAttr("rangeMin"));
        const max = Number(node.ownAttr("rangeMax"));
        if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
          ctx.error("ERR_WIDGET_RANGE", node, "bad range");
        }
      });

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
    const loader = new MetaDataLoader({ registry, validationRegistry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(good, { id: "app.yaml", format: "yaml" }),
    ]);
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).not.toContain("ERR_WIDGET_FEED_UNRESOLVED");  // feeds -> Dashboard resolves
    expect(codes).not.toContain("ERR_WIDGET_RANGE");            // 0 <= 100
  });
});
