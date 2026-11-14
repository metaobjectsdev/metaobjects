// ADR-0063 — cross-node rules for operations (slice A) and lifecycles (slice B).
//
// Every port implements the same rules WITH THE SAME MESSAGE TEXT; the fixtures under
// fixtures/conformance/ (`error-rules-*`, with the positive `rules-*` cases) are the
// contract. The rule ids below are the ones docs/features/business-rules.md lists.
//
// One broken rule yields one error:
//   - Each error's source is the offending node: the transition, the enum field (L3),
//     the entity (L2b), the operation or the binding.
//   - An operation whose @inputRef / @outputRef fails O1 is not checked further; one
//     whose target fails O2 or O3 is not checked for O4 or B1.
//   - An error is reported once per (node, code), so a broken transition on an abstract
//     base is reported once, not once per inheritor.
//
// Rules:
//   L1 ERR_TRANSITION_NOT_ON_ENTITY   a transition under an enum field not declared on an object.entity
//   L2 ERR_TRANSITION_NOT_ON_ENTITY   a concrete entity with a lifecycle and a source, none of them writable
//                                      (on the entity). An entity with no source at all is inert: its
//                                      lifecycle loads and derives nothing (lifecycleIsLive).
//   L3 ERR_LIFECYCLE_NO_INITIAL       an enum field declaring transitions has no @default
//   L4 ERR_TRANSITION_UNKNOWN_STATE   a @from or @to value is not one of the enum's @values
//   L5 ERR_TRANSITION_NAME_COLLISION  a transition named create/get/list/update/delete, in any case
//   L6 ERR_TRANSITION_NAME_COLLISION  two transitions of one entity (across its lifecycles) share a
//                                      name, compared without case
//   L7 ERR_BAD_ATTR_VALUE             @condition names a field the entity does not have, or is not boolean
//   L8 ERR_BAD_ATTR_VALUE             @from is empty
//   L9 ERR_BAD_ATTR_VALUE             a lifecycle field is an array (@isArray: true)
//   L10 ERR_LIFECYCLE_REDECLARED      an entity redeclares an inherited lifecycle field without
//                                      extending it, so the base's transitions would be lost
//   P1 ERR_PERMISSION_PUBLIC_CONFLICT @public: true with @permission (operation or transition)
//   P2 ERR_BAD_ATTR_VALUE             @permission is not a dotted identifier path (PERMISSION_NAME_PATTERN)
//   O0 ERR_TRANSITION_NAME_COLLISION  an operation named create/get/list/update/delete, in any case
//   O6 ERR_TRANSITION_NAME_COLLISION  two operations of one package share a name, compared without case,
//                                      in one API or across its APIs (each derives the permission
//                                      name <package>.<operation>), unless they are the same
//                                      operation: declared twice in one API (they merge), or
//                                      declared identically in two APIs (sameOperation)
//   O1 ERR_OPERATION_SHAPE            @inputRef is not an object.value; @outputRef is not an entity, projection or value
//   O2 ERR_OPERATION_TARGET_UNRESOLVED @objectRef is not an object.entity, or a command lists
//                                      @transitions and no target is declared or derivable
//   O3 ERR_OPERATION_TARGET_MISMATCH  a declared @objectRef disagrees with the derived target
//   O4 ERR_OPERATION_UNKNOWN_TRANSITION a @transitions name is not a transition of the target
//   O5 ERR_BAD_ATTR_VALUE             an @errors code is not lower snake case, is listed twice, or is
//                                      one the route answers itself (RESERVED_ERROR_CODES)
//   B1 ERR_BINDING_PATH_MISMATCH      a binding.rest @path's placeholders are not the target's key fields
//                                      (a keyed operation) or are not empty (an unkeyed one)
//   B2 ERR_BINDING_PATH_MISMATCH      two binding.rest of one API declaring a @path have the same
//                                      effective method and the same path once placeholder names are ignored

import type { MetaData } from "../shared/meta-data.js";
import type { MetaObject } from "../core/object/meta-object.js";
import { ParseError, type ErrorCode } from "../errors.js";
import {
  TYPE_API,
  TYPE_BINDING,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_OPERATION,
  TYPE_SOURCE,
  TYPE_TRANSITION,
} from "../shared/base-types.js";
import { FIELD_ATTR_DEFAULT, FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM } from "../core/field/field-constants.js";
import { OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_PROJECTION, OBJECT_SUBTYPE_VALUE } from "../core/object/object-constants.js";
import {
  BINDING_ATTR_METHOD,
  BINDING_ATTR_PATH,
  BINDING_SUBTYPE_REST,
  BUSINESS_ERROR_CODE_PATTERN,
  PERMISSION_NAME_PATTERN,
  OPERATION_ATTR_ERRORS,
  OPERATION_ATTR_INPUT_REF,
  OPERATION_ATTR_MANY,
  OPERATION_ATTR_OBJECT_REF,
  OPERATION_ATTR_OUTPUT_REF,
  OPERATION_ATTR_PERMISSION,
  OPERATION_ATTR_PUBLIC,
  OPERATION_ATTR_TRANSITIONS,
  OPERATION_SUBTYPE_COMMAND,
  RESERVED_ERROR_CODES,
  RESERVED_OPERATION_NAMES,
} from "../core/api/api-constants.js";
import { TRANSITION_ATTR_CONDITION, TRANSITION_SUBTYPE_ACTION } from "../core/transition/transition-constants.js";
import {
  deriveOperationTarget,
  entityLineage,
  entityTransitions,
  lifecycleIsLive,
  lifecycleTransitionsOf,
  operationIsKeyed,
  primaryKeyFields,
  resolveObjectOn,
  stringList,
  transitionFrom,
  transitionTo,
} from "../core/transition/lifecycle.js";
import { isWritableSource } from "../shared/node-guards.js";
import { effectivePackageOf } from "../naming-refs.js";
import { conditionMessage } from "./validation-passes.js";

const RESERVED = new Set<string>(RESERVED_OPERATION_NAMES);
const RESERVED_LIST = RESERVED_OPERATION_NAMES.join(", ");
const RESERVED_CODES = new Set<string>(RESERVED_ERROR_CODES);

/** A derived name is compared without case: a command, a permission constant or a file named
 *  from it collides with another that differs only in case on a case-folding target. */
function isReservedName(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}

/** `"Entity.field.transition"` for a transition, `"Api.operation"` for an operation. */
function label(node: MetaData): string {
  const parts: string[] = [];
  // A binding is unnamed: its label is its operation's.
  for (let n: MetaData | undefined = node; n !== undefined && n.parent !== undefined; n = n.parent) {
    if (n.name !== "") parts.unshift(n.name);
  }
  return parts.join(".");
}

function quoteList(xs: readonly string[]): string {
  return xs.map((x) => `"${x}"`).join(", ");
}

class Sink {
  readonly errors: ParseError[] = [];
  private readonly seen = new Set<string>();
  private readonly ids = new Map<MetaData, number>();
  add(node: MetaData, code: ErrorCode, message: string): void {
    let id = this.ids.get(node);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(node, id);
    }
    const key = `${id}\u0000${code}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.errors.push(new ParseError(message, { code, source: node.source }));
  }
}

/** P1 and P2 for an operation or a transition. */
function checkPermission(node: MetaData, sink: Sink): void {
  const permission = node.attr(OPERATION_ATTR_PERMISSION);
  if (node.attr(OPERATION_ATTR_PUBLIC) === true && permission !== undefined) {
    sink.add(node, "ERR_PERMISSION_PUBLIC_CONFLICT",
      `${node.type}.${node.subType} "${label(node)}" declares both @public: true and @permission; a public ${node.type} calls no permission check, so remove one.`);
  }
  if (typeof permission === "string" && !PERMISSION_NAME_PATTERN.test(permission)) {
    sink.add(node, "ERR_BAD_ATTR_VALUE",
      `${node.type}.${node.subType} "${label(node)}" @permission "${permission}" is not a dotted identifier path; use names of letters, digits and _ joined by "." (a package prefix may use "::"), such as "purchasing.approve".`);
  }
}

/** L1, L3, L4, L5, L7 and P1 for the transitions declared on one field. */
function checkDeclaredTransitions(field: MetaData, sink: Sink): void {
  // ADR-0039: own — each transition is checked where it is declared.
  const declared = field.ownChildren().filter((c) => c.type === TYPE_TRANSITION && c.subType === TRANSITION_SUBTYPE_ACTION);
  if (declared.length === 0) return;
  const owner = field.parent;
  if (owner === undefined || owner.type !== TYPE_OBJECT || owner.subType !== OBJECT_SUBTYPE_ENTITY) {
    const where = owner === undefined || owner.type !== TYPE_OBJECT ? "the document root" : `object.${owner.subType} "${owner.name}"`;
    for (const t of declared) {
      sink.add(t, "ERR_TRANSITION_NOT_ON_ENTITY",
        `transition.action "${label(t)}" is declared on a field of ${where}; a lifecycle belongs to an object.entity with a writable source.`);
    }
    return;
  }
  if (field.subType === FIELD_SUBTYPE_ENUM && typeof field.attr(FIELD_ATTR_DEFAULT) !== "string") {
    sink.add(field, "ERR_LIFECYCLE_NO_INITIAL",
      `field.enum "${label(field)}" declares transitions but no @default; its @default is the lifecycle's initial state.`);
  }
  if (field.resolvedIsArray()) {
    sink.add(field, "ERR_BAD_ATTR_VALUE",
      `field.${field.subType} "${label(field)}" declares transitions but is an array (@isArray: true); a lifecycle's state is one value.`);
  }
  const states = new Set(stringList(field, FIELD_ATTR_VALUES));
  for (const t of declared) {
    checkPermission(t, sink);
    if (transitionFrom(t).length === 0) {
      sink.add(t, "ERR_BAD_ATTR_VALUE",
        `transition.action "${label(t)}" @from is empty; name at least one state the transition leaves.`);
    }
    const to = transitionTo(t);
    const unknown = [...new Set([...transitionFrom(t), ...(to === undefined ? [] : [to])])].filter((s) => !states.has(s));
    if (unknown.length > 0) {
      sink.add(t, "ERR_TRANSITION_UNKNOWN_STATE",
        `transition.action "${label(t)}" names ${quoteList(unknown)}, which ${unknown.length === 1 ? "is not a member" : "are not members"} of "${field.name}" @values (${quoteList([...states])}).`);
    }
    if (isReservedName(t.name)) {
      sink.add(t, "ERR_TRANSITION_NAME_COLLISION",
        `transition.action "${label(t)}" is named "${t.name}", which is a derived CRUD verb (${RESERVED_LIST}); rename it.`);
    }
    const condition = t.attr(TRANSITION_ATTR_CONDITION);
    if (condition !== undefined) {
      const message = conditionMessage(condition, owner as MetaObject, `transition.action "${label(t)}" @condition`);
      if (message !== undefined) sink.add(t, "ERR_BAD_ATTR_VALUE", message);
    }
  }
}

/** Every field declared in the tree: at the root and on every object. */
function declaredFields(root: MetaData): MetaData[] {
  const out: MetaData[] = [];
  // ADR-0039: own — a structural walk over the declarations themselves.
  for (const top of root.ownChildren()) {
    if (top.type === TYPE_FIELD) out.push(top);
    else if (top.type === TYPE_OBJECT) out.push(...top.ownChildren().filter((c) => c.type === TYPE_FIELD));
  }
  return out;
}

/** L10: an entity's field named like an ancestor's lifecycle field that does not carry that
 *  lifecycle's transitions. Redeclaring the field replaces it, so the base's state machine would
 *  silently stop applying to this entity. */
function checkRedeclaredLifecycles(entity: MetaData, sink: Sink): void {
  for (const ancestor of entityLineage(entity).slice(1)) {
    // ADR-0039: own — the lifecycle fields the ancestor itself declares.
    for (const baseField of ancestor.ownChildren()) {
      if (baseField.type !== TYPE_FIELD) continue;
      const baseTransitions = lifecycleTransitionsOf(ancestor, baseField);
      if (baseTransitions.length === 0) continue;
      const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === baseField.name);
      if (field === undefined || field === baseField) continue;
      const kept = new Set(lifecycleTransitionsOf(entity, field));
      if (baseTransitions.every((t) => kept.has(t))) continue;
      sink.add(field, "ERR_LIFECYCLE_REDECLARED",
        `field.${field.subType} "${label(field)}" redeclares "${label(baseField)}", which has a lifecycle, and drops its transitions; extend it ("extends": "${ancestor.name}.${baseField.name}") or give the field another name.`);
    }
  }
}

/** L2, L6 and L10 for one entity, over its effective (inherited) lifecycles. */
function checkEntityLifecycles(entity: MetaData, sink: Sink): void {
  checkRedeclaredLifecycles(entity, sink);
  const transitions = entityTransitions(entity);
  if (transitions.length === 0) return;
  const byName = new Map<string, MetaData>();
  for (const t of transitions) {
    const key = t.name.toLowerCase();
    const first = byName.get(key);
    if (first === undefined) {
      byName.set(key, t);
    } else if (first !== t) {
      sink.add(t, "ERR_TRANSITION_NAME_COLLISION",
        `transition.action "${label(t)}" has the same name as "${label(first)}" (names are compared without case); the transitions of "${entity.name}" share one namespace (each may derive a command), so rename one.`);
    }
  }
  if (!entity.isAbstract && lifecycleIsLive(entity) &&
      !entity.children().some((c) => c.type === TYPE_SOURCE && isWritableSource(c))) {
    sink.add(entity, "ERR_TRANSITION_NOT_ON_ENTITY",
      `object.entity "${entity.name}" has a lifecycle (transitions on ${quoteList([...new Set(transitions.map((t) => t.parent?.name ?? ""))])}) and a source, but no writable one; a transition is a guarded update of a stored row. (An entity with no source at all may carry a lifecycle: it is inert until a source is added.)`);
  }
}

/** O0-O5, P1 and B1 for one operation. */
function checkOperation(op: MetaData, sink: Sink): void {
  if (isReservedName(op.name)) {
    sink.add(op, "ERR_TRANSITION_NAME_COLLISION",
      `operation.${op.subType} "${label(op)}" is named "${op.name}", which is a derived CRUD verb (${RESERVED_LIST}); rename it.`);
  }
  checkPermission(op, sink);

  const errorCodes = stringList(op, OPERATION_ATTR_ERRORS);
  const bad = errorCodes.filter((c) => !BUSINESS_ERROR_CODE_PATTERN.test(c));
  const dup = errorCodes.filter((c, i) => errorCodes.indexOf(c) !== i);
  const reserved = [...new Set(errorCodes.filter((c) => RESERVED_CODES.has(c)))];
  if (bad.length > 0 || dup.length > 0 || reserved.length > 0) {
    const why = bad.length > 0
      ? `${quoteList(bad)} ${bad.length === 1 ? "is not a" : "are not"} lower snake case code${bad.length === 1 ? "" : "s"}`
      : dup.length > 0
        ? `${quoteList([...new Set(dup)])} ${new Set(dup).size === 1 ? "is" : "are"} listed twice`
        : `${quoteList(reserved)} ${reserved.length === 1 ? "is a code" : "are codes"} the route answers itself (${RESERVED_ERROR_CODES.join(", ")})`;
    sink.add(op, "ERR_BAD_ATTR_VALUE", `operation.${op.subType} "${label(op)}" @errors: ${why}.`);
  }

  // O1 — shapes.
  const inputRef = op.attr(OPERATION_ATTR_INPUT_REF);
  if (typeof inputRef === "string") {
    const input = resolveObjectOn(op, inputRef);
    if (input === undefined || input.subType !== OBJECT_SUBTYPE_VALUE) {
      sink.add(op, "ERR_OPERATION_SHAPE",
        `operation.${op.subType} "${label(op)}" @inputRef "${inputRef}" ${input === undefined ? "names no object" : `is an object.${input.subType}`}; an operation's input is an object.value.`);
      return;
    }
  }
  const outputRef = op.attr(OPERATION_ATTR_OUTPUT_REF);
  if (typeof outputRef === "string") {
    const output = resolveObjectOn(op, outputRef);
    const legal = output !== undefined &&
      [OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_PROJECTION, OBJECT_SUBTYPE_VALUE].includes(output.subType);
    if (!legal) {
      sink.add(op, "ERR_OPERATION_SHAPE",
        `operation.${op.subType} "${label(op)}" @outputRef "${outputRef}" ${output === undefined ? "names no object" : `is an object.${output.subType}`}; an operation returns an object.entity, object.projection or object.value.`);
      return;
    }
  }

  // O2, O3 — the target.
  const derived = deriveOperationTarget(op)?.entity;
  let target = derived;
  const objectRef = op.attr(OPERATION_ATTR_OBJECT_REF);
  if (typeof objectRef === "string") {
    const declared = resolveObjectOn(op, objectRef);
    if (declared === undefined || declared.subType !== OBJECT_SUBTYPE_ENTITY) {
      sink.add(op, "ERR_OPERATION_TARGET_UNRESOLVED",
        `operation.${op.subType} "${label(op)}" @objectRef "${objectRef}" ${declared === undefined ? "names no object" : `is an object.${declared.subType}`}; an operation acts on an object.entity.`);
      return;
    }
    if (derived !== undefined && derived !== declared) {
      sink.add(op, "ERR_OPERATION_TARGET_MISMATCH",
        `operation.${op.subType} "${label(op)}" @objectRef names "${declared.name}", but its input and output derive "${derived.name}"; remove @objectRef or make them agree.`);
      return;
    }
    target = declared;
  }
  const transitions = op.subType === OPERATION_SUBTYPE_COMMAND ? stringList(op, OPERATION_ATTR_TRANSITIONS) : [];
  if (transitions.length > 0 && target === undefined) {
    sink.add(op, "ERR_OPERATION_TARGET_UNRESOLVED",
      `operation.command "${label(op)}" lists @transitions but has no target entity: the @inputRef does not borrow one entity's whole primary key (each key field extended exactly once), no @outputRef has a base entity, and there is no @objectRef.`);
    return;
  }

  // O4 — the transitions it may make.
  if (target !== undefined && transitions.length > 0) {
    const known = new Set(entityTransitions(target).map((t) => t.name));
    const unknown = [...new Set(transitions)].filter((n) => !known.has(n));
    if (unknown.length > 0) {
      sink.add(op, "ERR_OPERATION_UNKNOWN_TRANSITION",
        `operation.command "${label(op)}" @transitions names ${quoteList(unknown)}, which ${unknown.length === 1 ? "is not a transition" : "are not transitions"} of "${target.name}".`);
    }
  }

  // B1 — binding paths.
  // ADR-0039: own — a binding is checked on the operation that declares it.
  for (const b of op.ownChildren()) {
    if (b.type !== TYPE_BINDING || b.subType !== BINDING_SUBTYPE_REST) continue;
    const path = b.attr(BINDING_ATTR_PATH);
    if (typeof path !== "string") continue;
    const placeholders = [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    const expected = target !== undefined && operationIsKeyed(op) ? primaryKeyFields(target) : [];
    const same = placeholders.length === expected.length &&
      [...placeholders].sort().every((p, i) => p === [...expected].sort()[i]);
    if (!same) {
      sink.add(b, "ERR_BINDING_PATH_MISMATCH",
        `binding.rest on "${label(b)}" @path "${path}" has placeholders [${quoteList(placeholders)}]; ` +
        (expected.length === 0
          ? `"${label(op)}" addresses no row by key, so its path takes none.`
          : `"${label(op)}" addresses one "${target!.name}" by key, so its path takes exactly [${quoteList(expected)}].`));
    }
  }
}

/** ADR-0063 — the rules pass. Runs after reference-bearing validation, before freeze. */
export function validateRules(root: MetaData): ParseError[] {
  const sink = new Sink();
  for (const field of declaredFields(root)) checkDeclaredTransitions(field, sink);
  for (const obj of root.children()) {
    if (obj.type === TYPE_OBJECT && obj.subType === OBJECT_SUBTYPE_ENTITY) checkEntityLifecycles(obj, sink);
  }
  // O6 — keyed by package, then by the name without case.
  const byName = new Map<string, MetaData>();
  for (const api of root.children()) {
    if (api.type !== TYPE_API) continue;
    const ops = api.children().filter((c) => c.type === TYPE_OPERATION);
    for (const op of ops) checkOperation(op, sink);
    for (const op of ops) {
      const pkg = effectivePackageOf(api);
      const key = `${pkg}\u0000${op.name.toLowerCase()}`;
      const first = byName.get(key);
      if (first === undefined) byName.set(key, op);
      else if (first !== op && !sameOperation(first, op)) {
        sink.add(op, "ERR_TRANSITION_NAME_COLLISION",
          `operation.${op.subType} "${label(op)}" has the same name as "${label(first)}" (names are compared without case) and is not the same operation; the operations of package "${pkg}" share one namespace (each derives the permission name <package>.<operation>), so rename one, or declare both identically to expose one operation in two APIs.`);
      }
    }
    checkApiRoutes(ops, sink);
  }
  return sink.errors;
}

/** A reference attr's identity: the node it resolves to, else the raw value. */
function refIdentity(op: MetaData, attr: string): unknown {
  const ref = op.attr(attr);
  return typeof ref === "string" ? resolveObjectOn(op, ref) ?? ref : ref;
}

/** A list attr as a set, for comparison. */
function setKey(op: MetaData, attr: string): string {
  return [...new Set(stringList(op, attr))].sort().join("\u0000");
}

/**
 * Whether two operations of one package in different APIs are one operation exposed twice, as a
 * versioned API beside its successor does (ADR-0064 §2: one router per API, one service): the same
 * name and subtype, and the same contract. The contract is every operation attribute: the
 * referenced shapes (compared by the node they resolve to), the transitions and errors (as sets),
 * the permission, public and many. Bindings are per API and are not compared.
 */
function sameOperation(a: MetaData, b: MetaData): boolean {
  if (a.name !== b.name || a.subType !== b.subType) return false;
  for (const attr of [OPERATION_ATTR_INPUT_REF, OPERATION_ATTR_OUTPUT_REF, OPERATION_ATTR_OBJECT_REF]) {
    if (refIdentity(a, attr) !== refIdentity(b, attr)) return false;
  }
  for (const attr of [OPERATION_ATTR_TRANSITIONS, OPERATION_ATTR_ERRORS]) {
    if (setKey(a, attr) !== setKey(b, attr)) return false;
  }
  return a.attr(OPERATION_ATTR_PERMISSION) === b.attr(OPERATION_ATTR_PERMISSION) &&
    (a.attr(OPERATION_ATTR_PUBLIC) === true) === (b.attr(OPERATION_ATTR_PUBLIC) === true) &&
    (a.attr(OPERATION_ATTR_MANY) === true) === (b.attr(OPERATION_ATTR_MANY) === true);
}

/** B2 across the operations of one API. */
function checkApiRoutes(ops: readonly MetaData[], sink: Sink): void {
  const byRoute = new Map<string, MetaData>();
  for (const op of ops) {
    // ADR-0039: own — a binding is checked on the operation that declares it.
    for (const b of op.ownChildren()) {
      if (b.type !== TYPE_BINDING || b.subType !== BINDING_SUBTYPE_REST) continue;
      const path = b.attr(BINDING_ATTR_PATH);
      if (typeof path !== "string") continue;
      // The effective method: the declared one, else the derived (ADR-0063 §1).
      const declaredMethod = b.attr(BINDING_ATTR_METHOD);
      const method = typeof declaredMethod === "string"
        ? declaredMethod
        : op.subType === OPERATION_SUBTYPE_COMMAND ? "POST" : "GET";
      const route = `${method} ${path.replace(/\{[^}]*\}/g, "{}")}`;
      const other = byRoute.get(route);
      if (other === undefined) byRoute.set(route, b);
      else {
        sink.add(b, "ERR_BINDING_PATH_MISMATCH",
          `binding.rest on "${label(b)}" declares ${method} "${path}", the same route as the binding on "${label(other)}"; two operations cannot share a method and path.`);
      }
    }
  }
}
