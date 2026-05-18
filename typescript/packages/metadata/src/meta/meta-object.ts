// MetaObject — concrete node class for type=object nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData } from "./meta-data.js";
import {
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  TYPE_SOURCE,
  TYPE_LAYOUT,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_DB_TABLE_ATTR_NAME,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  OBJECT_ATTR_JAVA_RUNTIME,
} from "../constants.js";
import type { MetaField } from "./meta-field.js";
import type { MetaIdentity } from "./meta-identity.js";
import type { MetaLayout } from "./meta-layout.js";
import type { MetaRelationship } from "./meta-relationship.js";
import type { MetaValidator } from "./meta-validator.js";

export class MetaObject extends MetaData {
  get dbTable(): string | undefined {
    return this.cached("dbTable", () => {
      const source = this.children().find(
        (c) => c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_DB_TABLE,
      );
      const name = source?.ownAttr(SOURCE_DB_TABLE_ATTR_NAME);
      return typeof name === "string" && name !== "" ? name : undefined;
    });
  }

  get javaRuntime(): string | undefined {
    const v = this.ownAttr(OBJECT_ATTR_JAVA_RUNTIME);
    return typeof v === "string" ? v : undefined;
  }

  isEntity(): boolean {
    return this.subType === OBJECT_SUBTYPE_ENTITY;
  }

  isValue(): boolean {
    return this.subType === OBJECT_SUBTYPE_VALUE;
  }

  /** All effective fields (own + inherited via extends). */
  fields(): MetaField[] {
    return this.cached("fields", () =>
      this.children().filter((c): c is MetaField => c.type === TYPE_FIELD),
    );
  }

  /** Own fields only — excludes fields inherited via extends. Java parity: getMetaFields(false). */
  ownFields(): MetaField[] {
    return this.cached("ownFields", () =>
      this.ownChildren().filter((c): c is MetaField => c.type === TYPE_FIELD),
    );
  }

  /** All effective identities (own + inherited via extends). */
  identities(): MetaIdentity[] {
    return this.cached("identities", () =>
      this.children().filter((c): c is MetaIdentity => c.type === TYPE_IDENTITY),
    );
  }

  /** Own identities only — excludes inherited. */
  ownIdentities(): MetaIdentity[] {
    return this.cached("ownIdentities", () =>
      this.ownChildren().filter((c): c is MetaIdentity => c.type === TYPE_IDENTITY),
    );
  }

  /** Returns the single primary identity, if any. */
  primaryIdentity(): MetaIdentity | undefined {
    return this.cached("primaryIdentity", () =>
      this.identities().find((i) => i.subType === IDENTITY_SUBTYPE_PRIMARY),
    );
  }

  /** Secondary identities. */
  secondaryIdentities(): MetaIdentity[] {
    return this.cached("secondaryIdentities", () =>
      this.identities().filter((i) => i.subType === IDENTITY_SUBTYPE_SECONDARY),
    );
  }

  /** All effective relationships (own + inherited via extends). */
  relationships(): MetaRelationship[] {
    return this.cached("relationships", () =>
      this.children().filter((c): c is MetaRelationship => c.type === TYPE_RELATIONSHIP),
    );
  }

  /** Own relationships only — excludes inherited. */
  ownRelationships(): MetaRelationship[] {
    return this.cached("ownRelationships", () =>
      this.ownChildren().filter((c): c is MetaRelationship => c.type === TYPE_RELATIONSHIP),
    );
  }

  /** All effective validators (own + inherited via extends). */
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

  /** All effective layouts (own + inherited via extends). */
  layouts(): MetaLayout[] {
    return this.cached("layouts", () =>
      this.children().filter((c): c is MetaLayout => c.type === TYPE_LAYOUT),
    );
  }

  /** Own layouts only — excludes inherited. */
  ownLayouts(): MetaLayout[] {
    return this.cached("ownLayouts", () =>
      this.ownChildren().filter((c): c is MetaLayout => c.type === TYPE_LAYOUT),
    );
  }

  findField(name: string): MetaField | undefined {
    return this.cached(`findField:${name}`, () =>
      this.fields().find((f) => f.name === name),
    );
  }
}
