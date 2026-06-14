// UI-domain attribute schemas — registered by uiProvider (ui-provider.ts), the
// presentation + query-surface concern. The @filterable/@sortable/
// @sortableDefaultOrder field markers drive the generated CRUD filter + sort
// allowlists (Project D). FR-033 S1-field-A re-homes them out of the core field
// definition into this concern provider; the descriptions are copied VERBATIM
// from spec/metamodel/field.json so the composed registry manifest stays
// byte-identical.

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_BOOLEAN,
} from "../../core/attr/attr-constants.js";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
} from "../../core/field/field-constants.js";

/** Sort directions for @sortableDefaultOrder (verbatim from field.json allowedValues). */
const SORT_ORDER_ASC = "asc";
const SORT_ORDER_DESC = "desc";

/** `@filterable` — exposed in generated CRUD filter allowlists; on every field subtype. */
export const filterableSchema: AttrSchema = {
  name: FIELD_ATTR_FILTERABLE,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer).",
};

/** `@sortable` — exposed in generated CRUD sort allowlists; on every field subtype. */
export const sortableSchema: AttrSchema = {
  name: FIELD_ATTR_SORTABLE,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out.",
};

/** `@sortableDefaultOrder` — default sort direction; on every field subtype. */
export const sortableDefaultOrderSchema: AttrSchema = {
  name: FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [SORT_ORDER_ASC, SORT_ORDER_DESC],
  description:
    "Default sort direction applied when this field is the default sort field.",
};

/** The three UI-domain field markers added to every field subtype. */
export const uiFieldAttrs: readonly AttrSchema[] = [
  filterableSchema,
  sortableSchema,
  sortableDefaultOrderSchema,
];
