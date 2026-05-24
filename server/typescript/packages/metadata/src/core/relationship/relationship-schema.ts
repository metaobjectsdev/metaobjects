// Relationship attribute schemas — attrs common to every relationship subtype.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRINGARRAY,
} from "../attr/attr-constants.js";
import {
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
  RELATIONSHIP_ATTR_ON_DELETE,
  RELATIONSHIP_ATTR_ON_UPDATE,
  REFERENTIAL_ACTIONS,
} from "./relationship-constants.js";

/** Attrs common to every relationship subtype. */
export const relationshipAttrs: AttrSchema[] = [
  {
    name: RELATIONSHIP_ATTR_CARDINALITY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    // No allowedValues: @cardinality is an open string at the metamodel level
    // (MetaRelationship.cardinality returns `string | undefined`). The Java
    // canonical fixtures use composite forms such as "many-to-one"; the
    // CARDINALITY_VALUES ("one"/"many") constant is a TS codegen convenience,
    // NOT a closed metamodel enum. A3 must not reject the Java-canonical values.
    description:
      "Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one').",
  },
  {
    name: RELATIONSHIP_ATTR_OBJECT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car').",
  },
  {
    name: RELATIONSHIP_ATTR_JOIN_ENTITY,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Join-table entity name for N:M relationships.",
  },
  {
    name: RELATIONSHIP_ATTR_JOIN_FIELDS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Join-table column names for N:M relationships.",
  },
  {
    name: RELATIONSHIP_ATTR_ON_DELETE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...REFERENTIAL_ACTIONS],
    description:
      "Referential action on parent delete. Default derives from subtype (composition→cascade, aggregation→set-null, association→restrict).",
  },
  {
    name: RELATIONSHIP_ATTR_ON_UPDATE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...REFERENTIAL_ACTIONS],
    description: "Referential action on key update. Default cascade.",
  },
];
