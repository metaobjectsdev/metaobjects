// MetaObject — concrete node class for type=object nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData } from "../../shared/meta-data.js";
import {
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_INDEX,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  TYPE_LAYOUT,
} from "../../shared/base-types.js";
import {
  SOURCE_ROLE_PRIMARY,
} from "../../persistence/source/source-constants.js";
import { MetaSource } from "../../persistence/source/meta-source.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
} from "./object-constants.js";
import { ValueObject } from "./value-object.js";
import { isMetaObjectAware } from "./meta-object-aware.js";
import {
  ObjectClassRegistry,
  defaultObjectClassRegistry,
} from "./object-class-registry.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
} from "../identity/identity-constants.js";
import type { MetaField } from "../field/meta-field.js";
import type { MetaIdentity, MetaReferenceIdentity } from "../identity/meta-identity.js";
import type { MetaIndex } from "../index/meta-index.js";
import type { MetaLayout } from "../../presentation/layout/meta-layout.js";
import type { MetaRelationship } from "../relationship/meta-relationship.js";
import type { MetaValidator } from "../validator/meta-validator.js";

export class MetaObject extends MetaData {
  get dbTable(): string | undefined {
    return this.cached("dbTable", () => {
      // The primary writable source carries the physical table name. FR-016:
      // physicalName respects per-kind aliases + the four-step resolution rule.
      // We still scope to writable + primary because dbTable is the WRITE target
      // (CQRS read-side via dbView/dbProc is a different accessor).
      const source = this.children().find(
        (c): c is MetaSource =>
          c instanceof MetaSource && c.isWritable() && c.role === SOURCE_ROLE_PRIMARY,
      );
      if (source === undefined) return undefined;
      const name = source.physicalName;
      return name !== "" ? name : undefined;
    });
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
      // ADR-0039: own-accessor definition — the deliberate own-only API twin of fields().
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
      // ADR-0039: own-accessor definition — the deliberate own-only API twin of identities().
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

  /** Reference identities — fields on this entity that identify another entity. */
  referenceIdentities(): MetaReferenceIdentity[] {
    return this.cached("referenceIdentities", () =>
      this.identities().filter((i): i is MetaReferenceIdentity =>
        i.subType === IDENTITY_SUBTYPE_REFERENCE,
      ),
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
      // ADR-0039: own-accessor definition — the deliberate own-only API twin of relationships().
      this.ownChildren().filter((c): c is MetaRelationship => c.type === TYPE_RELATIONSHIP),
    );
  }

  /** All effective lookup indexes (own + inherited via extends). ADR-0039: resolving. */
  lookupIndexes(): MetaIndex[] {
    return this.cached("lookupIndexes", () =>
      this.children().filter((c): c is MetaIndex => c.type === TYPE_INDEX),
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
      // ADR-0039: own-accessor definition — the deliberate own-only API twin of validators().
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
      // ADR-0039: own-accessor definition — the deliberate own-only API twin of layouts().
      this.ownChildren().filter((c): c is MetaLayout => c.type === TYPE_LAYOUT),
    );
  }

  findField(name: string): MetaField | undefined {
    return this.cached(`findField:${name}`, () =>
      this.fields().find((f) => f.name === name),
    );
  }

  /** Java parity alias for findField() — locate an effective field by name. */
  getMetaField(name: string): MetaField | undefined {
    return this.findField(name);
  }

  /**
   * Instantiate a backing object for this MetaObject (Java parity:
   * MetaObject.newInstance()). Resolution order:
   *
   *   1. If `registry.resolve(this.fqn())` yields a factory, call it; if the
   *      result is MetaObjectAware, attach this MetaObject as its back-reference.
   *   2. Otherwise create a map-backed ValueObject (the unbound default for
   *      `object.value`), which sets its own back-reference via the constructor.
   *
   * The registry key is the object's fully-qualified name as produced by
   * `resolutionKey()` (`<package>::<name>`, folding the file-default package).
   * This is the SAME FQN form used by a nested field's `@objectRef`, so a
   * factory registered for an object's FQN is found whether instantiation is
   * driven top-down or via an object-ref. (An object's bare `fqn()` is reserved
   * for the FR5d cross-port referrer-envelope contract and is NOT the binding
   * key.) Reflection-free: only registered factories are consulted.
   */
  newInstance(registry: ObjectClassRegistry = defaultObjectClassRegistry): object {
    const factory = registry.resolve(this.resolutionKey());
    if (factory !== undefined) {
      const instance = factory(this);
      if (isMetaObjectAware(instance)) {
        instance.setMetaData(this);
      }
      return instance;
    }
    return new ValueObject(this);
  }
}
