// Field attribute schemas — attrs common to every field subtype, plus the
// @currency attr specific to field.currency. Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_BOOLEAN,
} from "../attr/attr-constants.js";
import { SORT_ORDER_VALUES } from "../query/query-constants.js";
import {
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_CURRENCY_DEFAULT,
  FIELD_ATTR_AUTO_SET,
  AUTO_SET_VALUES,
} from "./field-constants.js";

/** Attrs common to every field subtype (codegen-ts column mapper + Project D filter/sort). */
export const commonFieldAttrs: AttrSchema[] = [
  {
    name: FIELD_ATTR_OBJECT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Name (or FQN) of the target object an object-typed field nests — drives nested-object (de)serialization.",
  },
  {
    name: FIELD_ATTR_REQUIRED,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is NOT NULL. Equivalent to attaching a validator.required child.",
  },
  {
    name: FIELD_ATTR_UNIQUE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description: "When true, the field gets a column-level UNIQUE constraint.",
  },
  {
    name: FIELD_ATTR_DEFAULT,
    // @default is polymorphic: its value type follows the OWNING field's
    // subtype — a boolean field defaults to a boolean, an int field to a
    // number, a string field to a string. No single fixed valueType can
    // capture that, so valueType is intentionally omitted (declared-but-untyped).
    // The parser stores the raw JSON value type-preserved (no coercion).
    // Typed conversion happens at consumption time via MetaField.defaultValue(),
    // which applies the field's own DataType — Java parity with
    // MetaField.getDefaultValue() / DataConverter.toTypeSafe(getDataType(), o).
    required: false,
    description:
      "Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue().",
  },
  {
    name: FIELD_ATTR_MAX_LENGTH,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Maximum character length for string-typed fields (drives VARCHAR(n)).",
  },
  {
    name: FIELD_ATTR_PRECISION,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Total number of significant digits for decimal-typed fields.",
  },
  {
    name: FIELD_ATTR_SCALE,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Number of digits to the right of the decimal point for decimal-typed fields.",
  },
  {
    name: FIELD_ATTR_FILTERABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer).",
  },
  {
    name: FIELD_ATTR_SORTABLE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out.",
  },
  {
    name: FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...SORT_ORDER_VALUES],
    description: "Default sort direction applied when this field is the default sort field.",
  },
  {
    name: FIELD_ATTR_AUTO_SET,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...AUTO_SET_VALUES],
    description:
      "Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write.",
  },
];

/** The @currency attr — only on field.currency. */
export const currencyFieldAttr: AttrSchema = {
  name: FIELD_ATTR_CURRENCY,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: FIELD_ATTR_CURRENCY_DEFAULT,
  description:
    "ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted.",
};
