// FR-033 S3 — the full set of embedded ProviderDefinitions, in one place.
//
// Provenance (which of the concern providers owns/contributes each type/attr)
// is NOT carried on the composed registry — it is flattened away when providers
// register. The embedded definition modules ARE the source of that fact: each
// `ProviderDefinition.provider` says who declared it, its `types[]` say which
// `type.subType`s it registers (owns), and its `extends[]` say which attrs it
// contributes to types another provider owns. This module re-exports every
// embedded definition as one list so the provenance builder can walk them
// without each consumer re-importing all fifteen.

import type { ProviderDefinition } from "../provider-data.js";
import { FIELD_DEFINITION } from "../core/field/field-definition.embedded.js";
import { OBJECT_DEFINITION } from "../core/object/object-definition.embedded.js";
import { ATTR_DEFINITION } from "../core/attr/attr-definition.embedded.js";
import { VALIDATOR_DEFINITION } from "../core/validator/validator-definition.embedded.js";
import { IDENTITY_DEFINITION } from "../core/identity/identity-definition.embedded.js";
import { RELATIONSHIP_DEFINITION } from "../core/relationship/relationship-definition.embedded.js";
import { DOCUMENTATION_DEFINITION } from "../core/documentation/documentation-definition.embedded.js";
import { ORIGIN_DEFINITION } from "../persistence/origin/origin-definition.embedded.js";
import { SOURCE_DEFINITION } from "../persistence/source/source-definition.embedded.js";
import { DB_DEFINITION } from "../persistence/db/db-definition.embedded.js";
import { VIEW_DEFINITION } from "../presentation/view/view-definition.embedded.js";
import { LAYOUT_DEFINITION } from "../presentation/layout/layout-definition.embedded.js";
import { UI_DEFINITION } from "../presentation/ui/ui-definition.embedded.js";
import { UI_WEB_DEFINITION } from "../presentation/ui-web/ui-web-definition.embedded.js";
import { TEMPLATE_DEFINITION } from "../template/template-definition.embedded.js";
import { PROMPT_DEFINITION } from "../template/prompt-definition.embedded.js";

/**
 * Every embedded provider definition the core metamodel composes from. The
 * order is irrelevant — the provenance builder keys by `(type.subType, attr)`,
 * and the registry is the authority on what is actually registered.
 */
export const ALL_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  FIELD_DEFINITION,
  OBJECT_DEFINITION,
  ATTR_DEFINITION,
  VALIDATOR_DEFINITION,
  IDENTITY_DEFINITION,
  RELATIONSHIP_DEFINITION,
  DOCUMENTATION_DEFINITION,
  ORIGIN_DEFINITION,
  SOURCE_DEFINITION,
  DB_DEFINITION,
  VIEW_DEFINITION,
  LAYOUT_DEFINITION,
  UI_DEFINITION,
  UI_WEB_DEFINITION,
  TEMPLATE_DEFINITION,
  PROMPT_DEFINITION,
];
