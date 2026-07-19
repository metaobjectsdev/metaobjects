// uiWebProvider — TS-web presentation view attrs. Extends view.textarea with
// @rows and registers the view.image control's five attrs
// (@aspectRatio/@maxEdge/@store/@accept/@maxBytes). These are TS-web
// presentation-only concerns, NOT core view properties, so they live here —
// mirroring the uiProvider / dbProvider / promptProvider pattern.
//
// The non-TS ports commit a byte-identical mirror of spec/metamodel/ui-web.json
// (Step 4) for the embed drift gates, but NEVER apply this provider — the
// view.textarea/view.image control attrs are TS-web presentation-only.
//
// FR-033-style: the attrs + their descriptions are DATA — read from
// spec/metamodel/ui-web.json (embedded as UI_WEB_DEFINITION) via the unified
// applyProviderDefinition apply path's `extends` handling. The provider
// declares no new types, so the factory map is empty.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { applyProviderDefinition } from "../../provider-data.js";
import { UI_WEB_DEFINITION } from "./ui-web-definition.embedded.js";

export const uiWebProvider: MetaDataTypeProvider = {
  id: "metaobjects-ui-web",
  dependencies: ["metaobjects-core-types"],
  description:
    "TS-web presentation view attrs — @rows (view.textarea) and the view.image control attrs. Applied only in TypeScript; the non-TS ports mirror the spec file but never apply this provider (the view subtypes are TS-web presentation-only).",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, UI_WEB_DEFINITION, {});
  },
};
