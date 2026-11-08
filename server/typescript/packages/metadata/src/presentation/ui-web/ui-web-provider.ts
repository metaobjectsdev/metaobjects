// uiWebProvider — web presentation view attrs. Extends view.textarea with
// @rows and registers the view.image control's five attrs
// (@aspectRatio/@maxEdge/@store/@accept/@maxBytes). These are presentation
// concerns, NOT core view properties, so they live here — mirroring the
// uiProvider / dbProvider / promptProvider pattern.
//
// Ruling R40 kind 1: this is cross-port vocabulary that only TypeScript
// implements so far (view.json marks the types `implementedIn: ["typescript"]`).
// Every port applies this provider, so every port loads these attrs strictly
// and ignores them; an unregistered attr on these views still fails.
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
    "Web presentation view attrs — @rows (view.textarea) and the view.image control attrs. Every port applies this provider and loads them strictly; only TypeScript acts on them so far (ruling R40 kind 1).",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, UI_WEB_DEFINITION, {});
  },
};
