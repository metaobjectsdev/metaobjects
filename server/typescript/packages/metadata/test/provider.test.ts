import { describe, it, expect } from "bun:test";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { coreTypesProvider, coreProviders, registerCoreTypes } from "../src/core-types.js";
import { dbProvider } from "../src/persistence/db/db-provider.js";
import { docProvider } from "../src/core/documentation/doc-provider.js";
import { promptProvider } from "../src/template/prompt-provider.js";
import { uiProvider } from "../src/presentation/ui/ui-provider.js";
import { uiWebProvider } from "../src/presentation/ui-web/ui-web-provider.js";
import { rulesProvider } from "../src/core/rules/rules-provider.js";
import { viewExpressionsProvider } from "../src/persistence/view-expressions/view-expressions-provider.js";
import { reportingProvider } from "../src/core/reporting/reporting-provider.js";
import { requirementsProvider } from "../src/core/requirement/requirements-provider.js";
import { TypeRegistry, TypeId } from "../src/registry.js";
import { MetaField } from "../src/core/field/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_METADATA,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRING,
} from "../src/index.js";

function recordingProvider(
  id: string,
  dependencies: string[],
  log: string[],
): MetaDataTypeProvider {
  return {
    id,
    dependencies,
    registerTypes() {
      log.push(id);
    },
  };
}

describe("composeRegistry — provider composition", () => {
  it("registers providers in dependency order", () => {
    const log: string[] = [];
    composeRegistry([
      recordingProvider("c", ["a", "b"], log),
      recordingProvider("a", [], log),
      recordingProvider("b", ["a"], log),
    ]);
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("keeps input order for independent providers", () => {
    const log: string[] = [];
    composeRegistry([
      recordingProvider("x", [], log),
      recordingProvider("y", [], log),
      recordingProvider("z", [], log),
    ]);
    expect(log).toEqual(["x", "y", "z"]);
  });

  it("throws on a dependency cycle", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([
        recordingProvider("p", ["q"], log),
        recordingProvider("q", ["p"], log),
      ]),
    ).toThrow(/cycle/);
  });

  it("throws on a missing dependency", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([recordingProvider("p", ["nonexistent"], log)]),
    ).toThrow(/nonexistent/);
  });

  it("throws on a duplicate provider id", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([
        recordingProvider("dup", [], log),
        recordingProvider("dup", [], log),
      ]),
    ).toThrow(/duplicate/);
  });

  it("returns a populated TypeRegistry", () => {
    const registry = composeRegistry([
      { id: "noop", registerTypes() {} },
    ]);
    expect(typeof registry.has).toBe("function");
  });
});

describe("coreTypesProvider", () => {
  it("composeRegistry(coreProviders) registers the core metamodel", () => {
    const registry = composeRegistry(coreProviders);
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
    expect(registry.has(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(true);
    expect(registry.has(TYPE_METADATA, SUBTYPE_ROOT)).toBe(true);
    expect(registry.defaultSubTypeOf(TYPE_METADATA)).toBe(SUBTYPE_ROOT);
  });

  it("coreProviders is a ten-provider bundle: coreTypesProvider + dbProvider + docProvider + promptProvider + uiProvider + uiWebProvider + rulesProvider + viewExpressionsProvider + reportingProvider + requirementsProvider", () => {
    // FR-033 S1-field-A re-homed the field's filter/sort/teaching/extract/storage
    // attrs out of core into the concern providers. promptProvider (renamed from
    // templateProvider; id metaobjects-prompt) carries @xmlText/@example/@instruction
    // + the field.enum extract attrs + the object.value @normalize default; uiProvider
    // (id metaobjects-ui) carries @filterable/@sortable/@sortableDefaultOrder/
    // @formExclude; uiWebProvider (TS-only; id metaobjects-ui-web) carries @rows
    // (view.textarea) + the view.image control attrs. All are part of the core
    // bundle so the cross-port registry manifest carries the same composed
    // vocabulary as before (byte-identical) — uiWebProvider's attrs land on
    // PresentationOnly-excluded rows, so the manifest itself is unaffected.
    // rulesProvider (metaobjects-rules) and viewExpressionsProvider
    // (metaobjects-view-expressions) are packs split out of core in 1.3.0; they are in
    // the default bundle so no model changes, and each can be composed out. So are
    // reportingProvider (metaobjects-reporting) and requirementsProvider
    // (metaobjects-requirements), split out the same way.
    expect(coreProviders).toHaveLength(10);
    expect(coreProviders[0]).toBe(coreTypesProvider);
    expect(coreProviders[1]).toBe(dbProvider);
    expect(coreProviders[2]).toBe(docProvider);
    expect(coreProviders[3]).toBe(promptProvider);
    expect(coreProviders[4]).toBe(uiProvider);
    expect(coreProviders[5]).toBe(uiWebProvider);
    expect(coreProviders[6]).toBe(rulesProvider);
    expect(coreProviders[7]).toBe(viewExpressionsProvider);
    expect(coreProviders[8]).toBe(reportingProvider);
    expect(coreProviders[9]).toBe(requirementsProvider);
  });

  it("registerCoreTypes registers the structural types but not the DB-domain attrs", () => {
    // registerCoreTypes is a thin wrapper over coreTypesProvider alone — it does
    // NOT include dbProvider. composeRegistry(coreProviders) is the full default
    // registry; it carries the DB-domain attrs (@dbColumn etc.) on top.
    const viaWrapper = new TypeRegistry();
    registerCoreTypes(viaWrapper);
    const viaProviders = composeRegistry(coreProviders);

    // dbProvider only extends and adds no types, so the only types composeRegistry adds
    // over core alone are the packs' (business rules, origin.function, reporting,
    // requirements).
    const packTypes = ["api", "operation", "binding", "transition", "dimension", "measure", "segment", "requirement"];
    const coreOnly = viaProviders.allTypes().filter(
      (t) =>
        !packTypes.includes(t.type) &&
        !(t.type === "origin" && t.subType === "function") &&
        !(t.type === "object" && t.subType === "report"),
    );
    expect(viaWrapper.allTypes().length).toBe(coreOnly.length);

    // But composeRegistry(coreProviders) carries strictly more attrs (the DB attrs).
    const sumAttrs = (reg: TypeRegistry): number =>
      reg.allTypes().reduce((n, t) => n + reg.attrsOf(t.type, t.subType).length, 0);
    expect(sumAttrs(viaProviders)).toBeGreaterThan(sumAttrs(viaWrapper));
  });
});

describe("composeRegistry — third-party provider integration", () => {
  it("a third-party provider can add a new subtype and extend a core type", () => {
    const geoProvider: MetaDataTypeProvider = {
      id: "geo-types",
      dependencies: ["metaobjects-core-types"],
      registerTypes(registry: TypeRegistry): void {
        // adds a brand-new field subtype
        registry.register({
          typeId: new TypeId(TYPE_FIELD, "geopoint"),
          description: "A geographic point field",
          factory: (typeId, name) => new MetaField(typeId, name),
          childRules: [],
          attributes: [],
        });
        // extends an existing core type
        registry.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {
          attributes: [
            { name: "geoSrid", valueType: ATTR_SUBTYPE_STRING, required: false, description: "spatial ref id" },
          ],
        });
      },
    };

    const registry = composeRegistry([...coreProviders, geoProvider]);

    // the new subtype is registered
    expect(registry.has(TYPE_FIELD, "geopoint")).toBe(true);
    // the core type still works AND carries the third-party extension
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
    expect(
      registry.attrsOf(TYPE_FIELD, FIELD_SUBTYPE_STRING).some((a) => a.name === "geoSrid"),
    ).toBe(true);
  });
});
