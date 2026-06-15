// promptProvider — the prompt / AI + serialization MetaDataTypeProvider
// (FR-004/006/010/011). EXTENDS the core-registered field types with the
// AI-domain markers that are NOT core field properties:
//   - every field subtype: @xmlText (XML text-content extract), @example,
//     @instruction (FR-010 field-teaching prompt fragment);
//   - field.enum only: @enumAlias / @enumDoc / @coerceDefault / @normalize
//     (FR-010/FR-011 tolerant-extract overlays);
//   - object.value only: @normalize (the object-level default normalization mode
//     for its enum fields' tolerant extract).
//
// FR-033 S1.5-B: the attrs + their descriptions are now DATA — read from
// spec/metamodel/prompt.json (embedded as PROMPT_DEFINITION) via the unified
// applyProviderDefinition apply path's `extends` handling. The provider declares
// no new types, so the factory map is empty.

import type { MetaDataTypeProvider } from "../provider.js";
import type { TypeRegistry } from "../registry.js";
import { applyProviderDefinition } from "../provider-data.js";
import { PROMPT_DEFINITION } from "./prompt-definition.embedded.js";

export const promptProvider: MetaDataTypeProvider = {
  id: "metaobjects-prompt",
  dependencies: ["metaobjects-core-types"],
  description:
    "Prompt / AI + serialization domain — @xmlText / @example / @instruction field markers on every field subtype, the @enumAlias/@enumDoc/@coerceDefault/@normalize tolerant-extract overlays on field.enum, and the object-level @normalize default on object.value.",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, PROMPT_DEFINITION, {});
  },
};
