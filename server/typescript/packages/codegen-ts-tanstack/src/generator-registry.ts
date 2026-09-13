// ADR-0021 D3 — this package's SLICE of the stable-name generator registry.
// See the react package's copy for why the catalog is composed rather than central.

import type { GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";
import { tanstackQuery } from "./tanstack-query.js";
import { tanstackGrid } from "./tanstack-grid.js";
import { tanstackGridHook } from "./tanstack-grid-hook.js";
import { REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";

/** True iff this package ships a copyable reference template for `name`. */
function ejectable(name: string): boolean {
  return (REFERENCE_GENERATOR_NAMES as readonly string[]).includes(name);
}

export const tanstackGeneratorRegistry: Record<string, GeneratorRegistryEntry> = {
  hooks: {
    name: "hooks",
    kind: "generator",
    layer: "client",
    description:
      "Per-entity TanStack Query hooks (useEntity / useEntities / useCreate / useUpdate / useDelete).",
    tier: "native",
    factory: () => tanstackQuery(),
    options: "filter?, target?",
    framework: "tanstack",
    requires: ["entity"],
    runtimePackages: ["@metaobjectsdev/runtime-web", "@metaobjectsdev/tanstack"],
    runtimePeers: ["@tanstack/react-query"],
    configKeys: ["extStyle", "clientDirective"],
    ejectable: ejectable("hooks"),
  },
  grid: {
    name: "grid",
    kind: "generator",
    layer: "client",
    description:
      "Per-entity TanStack Table column definitions, from a layout.dataGrid declaration.",
    tier: "native",
    factory: () => tanstackGrid(),
    options: "filter?, tphSubtypeGrids?, target?",
    framework: "tanstack",
    requires: ["entity"],
    runtimePeers: ["@tanstack/react-table"],
    configKeys: ["extStyle", "clientDirective"],
    ejectable: ejectable("grid"),
  },
  "grid-hook": {
    name: "grid-hook",
    kind: "generator",
    layer: "client",
    description:
      "Per-entity server-driven grid state hook (sort/filter/page) over the generated columns.",
    tier: "native",
    factory: () => tanstackGridHook(),
    options: "filter?, tphSubtypeGrids?, target?",
    framework: "tanstack",
    // `grid` is here because the emitted hook imports the columns module's filter
    // PRESET constants — an edge that only exists when a layout.dataGrid declares a
    // `filter`. Derived, not assumed: the probe fixture declares one precisely so this
    // edge is visible to the gate rather than left to prose.
    requires: ["entity", "grid", "hooks"],
    runtimePackages: ["@metaobjectsdev/runtime-web", "@metaobjectsdev/tanstack"],
    runtimePeers: ["@tanstack/react-query", "@tanstack/react-table", "react"],
    configKeys: ["extStyle", "clientDirective"],
    ejectable: ejectable("grid-hook"),
  },
};
