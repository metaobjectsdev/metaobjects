// MetaRoot — concrete node class for the type=metadata root node.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Children are already concrete typed nodes; accessors filter by type constant.

import { MetaData } from "./meta-data.js";
import { TYPE_OBJECT, TYPE_FIELD } from "../constants.js";
import type { MetaObject } from "./meta-object.js";
import type { MetaField } from "./meta-field.js";

export class MetaRoot extends MetaData {
  /** Object entities defined at this root level. */
  objects(): MetaObject[] {
    return this.cached("objects", () =>
      this.ownChildren().filter((c): c is MetaObject => c.type === TYPE_OBJECT),
    );
  }

  /** Abstract / package-level fields defined at root (rare; e.g. shared id fields). */
  fields(): MetaField[] {
    return this.cached("fields", () =>
      this.ownChildren().filter((c): c is MetaField => c.type === TYPE_FIELD),
    );
  }

  /** Find an object by name. */
  findObject(name: string): MetaObject | undefined {
    return this.cached(`findObject:${name}`, () => {
      const child = this.ownChildByTypeAndName(TYPE_OBJECT, name);
      return child !== undefined ? (child as MetaObject) : undefined;
    });
  }
}
