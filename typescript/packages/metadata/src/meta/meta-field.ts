// MetaField — concrete node class for type=field nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData } from "./meta-data.js";
import { type DataType, type DataTypeAware, DATA_TYPE_STRING } from "../data-type.js";
import {
  TYPE_VALIDATOR,
  TYPE_VIEW,
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

// Forward-declared type imports to avoid circular references at runtime.
// MetaValidator and MetaView are defined in Task 3 (meta-validator.ts / meta-view.ts).
// Using MetaData as the base type here; callers narrow as needed.

export class MetaField extends MetaData implements DataTypeAware {
  /** The coarse value-type classification for this field's subtype. */
  get dataType(): DataType {
    return this._dataType ?? DATA_TYPE_STRING;
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
  validators(): MetaData[] {
    return this.cached("validators", () =>
      this.children().filter((c) => c.type === TYPE_VALIDATOR),
    );
  }

  /** Own validators only — excludes validators inherited via extends. Java parity: getChildren(Class, false). */
  ownValidators(): MetaData[] {
    return this.cached("ownValidators", () =>
      this.ownChildren().filter((c) => c.type === TYPE_VALIDATOR),
    );
  }

  /** All effective views (own + inherited via extends). Java parity: MetaField.getViews() / getChildren(MetaView.class, true). */
  views(): MetaData[] {
    return this.cached("views", () =>
      this.children().filter((c) => c.type === TYPE_VIEW),
    );
  }

  /** Own views only — excludes views inherited via extends. */
  ownViews(): MetaData[] {
    return this.cached("ownViews", () =>
      this.ownChildren().filter((c) => c.type === TYPE_VIEW),
    );
  }

  /** The typed supertype field if `extends:` resolved, else undefined. */
  resolveSuper(): MetaField | undefined {
    return this.superData as MetaField | undefined;
  }
}
