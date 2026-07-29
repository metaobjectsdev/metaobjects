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
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";
import { TYPE_METADATA, SUBTYPE_ROOT } from "../src/shared/base-types.js";

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

// A reference descriptor's `targetType` is a free string, and the mechanism promises a
// downstream provider's references validate "present and future". This proves a reference
// to a NON-`object` node kind resolves — previously the symbol table indexed only objects,
// so a non-object `targetType` was silently unsatisfiable (every ref falsely "unresolved").
class AdapterNode extends MetaData {}
class ProbeNode extends MetaData {}

const adapterProvider: MetaDataTypeProvider = {
  id: "fake-adapters",
  description: "A downstream app's custom top-level adapter/probe vocabulary.",
  registerTypes(registry: TypeRegistry): void {
    registry.register({
      typeId: new TypeId("adapter", "http"),
      description: "A downstream-defined HTTP adapter (a non-object top-level node).",
      factory: (typeId, name) => new AdapterNode(typeId, name),
      childRules: [],
      attributes: [],
    });
    registry.register({
      typeId: new TypeId("probe", "ping"),
      description: "A probe that references an adapter by name.",
      factory: (typeId, name) => new ProbeNode(typeId, name),
      childRules: [],
      attributes: [],
      // The reference targets a NON-object type — the case the fix enables.
      references: [{ attr: "adapterRef", targetType: "adapter", errorCode: "ERR_PROBE_ADAPTER_UNRESOLVED" }],
    });
    // License both new top-level types under metadata.root (its child rules are closed).
    registry.extend(TYPE_METADATA, SUBTYPE_ROOT, {
      childRules: [
        { childType: "adapter", childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
        { childType: "probe", childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ],
    });
  },
};

describe("validation derived from the type registry — non-object reference targets (#194 item 2)", () => {
  it("a reference to a non-object top-level node RESOLVES (no false 'unresolved')", async () => {
    const registry = composeRegistry([...coreProviders, adapterProvider]);
    const model = `
metadata.root:
  package: app
  children:
    - adapter.http: { name: MainApi }
    - probe.ping: { name: HealthCheck, adapterRef: MainApi }
`;
    const loader = new MetaDataLoader({ registry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(model, { id: "app.yaml", format: "yaml" }),
    ]);
    const codes = errors.map((e) => (e as { code?: string }).code);
    expect(codes).not.toContain("ERR_PROBE_ADAPTER_UNRESOLVED");
  });

  it("a dangling non-object reference errors, naming the target kind", async () => {
    const registry = composeRegistry([...coreProviders, adapterProvider]);
    const model = `
metadata.root:
  package: app
  children:
    - adapter.http: { name: MainApi }
    - probe.ping: { name: HealthCheck, adapterRef: NoSuchAdapter }
`;
    const loader = new MetaDataLoader({ registry, strict: false });
    const { errors } = await loader.load([
      new InMemoryStringSource(model, { id: "app.yaml", format: "yaml" }),
    ]);
    expect(errors.map((e) => (e as { code?: string }).code)).toContain("ERR_PROBE_ADAPTER_UNRESOLVED");
    // The message names the target's own kind, not a hardcoded "object".
    expect(errors.some((e) => /does not resolve to a adapter/.test(e.message))).toBe(true);
  });
});
