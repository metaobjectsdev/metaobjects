// `meta verify` — the business-rules gate (ADR-0066).
//
// The loader refuses a model whose operations or lifecycles are malformed. This gate reports
// what loads clean but is almost certainly not what the author meant: a state nothing can
// reach, a lifecycle that cannot move, a transition nothing can make, and (by setting) a
// permission name the model derived instead of declaring.
//
// TypeScript is the reference. Every port's `verify` implements these checks with the same
// codes, severities, paths and message text, and `fixtures/rules-check-conformance/` is the
// contract. A model that declares no operation and no transition gets no diagnostics, no
// summary and no gate row: opt-in by declaration, so an existing project sees no change.
//
// Checks, in the order they are reported:
//   WARN_LIFECYCLE_UNREACHABLE_STATE   states no transition reaches from the initial state
//                                      (severity: `verify.lifecycle.unreachable`)
//   WARN_LIFECYCLE_INITIAL_TERMINAL    the initial state is one no transition leaves
//   WARN_TRANSITION_UNREACHABLE        a transition whose every @from state is unreachable
//                                      (severity: `verify.lifecycle.unreachable`)
//   WARN_TRANSITION_PERMISSION_SHADOWED a transition declaring @permission or @public: true that
//                                      derives no command of its own, so the attribute is never
//                                      read (always a warning)
//   WARN_PERMISSION_DERIVED_NAME       a transition that derives its own command, or an
//                                      operation, with no @permission and not @public
//                                      (severity: `rules.permissions.names`)
//
// Lifecycles are checked once per declaring field, so a lifecycle on an abstract base is
// reported once, not once per inheritor. A derived command exists per concrete entity that has
// a source, so the permission checks run per such entity and name it; a lifecycle on an entity
// with no source is inert and derives no command (lifecycleIsLive).
//
// A derived permission name includes its owner: `<package>.<Entity>.<transition>` for a
// transition's derived command, `<package>.<operation>` for a declared operation (the loader
// keeps operation names unique per package).
//
// A command claims a transition NODE for its target entity and every entity that extends the
// target: a command acting on an abstract base claims the inherited transition of each child.

import {
  OPERATION_ATTR_PERMISSION,
  OPERATION_ATTR_PUBLIC,
  PACKAGE_SEPARATOR,
  claimedTransitions,
  claimsOn,
  commandEntities,
  derivedPermissionName,
  derivesCommand,
  effectivePackageOf,
  entityTransitions,
  lifecyclesOf,
  modelEntities,
  modelOperations,
  needsPermissionName,
  reachableStates,
  terminalStates,
  topLevelNodeOf,
  transitionFrom,
  type Lifecycle,
  type MetaData,
  type RulesSettings,
} from "@metaobjectsdev/metadata";
import type { Diagnostic, Severity } from "./requirement-check.js";

export const WARN_LIFECYCLE_UNREACHABLE_STATE = "WARN_LIFECYCLE_UNREACHABLE_STATE";
export const WARN_LIFECYCLE_INITIAL_TERMINAL = "WARN_LIFECYCLE_INITIAL_TERMINAL";
export const WARN_TRANSITION_UNREACHABLE = "WARN_TRANSITION_UNREACHABLE";
export const WARN_PERMISSION_DERIVED_NAME = "WARN_PERMISSION_DERIVED_NAME";
export const WARN_TRANSITION_PERMISSION_SHADOWED = "WARN_TRANSITION_PERMISSION_SHADOWED";

/** What the model declares, for the line `meta verify` prints on every run. */
export interface RulesSummary {
  /** Declared operations, across every `api.operational`. */
  readonly operations: number;
  /** Lifecycles: enum fields that declare at least one transition. */
  readonly lifecycles: number;
  /** Declared transitions, across every lifecycle. */
  readonly transitions: number;
}

export interface RulesCheckResult {
  readonly diagnostics: Diagnostic[];
  /** Undefined when the model declares no operation and no transition. */
  readonly summary: RulesSummary | undefined;
}

function quoteList(xs: readonly string[]): string {
  return xs.map((x) => `"${x}"`).join(", ");
}

/** A node's package-qualified address: `acme::shop::Order.status.submit`. */
export function rulesAddress(node: MetaData): string {
  const parts: string[] = [];
  for (let n: MetaData | undefined = node; n !== undefined && n.parent !== undefined; n = n.parent) {
    if (n.name !== "") parts.unshift(n.name);
  }
  const pkg = effectivePackageOf(topLevelNodeOf(node));
  return pkg === "" ? parts.join(".") : `${pkg}${PACKAGE_SEPARATOR}${parts.join(".")}`;
}

/** Every lifecycle of the model, once per declaring field, in model order. */
function declaredLifecycles(root: MetaData): Lifecycle[] {
  const seen = new Set<MetaData>();
  const out: Lifecycle[] = [];
  for (const entity of modelEntities(root)) {
    for (const l of lifecyclesOf(entity)) {
      if (seen.has(l.field)) continue;
      seen.add(l.field);
      out.push(l);
    }
  }
  return out;
}

function checkLifecycle(l: Lifecycle, settings: RulesSettings, out: Diagnostic[]): void {
  const where = rulesAddress(l.field);
  const initial = l.initial;
  if (initial === undefined) return; // the loader refused this model (ERR_LIFECYCLE_NO_INITIAL)
  const reachable = reachableStates(l);
  const unreachableSeverity: Severity | undefined =
    settings.lifecycleUnreachable === "off" ? undefined : settings.lifecycleUnreachable;

  if (unreachableSeverity !== undefined) {
    const unreachable = l.states.filter((s) => !reachable.has(s));
    if (unreachable.length > 0) {
      out.push({
        severity: unreachableSeverity,
        code: WARN_LIFECYCLE_UNREACHABLE_STATE,
        path: where,
        message:
          `${unreachable.length === 1 ? "state" : "states"} ${quoteList(unreachable)} of "${l.field.name}" ` +
          `cannot be reached from the initial state "${initial}" by any transition. ` +
          `Add the transition that leads there, or set verify.lifecycle.unreachable if only seeded data uses ` +
          `${unreachable.length === 1 ? "it" : "them"}.`,
      });
    }
  }

  if (terminalStates(l).includes(initial)) {
    out.push({
      severity: "warn",
      code: WARN_LIFECYCLE_INITIAL_TERMINAL,
      path: where,
      message:
        `the initial state "${initial}" of "${l.field.name}" is terminal: no transition leaves it, ` +
        `so no row of this lifecycle can ever move.`,
    });
  }

  if (unreachableSeverity !== undefined) {
    for (const t of l.transitions) {
      const from = transitionFrom(t);
      if (from.length === 0 || from.some((s) => reachable.has(s))) continue;
      out.push({
        severity: unreachableSeverity,
        code: WARN_TRANSITION_UNREACHABLE,
        path: rulesAddress(t),
        message:
          `transition "${t.name}" starts only from ${quoteList(from)}, which no transition reaches from ` +
          `the initial state "${initial}", so it can never be made.`,
      });
    }
  }
}

/** A transition's @permission or @public is read only by the command derived from it. One that
 *  derives no command for any entity carrying it declares an attribute nothing reads. A transition
 *  carried only by entities with no source is inert, not shadowed: it is not reported. */
function checkShadowedPermissions(root: MetaData, settings: RulesSettings, out: Diagnostic[]): void {
  if (settings.lifecycleCommands === "all") return;
  const claimed = claimedTransitions(root);
  const carriers = new Map<MetaData, MetaData[]>();
  for (const entity of commandEntities(root)) {
    for (const t of entityTransitions(entity)) carriers.set(t, [...(carriers.get(t) ?? []), entity]);
  }
  for (const [t, entitiesWithT] of carriers) {
    const permission = t.attr(OPERATION_ATTR_PERMISSION);
    const isPublic = t.attr(OPERATION_ATTR_PUBLIC) === true;
    if (permission === undefined && !isPublic) continue;
    if (entitiesWithT.some((e) => derivesCommand(claimed, settings, e, t))) continue;
    const declared = permission !== undefined ? `@permission "${String(permission)}"` : "@public: true";
    const claimers = [...new Set(entitiesWithT.flatMap((e) => claimsOn(claimed, e, t))
      .map((c) => `${c.op.parent?.name ?? ""}.${c.op.name}`))];
    const why = settings.lifecycleCommands === "none"
      ? `rules.lifecycle.commands is "none": no command is derived from it`
      : `it derives no command of its own: it is made only by ${quoteList(claimers)}, which ` +
        `${claimers.length === 1 ? "asks" : "ask"} the policy about ${claimers.length === 1 ? "its" : "their"} own permission`;
    out.push({
      severity: "warn",
      code: WARN_TRANSITION_PERMISSION_SHADOWED,
      path: rulesAddress(t),
      message:
        `transition "${t.name}" declares ${declared}, but ${why}, so the attribute is never read. ` +
        `Remove it from the transition, or declare it on the command that makes the transition.`,
    });
  }
}

function checkPermissionNames(root: MetaData, settings: RulesSettings, out: Diagnostic[]): void {
  if (settings.permissionNames === "derive") return;
  const severity: Severity = settings.permissionNames === "require" ? "error" : "warn";
  const advice = (kind: string): string =>
    `which changes if the ${kind} is renamed. Declare @permission, or @public: true.`;

  if (settings.lifecycleCommands !== "none") {
    const claimed = claimedTransitions(root);
    for (const entity of commandEntities(root)) {
      for (const t of entityTransitions(entity)) {
        if (!derivesCommand(claimed, settings, entity, t)) continue;
        if (!needsPermissionName(t)) continue;
        out.push({
          severity,
          code: WARN_PERMISSION_DERIVED_NAME,
          path: `${rulesAddress(entity)}.${t.parent?.name ?? ""}.${t.name}`,
          message:
            `the command derived from transition "${t.name}" of "${entity.name}" has no @permission, so it asks ` +
            `the policy about the derived name "${derivedPermissionName(entity, `${entity.name}.${t.name}`)}", ${advice("transition")}`,
        });
      }
    }
  }

  for (const op of modelOperations(root)) {
    if (!needsPermissionName(op)) continue;
    out.push({
      severity,
      code: WARN_PERMISSION_DERIVED_NAME,
      path: rulesAddress(op),
      message:
        `operation.${op.subType} "${op.name}" has no @permission, so it asks the policy about the derived ` +
        `name "${derivedPermissionName(op, op.name)}", ${advice("operation")}`,
    });
  }
}

/** The rules gate over a loaded model. */
export function checkRules(root: MetaData, settings: RulesSettings): RulesCheckResult {
  const lifecycles = declaredLifecycles(root);
  const ops = modelOperations(root);
  if (lifecycles.length === 0 && ops.length === 0) return { diagnostics: [], summary: undefined };

  const diagnostics: Diagnostic[] = [];
  for (const l of lifecycles) checkLifecycle(l, settings, diagnostics);
  checkShadowedPermissions(root, settings, diagnostics);
  checkPermissionNames(root, settings, diagnostics);
  return {
    diagnostics,
    summary: {
      operations: ops.length,
      lifecycles: lifecycles.length,
      transitions: lifecycles.reduce((n, l) => n + l.transitions.length, 0),
    },
  };
}
