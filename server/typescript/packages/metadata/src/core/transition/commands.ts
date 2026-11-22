// Permission points and derived commands (ADR-0066 §1, §2), shared by `meta verify`'s rules gate
// and the generators that read the rules vocabulary. Like lifecycle.ts, everything here is
// DERIVED: which transitions get a command of their own, and the permission name each point
// asks the policy about when it declares none. Every port derives these the same way.
//
// A command claims a transition NODE for its target entity and every entity that extends the
// target: a command acting on an abstract base claims the inherited transition of each child.
// A derived command exists per concrete entity with a source (lifecycleIsLive), and the
// `rules.lifecycle.commands` setting decides which transitions derive one.

import type { MetaData } from "../../shared/meta-data.js";
import { TYPE_API, TYPE_OBJECT, TYPE_OPERATION } from "../../shared/base-types.js";
import { OBJECT_SUBTYPE_ENTITY } from "../object/object-constants.js";
import { effectivePackageOf, topLevelNodeOf } from "../../naming-refs.js";
import {
  OPERATION_ATTR_PERMISSION,
  OPERATION_ATTR_PUBLIC,
  OPERATION_ATTR_TRANSITIONS,
  OPERATION_SUBTYPE_COMMAND,
} from "../api/api-constants.js";
import type { RulesSettings } from "../../rules-settings.js";
import { entityLineage, entityTransitions, lifecycleIsLive, operationTarget } from "./lifecycle.js";

/** The root's `object.entity` children, in model order. */
export function modelEntities(root: MetaData): MetaData[] {
  return root.children().filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_ENTITY);
}

/** Every declared operation, across every `api.*` of the root, in model order. */
export function modelOperations(root: MetaData): MetaData[] {
  return root.children()
    .filter((c) => c.type === TYPE_API)
    .flatMap((api) => api.children().filter((c) => c.type === TYPE_OPERATION));
}

/** One command's claim on a transition node, made for its target entity. */
export interface TransitionClaim {
  readonly target: MetaData;
  readonly op: MetaData;
}

/** Each transition node the declared commands claim, with the claims on it in model order. */
export function claimedTransitions(root: MetaData): Map<MetaData, TransitionClaim[]> {
  const claimed = new Map<MetaData, TransitionClaim[]>();
  for (const op of modelOperations(root)) {
    if (op.subType !== OPERATION_SUBTYPE_COMMAND) continue;
    const target = operationTarget(op);
    if (target === undefined) continue;
    const raw = op.attr(OPERATION_ATTR_TRANSITIONS);
    const names = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
    for (const t of entityTransitions(target)) {
      if (!names.has(t.name)) continue;
      const claims = claimed.get(t) ?? [];
      claims.push({ target, op });
      claimed.set(t, claims);
    }
  }
  return claimed;
}

/** The claims that cover transition `t` on `entity`: those made for the entity or an entity it extends. */
export function claimsOn(claimed: Map<MetaData, TransitionClaim[]>, entity: MetaData, t: MetaData): TransitionClaim[] {
  const lineage = entityLineage(entity);
  return (claimed.get(t) ?? []).filter((c) => lineage.includes(c.target));
}

/** Whether `t`, carried by `entity`, derives a command of its own under the setting. */
export function derivesCommand(
  claimed: Map<MetaData, TransitionClaim[]>,
  settings: Pick<RulesSettings, "lifecycleCommands">,
  entity: MetaData,
  t: MetaData,
): boolean {
  if (settings.lifecycleCommands === "none") return false;
  if (settings.lifecycleCommands === "all") return true;
  return claimsOn(claimed, entity, t).length === 0;
}

/** The entities a transition can derive a command on: concrete, with a source. */
export function commandEntities(root: MetaData): MetaData[] {
  return modelEntities(root).filter((e) => !e.isAbstract && lifecycleIsLive(e));
}

/** The transitions of `entity` that derive a command of their own, in lifecycle order. Empty for
 *  an abstract entity or one with no source: such an entity derives no command. */
export function derivedCommandsOf(
  entity: MetaData,
  claimed: Map<MetaData, TransitionClaim[]>,
  settings: Pick<RulesSettings, "lifecycleCommands">,
): MetaData[] {
  if (entity.isAbstract || !lifecycleIsLive(entity)) return [];
  return entityTransitions(entity).filter((t) => derivesCommand(claimed, settings, entity, t));
}

/**
 * The permission name a point gets when it declares none, `<package>.<path>`: the path is
 * `<operation>` for a declared operation and `<Entity>.<transition>` for a transition's derived
 * command, so two entities' transitions of one name ask about different permissions. With no
 * package the prefix is dropped.
 */
export function derivedPermissionName(owner: MetaData, path: string): string {
  const pkg = effectivePackageOf(topLevelNodeOf(owner));
  return pkg === "" ? path : `${pkg}.${path}`;
}

/** Whether a point is `@public: true`: the shell calls no permission check for it. */
export function isPublicPoint(node: MetaData): boolean {
  return node.attr(OPERATION_ATTR_PUBLIC) === true;
}

/** Whether a point declares neither `@permission` nor `@public: true`, so it asks about a derived name. */
export function needsPermissionName(node: MetaData): boolean {
  return node.attr(OPERATION_ATTR_PERMISSION) === undefined && !isPublicPoint(node);
}

/** The permission a declared operation asks the policy about: its `@permission`, else the derived
 *  `<package>.<operation>`. Undefined for a `@public` operation, which asks about none. */
export function operationPermission(op: MetaData): string | undefined {
  if (isPublicPoint(op)) return undefined;
  const declared = op.attr(OPERATION_ATTR_PERMISSION);
  return typeof declared === "string" ? declared : derivedPermissionName(op, op.name);
}

/** The permission a transition's derived command on `entity` asks about: the transition's
 *  `@permission`, else the derived `<package>.<Entity>.<transition>` with the concrete entity's
 *  package. Undefined for a `@public` transition. */
export function commandPermission(entity: MetaData, t: MetaData): string | undefined {
  if (isPublicPoint(t)) return undefined;
  const declared = t.attr(OPERATION_ATTR_PERMISSION);
  return typeof declared === "string" ? declared : derivedPermissionName(entity, `${entity.name}.${t.name}`);
}
