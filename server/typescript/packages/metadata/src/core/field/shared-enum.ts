// Shared enum declarations — the single authority for "which type does this enum
// field have" (FR-019, ADR-0026 Amendment 1). The loader's #246 check and every
// codegen site that names, references, imports or materializes an enum type call
// these two functions; neither keeps a predicate of its own.

import { TYPE_FIELD, TYPE_METADATA } from "../../shared/base-types.js";
import type { MetaData } from "../../shared/meta-data.js";
import { FIELD_ATTR_INT_VALUE_MAP, FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM } from "./field-constants.js";
import type { MetaField } from "./meta-field.js";

function isEnumField(node: MetaData | undefined): node is MetaField {
  return node !== undefined && node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM;
}

/**
 * True when `node` is a shared enum declaration: an abstract `field.enum` that is a
 * direct child of the metadata root (a package-level sibling of `object.entity`). An
 * abstract enum nested inside an object is not one.
 */
export function isSharedEnumDeclaration(node: MetaData | undefined): node is MetaField {
  return isEnumField(node) && isRootAbstract(node);
}

function isRootAbstract(field: MetaField): boolean {
  return field.isAbstract && field.parent?.type === TYPE_METADATA;
}

/**
 * The shared enum declaration an enum field's type resolves to, or undefined when the
 * field keeps a per-object inline type.
 *
 * Walks from the field itself up its `extends` chain. At each node, in order: a shared
 * declaration answers (the nearest one wins, so `Money extends Currency` answers
 * `Money`); a node that declares its own `@values` or `@intValueMap` starts a new
 * vocabulary and answers undefined; otherwise the walk continues at the super. A
 * non-enum node, the end of the chain or a cycle answers undefined. The hosting
 * object's subtype and the number of hops play no part.
 */
export function resolveSharedEnumDeclaration(field: MetaData | undefined): MetaField | undefined {
  const seen = new Set<MetaData>();
  let node = field;
  while (isEnumField(node) && !seen.has(node)) {
    if (isRootAbstract(node)) return node;
    // ADR-0039 own (declared-here layer): the question is whether THIS node redeclares
    // the vocabulary. A resolving read would see the inherited @values on every hop and
    // stop the walk at the first one.
    const own = node.ownAttrs();
    if (own.has(FIELD_ATTR_VALUES) || own.has(FIELD_ATTR_INT_VALUE_MAP)) return undefined;
    seen.add(node);
    node = node.superData;
  }
  return undefined;
}
