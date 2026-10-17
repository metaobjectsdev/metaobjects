// MetaRoot — concrete node class for the type=metadata root node.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData } from "./meta-data.js";
import { TYPE_OBJECT, TYPE_FIELD } from "./base-types.js";
import type { MetaObject } from "../core/object/meta-object.js";
import type { MetaField } from "../core/field/meta-field.js";
import { DEFAULT_PHYSICAL_NAMING, type PhysicalNaming } from "../naming.js";

export class MetaRoot extends MetaData {
  /**
   * The project's physical-naming rules (`naming` in `.metaobjects/config.json`, ADR-0058).
   * Set by the project-aware load (`loadMemory`, `resolveCollection`), read by every name
   * resolver through `physicalNamingOf`. A tree loaded with no project has the default.
   */
  physicalNaming: PhysicalNaming = DEFAULT_PHYSICAL_NAMING;

  /** Object entities defined at this root level. */
  objects(): MetaObject[] {
    return this.cached("objects", () =>
      // ADR-0039: own — the metadata root has no super chain (it never `extends`),
      // so own children ARE its effective children.
      this.ownChildren().filter((c): c is MetaObject => c.type === TYPE_OBJECT),
    );
  }

  /** Abstract / package-level fields defined at root (rare; e.g. shared id fields). */
  fields(): MetaField[] {
    return this.cached("fields", () =>
      // ADR-0039: own — the metadata root has no super chain (it never `extends`).
      this.ownChildren().filter((c): c is MetaField => c.type === TYPE_FIELD),
    );
  }

  /** Find an object by name. */
  findObject(name: string): MetaObject | undefined {
    return this.cached(`findObject:${name}`, () => {
      // ADR-0039: own — the metadata root has no super chain (it never `extends`).
      const child = this.ownChildByTypeAndName(TYPE_OBJECT, name);
      return child !== undefined ? (child as MetaObject) : undefined;
    });
  }
}
