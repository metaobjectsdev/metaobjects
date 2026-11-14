// Lifecycle and operation-target derivation (ADR-0063), shared by the loader's rules
// pass and `meta verify`'s rules gate. Everything here is DERIVED: a lifecycle, its
// states, its initial and terminal states and an operation's target entity have no
// vocabulary of their own. Every port implements these rules the same way.
//
// Reads are RESOLVING (ADR-0039): a transition declared on a base entity's field is a
// transition of every entity that extends it. It is NOT a transition of an entity whose field
// merely `extends` that field: a field extends another to share its values, and a history
// table of an order's status is not an order (lifecycleTransitionsOf).

import type { MetaData } from "../../shared/meta-data.js";
import { TYPE_FIELD, TYPE_IDENTITY, TYPE_OBJECT, TYPE_TRANSITION } from "../../shared/base-types.js";
import { CHILD_REF_SEPARATOR, PACKAGE_SEPARATOR } from "../../shared/structural.js";
import { FIELD_ATTR_DEFAULT, FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM } from "../field/field-constants.js";
import { IDENTITY_ATTR_FIELDS, IDENTITY_SUBTYPE_PRIMARY } from "../identity/identity-constants.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_PROJECTION,
  OBJECT_SUBTYPE_VALUE,
} from "../object/object-constants.js";
import { effectivePackageOf, resolveObjectRef, topLevelNodeOf } from "../../naming-refs.js";
import { OPERATION_ATTR_INPUT_REF, OPERATION_ATTR_MANY, OPERATION_ATTR_OBJECT_REF, OPERATION_ATTR_OUTPUT_REF, OPERATION_SUBTYPE_QUERY } from "../api/api-constants.js";
import { TRANSITION_ATTR_FROM, TRANSITION_ATTR_TO, TRANSITION_SUBTYPE_ACTION } from "./transition-constants.js";

/** A string-array attr read resolving; a bare string is ONE element. */
export function stringList(node: MetaData, attr: string): string[] {
  const v = node.attr(attr);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

function stringValue(node: MetaData, attr: string): string | undefined {
  const v = node.attr(attr);
  return typeof v === "string" ? v : undefined;
}

/** The `transition.action` children of a field, resolving. */
export function transitionsOf(field: MetaData): MetaData[] {
  return field.children().filter((c) => c.type === TYPE_TRANSITION && c.subType === TRANSITION_SUBTYPE_ACTION);
}

/** An entity and every entity it extends, nearest first. */
export function entityLineage(entity: MetaData): MetaData[] {
  const out: MetaData[] = [];
  for (let e: MetaData | undefined = entity; e !== undefined && !out.includes(e); e = e.superResolved) out.push(e);
  return out;
}

/**
 * The transitions a field gives an entity: those declared on a field of the entity itself or of
 * an entity it extends. A transition reached only through the field's own `extends` of another
 * entity's field is not one (ADR-0063 §2).
 */
export function lifecycleTransitionsOf(entity: MetaData, field: MetaData): MetaData[] {
  const lineage = entityLineage(entity);
  return transitionsOf(field).filter((t) => {
    const owner = t.parent?.parent;
    return owner !== undefined && lineage.includes(owner);
  });
}

/** One lifecycle of an entity: an enum field with at least one transition. */
export interface Lifecycle {
  readonly field: MetaData;
  /** The enum's @values, in declaration order. */
  readonly states: readonly string[];
  /** The enum's @default; undefined only on a model the loader refused. */
  readonly initial: string | undefined;
  readonly transitions: readonly MetaData[];
}

/** The lifecycles of an object, in effective field order. Only an `object.entity` has any. */
export function lifecyclesOf(obj: MetaData): Lifecycle[] {
  if (obj.type !== TYPE_OBJECT || obj.subType !== OBJECT_SUBTYPE_ENTITY) return [];
  const out: Lifecycle[] = [];
  for (const field of obj.children()) {
    if (field.type !== TYPE_FIELD || field.subType !== FIELD_SUBTYPE_ENUM) continue;
    const transitions = lifecycleTransitionsOf(obj, field);
    if (transitions.length === 0) continue;
    const initial = field.attr(FIELD_ATTR_DEFAULT);
    out.push({
      field,
      states: stringList(field, FIELD_ATTR_VALUES),
      initial: typeof initial === "string" ? initial : undefined,
      transitions,
    });
  }
  return out;
}

/** Every transition of an entity, across all its lifecycles. */
export function entityTransitions(obj: MetaData): MetaData[] {
  return lifecyclesOf(obj).flatMap((l) => l.transitions);
}

/** A transition's @from (resolving). */
export function transitionFrom(t: MetaData): string[] {
  return stringList(t, TRANSITION_ATTR_FROM);
}

/** A transition's @to (resolving). */
export function transitionTo(t: MetaData): string | undefined {
  return stringValue(t, TRANSITION_ATTR_TO);
}

/** The states reachable from the initial state, following every transition. */
export function reachableStates(l: Lifecycle): Set<string> {
  const seen = new Set<string>();
  if (l.initial === undefined) return seen;
  const queue = [l.initial];
  seen.add(l.initial);
  while (queue.length > 0) {
    const s = queue.shift()!;
    for (const t of l.transitions) {
      const to = transitionTo(t);
      if (to !== undefined && transitionFrom(t).includes(s) && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/** The members no transition leaves (a self-transition counts as leaving). */
export function terminalStates(l: Lifecycle): string[] {
  const leaving = new Set(l.transitions.flatMap((t) => transitionFrom(t)));
  return l.states.filter((s) => !leaving.has(s));
}

/** The primary key field names of an entity: its effective `identity.primary` @fields. */
export function primaryKeyFields(entity: MetaData): string[] {
  const primary = entity.children().find((c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY);
  return primary === undefined ? [] : stringList(primary, IDENTITY_ATTR_FIELDS);
}

/** The package a node's references resolve in: its top-level node's effective package. */
export function referrerPackageOf(node: MetaData): string {
  return effectivePackageOf(topLevelNodeOf(node));
}

/** Resolve an object reference written on `node` (owner part only). */
export function resolveObjectOn(node: MetaData, ref: string): MetaData | undefined {
  return resolveObjectRef(node.root(), ownerOf(ref), referrerPackageOf(node)).node;
}

/** The owner part of a reference: everything before the child dot of its last `::` segment. */
function ownerOf(ref: string): string {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(CHILD_REF_SEPARATOR, segStart);
  return dot === -1 ? ref : ref.slice(0, dot);
}

/**
 * The object a field's `extends` NAMES, and the member it names there. `id extends
 * PurchaseRequest.id` names PurchaseRequest even when PurchaseRequest inherits `id` from
 * an abstract base, which is where the resolved super node physically lives.
 */
function extendedMember(f: MetaData): { owner: MetaData; member: string } | undefined {
  const ref = f.superRef;
  const sup = f.superResolved;
  if (ref === undefined || sup === undefined) return undefined;
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dot > segStart) {
    const named = resolveObjectRef(f.root(), ref.slice(0, dot), referrerPackageOf(f)).node;
    if (named !== undefined) return { owner: named, member: sup.name };
  }
  const parent = sup.parent;
  return parent !== undefined && parent.type === TYPE_OBJECT ? { owner: parent, member: sup.name } : undefined;
}

/** The entities whose whole primary key a value object borrows, once: every primary key field
 *  of the `object.entity` is extended by exactly one field of the value. A value that borrows
 *  part of a composite key, or one key field twice (`fromId` and `toId`), names no single row of
 *  that entity, so it borrows nothing from it. */
function borrowedKeyEntities(value: MetaData): MetaData[] {
  const counts = new Map<MetaData, Map<string, number>>();
  for (const f of value.children()) {
    if (f.type !== TYPE_FIELD) continue;
    const ext = extendedMember(f);
    if (ext === undefined || ext.owner.subType !== OBJECT_SUBTYPE_ENTITY) continue;
    if (!primaryKeyFields(ext.owner).includes(ext.member)) continue;
    const members = counts.get(ext.owner) ?? new Map<string, number>();
    members.set(ext.member, (members.get(ext.member) ?? 0) + 1);
    counts.set(ext.owner, members);
  }
  return [...counts]
    .filter(([owner, members]) => primaryKeyFields(owner).every((k) => members.get(k) === 1))
    .map(([owner]) => owner);
}

/** The base entity of a projection: the entity its extended identity names, else the one
 *  entity its extended fields name. Undefined when there is none or more than one. */
export function projectionBaseEntity(projection: MetaData): MetaData | undefined {
  for (const id of projection.children()) {
    if (id.type !== TYPE_IDENTITY) continue;
    const ext = extendedMember(id);
    if (ext !== undefined && ext.owner.subType === OBJECT_SUBTYPE_ENTITY) return ext.owner;
  }
  const owners: MetaData[] = [];
  for (const f of projection.children()) {
    if (f.type !== TYPE_FIELD) continue;
    const ext = extendedMember(f);
    if (ext !== undefined && ext.owner.subType === OBJECT_SUBTYPE_ENTITY && !owners.includes(ext.owner)) owners.push(ext.owner);
  }
  return owners.length === 1 ? owners[0] : undefined;
}

/** How an operation's target was derived. `key` means the input borrows the target's key. */
export interface DerivedTarget {
  readonly entity: MetaData;
  readonly via: "input" | "output";
}

/**
 * The target entity derived from an operation's shapes, or undefined:
 *  1. the one entity whose whole primary key the `@inputRef` value borrows (by `extends`),
 *     each key field once;
 *  2. else the `@outputRef`: an entity is its own target, a projection its base entity.
 * Whole keys of two entities, part of a key, or one key field borrowed twice derive nothing
 * from the input.
 */
export function deriveOperationTarget(op: MetaData): DerivedTarget | undefined {
  const inputRef = stringValue(op, OPERATION_ATTR_INPUT_REF);
  if (inputRef !== undefined) {
    const input = resolveObjectOn(op, inputRef);
    if (input !== undefined && input.subType === OBJECT_SUBTYPE_VALUE) {
      const borrowed = borrowedKeyEntities(input);
      if (borrowed.length === 1) return { entity: borrowed[0]!, via: "input" };
    }
  }
  const outputRef = stringValue(op, OPERATION_ATTR_OUTPUT_REF);
  if (outputRef !== undefined) {
    const output = resolveObjectOn(op, outputRef);
    if (output?.subType === OBJECT_SUBTYPE_ENTITY) return { entity: output, via: "output" };
    if (output?.subType === OBJECT_SUBTYPE_PROJECTION) {
      const base = projectionBaseEntity(output);
      if (base !== undefined) return { entity: base, via: "output" };
    }
  }
  return undefined;
}

/** The operation's target: the declared `@objectRef` when it names an entity, else the
 *  derived one. */
export function operationTarget(op: MetaData): MetaData | undefined {
  const declared = stringValue(op, OPERATION_ATTR_OBJECT_REF);
  if (declared !== undefined) {
    const node = resolveObjectOn(op, declared);
    return node?.subType === OBJECT_SUBTYPE_ENTITY ? node : undefined;
  }
  return deriveOperationTarget(op)?.entity;
}

/**
 * Whether the operation addresses one row of its target by key, so its derived path is
 * `/<collection>/{key}/<operation>`: its input borrows the target's key, or it is a
 * query with no input and no @many whose target comes from its output (a get by key).
 */
export function operationIsKeyed(op: MetaData): boolean {
  const derived = deriveOperationTarget(op);
  if (derived === undefined) return false;
  if (derived.via === "input") return true;
  return op.subType === OPERATION_SUBTYPE_QUERY &&
    stringValue(op, OPERATION_ATTR_INPUT_REF) === undefined &&
    op.attr(OPERATION_ATTR_MANY) !== true;
}
