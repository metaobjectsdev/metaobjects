// Lifecycle constants (ADR-0063) — the `transition` type, its subtypes and attrs.
//
// A lifecycle has no vocabulary of its own: it is a `field.enum` with at least one
// `transition.action` child. Its states are the enum's @values, its initial state the
// enum's @default, its terminal states the members no transition leaves.

import { TYPE_TRANSITION } from "../../shared/base-types.js";

export { TYPE_TRANSITION };

/** A move made by an operation. */
export const TRANSITION_SUBTYPE_ACTION = "action";
/** A move made by time. RESERVED, not registered (ADR-0063): a different generated
 *  shape (a sweep or a derived read, no operation, no permission point). */
export const TRANSITION_SUBTYPE_TIMED_RESERVED = "timed";
export const TRANSITION_SUBTYPES = [TRANSITION_SUBTYPE_ACTION] as const;
export type TransitionSubType = (typeof TRANSITION_SUBTYPES)[number];

/** The states a move may start from (members of the parent enum's @values). */
export const TRANSITION_ATTR_FROM = "from";
/** The state a move ends in. */
export const TRANSITION_ATTR_TO = "to";
/** A guard over the entity's own fields (the attr.expression grammar). */
export const TRANSITION_ATTR_CONDITION = "condition";
/** As on an operation. */
export const TRANSITION_ATTR_PERMISSION = "permission";
export const TRANSITION_ATTR_PUBLIC = "public";
