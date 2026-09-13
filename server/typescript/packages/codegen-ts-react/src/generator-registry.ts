// ADR-0021 D3 — this package's SLICE of the stable-name generator registry.
//
// `codegen-ts` owns the entry type and the framework-neutral + server-side entries, but
// it cannot import this package (dependency direction), so the React client-tier
// generator registers itself here and the CLI unions the three slices
// (`cli/src/lib/catalog.ts`). Before this existed, `meta gen --list` and
// `meta eject --list` read two different tables and gave an agent two different answers
// to "what can I turn on".

import type { GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";
import { formFile } from "./form-file.js";
import { REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";

/** True iff this package ships a copyable reference template for `name`. */
function ejectable(name: string): boolean {
  return (REFERENCE_GENERATOR_NAMES as readonly string[]).includes(name);
}

export const reactGeneratorRegistry: Record<string, GeneratorRegistryEntry> = {
  form: {
    name: "form",
    kind: "generator",
    layer: "client",
    description: "Per-entity React form component over the generated Zod schema.",
    tier: "native",
    factory: () => formFile(),
    options: "filter?, target?",
    // `react`, not "the client framework": `@metaobjectsdev/tanstack` declares `react`
    // as a peer, so form (react) + hooks/grid (tanstack) is the intended composition,
    // NOT a conflict. Framework exclusivity is advisory and only on the `api` layer.
    framework: "react",
    ejectable: ejectable("form"),
  },
};
