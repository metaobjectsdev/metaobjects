// MetaField — concrete node class for type=field nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData, type AttrValue } from "./meta-data.js";
import {
  type DataType,
  type DataTypeAware,
  DATA_TYPE_STRING,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_DATE,
  DATA_TYPE_OBJECT,
} from "../data-type.js";
import { convertToDataType } from "../data-converter.js";
import {
  TYPE_VALIDATOR,
  TYPE_VIEW,
  SUBTYPE_BASE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_DB_COLUMN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_OBJECT_REF,
  VALIDATOR_SUBTYPE_REQUIRED,
} from "../constants.js";
import type { MetaValidator } from "./meta-validator.js";
import type { MetaView } from "./meta-view.js";

/** Field subtype → DataType. Co-located with the class — a provider adding a
 *  field subtype supplies its own dataType the same way. */
const FIELD_DATA_TYPE: Readonly<Record<string, DataType>> = {
  [SUBTYPE_BASE]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_STRING]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_CLASS]: DATA_TYPE_STRING,
  [FIELD_SUBTYPE_INT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_SHORT]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_BYTE]: DATA_TYPE_INT,
  [FIELD_SUBTYPE_LONG]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_CURRENCY]: DATA_TYPE_LONG,
  [FIELD_SUBTYPE_DOUBLE]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_FLOAT]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_DECIMAL]: DATA_TYPE_DOUBLE,
  [FIELD_SUBTYPE_BOOLEAN]: DATA_TYPE_BOOLEAN,
  [FIELD_SUBTYPE_DATE]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIME]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_TIMESTAMP]: DATA_TYPE_DATE,
  [FIELD_SUBTYPE_OBJECT]: DATA_TYPE_OBJECT,
};

export class MetaField extends MetaData implements DataTypeAware {
  /** The coarse value-type classification for this field's subtype. */
  get dataType(): DataType {
    return FIELD_DATA_TYPE[this.subType] ?? this._dataType ?? DATA_TYPE_STRING;
  }

  /** Coerce a raw value toward this field's DataType (Java DataConverter parity). */
  coerce(raw: unknown): AttrValue {
    return convertToDataType(this.dataType, raw);
  }

  /** The target object name for an object-typed field (the `@objectRef` attr). */
  get objectRef(): string | undefined {
    const v = this.ownAttr(FIELD_ATTR_OBJECT_REF);
    return typeof v === "string" ? v : undefined;
  }

  get dbColumn(): string | undefined {
    const v = this.ownAttr(FIELD_ATTR_DB_COLUMN);
    return typeof v === "string" ? v : undefined;
  }

  get default(): unknown {
    return this.ownAttr(FIELD_ATTR_DEFAULT);
  }

  /**
   * The default value for this field, converted to the field's own DataType.
   *
   * Java parity: MetaField.getDefaultValue() — reads the raw @default attr and
   * converts it via DataConverter.toTypeSafe(getDataType(), raw). This ensures
   * that even if the raw value was stored as a string (e.g. "@default": "false"
   * in YAML or string-keyed JSON), the returned value is the correctly-typed
   * boolean/number/string for this field's subtype.
   *
   * Returns undefined when @default is not set on this field.
   * Result is cached after freeze (same pattern as validators()/views()).
   */
  defaultValue(): AttrValue | undefined {
    return this.cached("defaultValue", () => {
      const raw = this.ownAttr(FIELD_ATTR_DEFAULT);
      if (raw === undefined) return undefined;
      return this.coerce(raw);
    });
  }

  get maxLength(): number | undefined {
    const v = this.ownAttr(FIELD_ATTR_MAX_LENGTH);
    return typeof v === "number" ? v : undefined;
  }

  get precision(): number | undefined {
    const v = this.ownAttr(FIELD_ATTR_PRECISION);
    return typeof v === "number" ? v : undefined;
  }

  get scale(): number | undefined {
    const v = this.ownAttr(FIELD_ATTR_SCALE);
    return typeof v === "number" ? v : undefined;
  }

  /** True if `@unique: true` is set on the field itself (column-level unique). */
  get unique(): boolean {
    return this.ownAttr(FIELD_ATTR_UNIQUE) === true;
  }

  /**
   * True if the field is required (NOT NULL).
   *
   * Checks both `@required: true` attr and `validator.required` children —
   * matches the codegen-ts isRequired() semantics.
   */
  get isRequired(): boolean {
    if (this.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
    return this.validators().some((v) => v.subType === VALIDATOR_SUBTYPE_REQUIRED);
  }

  /** All effective validators (own + inherited via extends). Java parity: MetaField.getValidators() / getChildren(MetaValidator.class, true). */
  validators(): MetaValidator[] {
    return this.cached("validators", () =>
      this.children().filter((c): c is MetaValidator => c.type === TYPE_VALIDATOR),
    );
  }

  /** Own validators only — excludes validators inherited via extends. Java parity: getChildren(Class, false). */
  ownValidators(): MetaValidator[] {
    return this.cached("ownValidators", () =>
      this.ownChildren().filter((c): c is MetaValidator => c.type === TYPE_VALIDATOR),
    );
  }

  /** All effective views (own + inherited via extends). Java parity: MetaField.getViews() / getChildren(MetaView.class, true). */
  views(): MetaView[] {
    return this.cached("views", () =>
      this.children().filter((c): c is MetaView => c.type === TYPE_VIEW),
    );
  }

  /** Own views only — excludes views inherited via extends. */
  ownViews(): MetaView[] {
    return this.cached("ownViews", () =>
      this.ownChildren().filter((c): c is MetaView => c.type === TYPE_VIEW),
    );
  }

  /** The typed supertype field if `extends:` resolved, else undefined. */
  resolveSuper(): MetaField | undefined {
    return this.superData as MetaField | undefined;
  }
}
