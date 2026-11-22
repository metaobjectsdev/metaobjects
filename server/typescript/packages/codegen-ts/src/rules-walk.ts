// The rules names of a model, one record per metadata package (ADR-0067 §1, layer 0; ADR-0066).
//
// The names layer is the tether between the model and hand-written code: a body, a policy or a
// grant table that names a state, a transition, a permission or an error code through these
// constants stops compiling when the model renames it. This walk collects what the model DERIVES
// as well as what it declares, from the same functions `meta verify`'s rules gate uses
// (`@metaobjectsdev/metadata`: lifecyclesOf, derivedCommandsOf, operationPermission,
// commandPermission), so a generated constant and a verify message cannot name two different
// permissions.
//
// It is engine, not emit: `rulesNamesFile()` renders these records, and an ejected copy of its
// renderer keeps calling this walk, so what the model means stays packaged while the file's shape
// is the adopter's.

import {
  OPERATION_ATTR_ERRORS,
  OPERATION_ATTR_TRANSITIONS,
  OPERATION_SUBTYPE_COMMAND,
  RESERVED_ERROR_CODES,
  claimedTransitions,
  commandPermission,
  derivedCommandsOf,
  effectivePackageOf,
  isPublicPoint,
  lifecyclesOf,
  modelEntities,
  modelOperations,
  operationPermission,
  operationTarget,
  rulesSettingsOfModel,
  terminalStates,
  topLevelNodeOf,
  transitionFrom,
  transitionTo,
  type MetaData,
} from "@metaobjectsdev/metadata";

/** The wire codes the enforcing shell answers on its own (ADR-0066 §6): the first five of the
 *  reserved codes. The rest of `RESERVED_ERROR_CODES` belongs to the API contract's transport. */
export const SHELL_ERROR_CODES = RESERVED_ERROR_CODES.slice(0, 5) as readonly string[];

/** One transition of a lifecycle. */
export interface RulesNamesTransition {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: string | undefined;
}

/** One lifecycle of an entity: an enum field with at least one transition. */
export interface RulesNamesLifecycle {
  /** The lifecycle's field. */
  readonly field: string;
  readonly states: readonly string[];
  /** The enum's @default (the loader refuses a lifecycle without one). */
  readonly initial: string | undefined;
  readonly terminal: readonly string[];
  readonly transitions: readonly RulesNamesTransition[];
}

/** A command derived from a transition (ADR-0066 §2): it takes the key and makes the transition. */
export interface RulesNamesCommand {
  /** The command's name, which is the transition's. */
  readonly name: string;
  /** The field of the lifecycle the transition belongs to. */
  readonly lifecycle: string;
  /** The permission it asks the policy about; undefined when the transition is `@public`. */
  readonly permission: string | undefined;
}

/** An entity's lifecycles and derived commands. */
export interface RulesNamesEntity {
  readonly name: string;
  readonly lifecycles: readonly RulesNamesLifecycle[];
  /** Empty for an abstract entity or one with no source, which derive no command. */
  readonly commands: readonly RulesNamesCommand[];
}

/** A declared operation. */
export interface RulesNamesOperation {
  readonly name: string;
  readonly kind: "command" | "query";
  /** The permission it asks the policy about; undefined when it is `@public`. */
  readonly permission: string | undefined;
  /** The transitions a command may make (`@transitions`). */
  readonly transitions: readonly string[];
  /** The business errors a command's body may return (`@errors`). */
  readonly errors: readonly string[];
}

/** The rules names of one metadata package. */
export interface RulesNamesPackage {
  /** The package (`acme::shop`), or `""` for a model with none. */
  readonly package: string;
  /** Entities of the package with at least one lifecycle, in model order. */
  readonly entities: readonly RulesNamesEntity[];
  /** The package's declared operations, once each, in model order. */
  readonly operations: readonly RulesNamesOperation[];
  /** Every permission a point of the package asks about, sorted and once each. */
  readonly permissions: readonly string[];
  /** Every business error the package's commands declare, sorted and once each. */
  readonly errors: readonly string[];
}

export interface RulesNamesOpts {
  /** Narrow which entities are walked (a generator's `filter`). An operation is kept when its
   *  target entity matches or it has none. */
  readonly matches?: (obj: MetaData) => boolean;
}

function strings(node: MetaData, attr: string): string[] {
  const v = node.attr(attr);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function packageOf(node: MetaData): string {
  return effectivePackageOf(topLevelNodeOf(node));
}

function entityNames(entity: MetaData, claimed: ReturnType<typeof claimedTransitions>, root: MetaData): RulesNamesEntity | undefined {
  const lifecycles = lifecyclesOf(entity);
  if (lifecycles.length === 0) return undefined;
  const lifecycleOf = new Map<MetaData, string>();
  const out: RulesNamesLifecycle[] = lifecycles.map((l) => {
    for (const t of l.transitions) lifecycleOf.set(t, l.field.name);
    return {
      field: l.field.name,
      states: l.states,
      initial: l.initial,
      terminal: terminalStates(l),
      transitions: l.transitions.map((t) => ({ name: t.name, from: transitionFrom(t), to: transitionTo(t) })),
    };
  });
  const commands = derivedCommandsOf(entity, claimed, rulesSettingsOfModel(root)).map((t) => ({
    name: t.name,
    lifecycle: lifecycleOf.get(t) ?? "",
    permission: commandPermission(entity, t),
  }));
  return { name: entity.name, lifecycles: out, commands };
}

function operationNames(op: MetaData): RulesNamesOperation {
  const kind = op.subType === OPERATION_SUBTYPE_COMMAND ? "command" : "query";
  return {
    name: op.name,
    kind,
    permission: isPublicPoint(op) ? undefined : operationPermission(op),
    transitions: kind === "command" ? strings(op, OPERATION_ATTR_TRANSITIONS) : [],
    errors: kind === "command" ? strings(op, OPERATION_ATTR_ERRORS) : [],
  };
}

/**
 * The rules names of every package that declares a lifecycle or an operation, sorted by package.
 * A package that declares neither has no record, so a model with no rules vocabulary yields `[]`.
 */
export function rulesNamesOf(root: MetaData, opts: RulesNamesOpts = {}): RulesNamesPackage[] {
  const matches = opts.matches ?? (() => true);
  const claimed = claimedTransitions(root);
  const byPackage = new Map<string, { entities: RulesNamesEntity[]; operations: RulesNamesOperation[] }>();
  const bucket = (pkg: string) => {
    let b = byPackage.get(pkg);
    if (b === undefined) { b = { entities: [], operations: [] }; byPackage.set(pkg, b); }
    return b;
  };

  for (const entity of modelEntities(root)) {
    if (!matches(entity)) continue;
    const names = entityNames(entity, claimed, root);
    if (names !== undefined) bucket(packageOf(entity)).entities.push(names);
  }

  // One operation declared identically by two APIs (a versioned API) is one operation (O6), so
  // it is listed once.
  const seen = new Set<string>();
  for (const op of modelOperations(root)) {
    const target = operationTarget(op);
    if (target !== undefined && !matches(target)) continue;
    const pkg = packageOf(op);
    const id = `${pkg}\u0000${op.name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    bucket(pkg).operations.push(operationNames(op));
  }

  return [...byPackage.keys()].sort().map((pkg) => {
    const { entities, operations } = byPackage.get(pkg)!;
    const permissions = new Set<string>();
    for (const e of entities) for (const c of e.commands) if (c.permission !== undefined) permissions.add(c.permission);
    for (const o of operations) if (o.permission !== undefined) permissions.add(o.permission);
    const errors = new Set(operations.flatMap((o) => o.errors));
    return {
      package: pkg,
      entities,
      operations,
      permissions: [...permissions].sort(),
      errors: [...errors].sort(),
    };
  });
}
