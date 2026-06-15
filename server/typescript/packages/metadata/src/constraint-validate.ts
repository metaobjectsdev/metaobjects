// FR-033 — the metamodel contradiction validator (spec §3.1, the six checks).
//
// `validateConstraints(effective, registry)` runs the six contradiction checks over
// the merged constraint graph and returns one MetaModelError per contradiction
// (code ERR_INVALID_METAMODEL_CONSTRAINT). It is the cross-validation pass: the merge
// (constraint-merge.ts) is purely additive, so this pass is the ONLY place a bad
// provider set is rejected. Wired into composeRegistry's seal-time bootstrap so a
// contradictory library provider set fails fast (mirrors ADR-0023 strictness).
//
// The six checks (spec §3.1):
//   1. Dangling ref       — a parents/children rule references an unregistered type.subType.
//   2. Unsatisfiable req.  — a required child (min>=1) whose concrete type.subType is
//                            not admitted under that parent (after merge).
//   3. Bad cardinality     — min>max (max non-null), max:0 with min>=1, or min<0.
//   4. Closed-set clash    — child C claims parent P via `parents`, but P's OWN children
//                            is a CLOSED set (no `*` wildcard) that does not admit C.
//   5. Required-child cycle— following required (min>=1) child edges forms a cycle.
//   6. Conflicting attr    — same attr name contributed twice (across providers or the
//                            extends chain) with a conflicting valueType/required/default.

import type {
  AttrSchema,
  ChildRule,
  TypeRegistry,
  TypeDefinition,
} from "./registry.js";
import { childRuleMatches } from "./registry.js";
import { CHILD_RULE_WILDCARD } from "./shared/structural.js";
import { SUBTYPE_BASE } from "./shared/base-types.js";
import { MetaModelError } from "./errors.js";
import type { EffectiveConstraints } from "./constraint-merge.js";

const CODE = "ERR_INVALID_METAMODEL_CONSTRAINT" as const;

/** Run the six contradiction checks; one MetaModelError per contradiction. */
export function validateConstraints(
  effective: Map<string, EffectiveConstraints>,
  registry: TypeRegistry,
): MetaModelError[] {
  const errors: MetaModelError[] = [];
  const registered = new Set(
    registry.allTypes().map((id) => `${id.type}.${id.subType}`),
  );

  const sortedKeys = [...effective.keys()].sort();

  for (const k of sortedKeys) {
    const eff = effective.get(k)!;

    // --- #1 dangling ref (children) + #3 bad cardinality.
    for (const rule of eff.children) {
      checkDangling(k, rule, registered, errors);
      checkCardinality(k, rule, errors);
    }

    // --- #1 dangling ref (parents).
    for (const parent of eff.parents) {
      if (!registered.has(parent)) {
        errors.push(
          err(`dangling: type "${k}" claims parent "${parent}", which is not registered.`),
        );
      }
    }

    // --- #2 unsatisfiable required child.
    for (const rule of eff.children) {
      checkUnsatisfiable(k, rule, registered, errors);
    }
  }

  // --- #4 closed-set clash: a child's `parents` claim vs the parent's OWN children.
  for (const id of registry.allTypes()) {
    const childKey = `${id.type}.${id.subType}`;
    const def = registry.find(id.type, id.subType);
    for (const parent of def?.parents ?? []) {
      checkClosedSetClash(childKey, id.type, id.subType, parent, registry, errors);
    }
  }

  // --- #5 required-child cycle.
  checkRequiredCycles(effective, sortedKeys, errors);

  // --- #6 conflicting attr redefinition (across the extends chain + providers).
  for (const id of registry.allTypes()) {
    checkAttrConflicts(id.type, id.subType, registry, registered, errors);
  }

  return errors;
}

function err(detail: string): MetaModelError {
  return new MetaModelError(`Invalid metamodel constraint — ${detail}`, { code: CODE });
}

/** #1 — a concrete (non-wildcard) child rule whose type.subType is unregistered. */
function checkDangling(
  parentKey: string,
  rule: ChildRule,
  registered: ReadonlySet<string>,
  errors: MetaModelError[],
): void {
  if (rule.childType === CHILD_RULE_WILDCARD) return; // a wildcard names nothing
  const subTypes = subTypesOf(rule);
  for (const sub of subTypes) {
    if (sub === CHILD_RULE_WILDCARD) continue; // wildcard subtype names nothing
    const refKey = `${rule.childType}.${sub}`;
    if (!registered.has(refKey)) {
      errors.push(
        err(
          `dangling: child rule on "${parentKey}" references "${refKey}", which is not registered.`,
        ),
      );
    }
  }
}

/** #3 — min<0, min>max (max non-null), or max:0 with min>=1. */
function checkCardinality(
  parentKey: string,
  rule: ChildRule,
  errors: MetaModelError[],
): void {
  const min = rule.min ?? 0;
  const max = rule.max ?? null;
  const label = describeRule(rule);
  if (min < 0) {
    errors.push(err(`bad cardinality on "${parentKey}" (${label}): min ${min} < 0.`));
    return;
  }
  if (max !== null && max < min) {
    errors.push(
      err(`bad cardinality on "${parentKey}" (${label}): min ${min} > max ${max}.`),
    );
    return;
  }
  if (max === 0 && min >= 1) {
    errors.push(
      err(`bad cardinality on "${parentKey}" (${label}): max 0 with min ${min} >= 1.`),
    );
  }
}

/**
 * #2 — a required child rule (min>=1) naming concrete subtype(s) where NONE of the
 * named type.subTypes is admitted under this parent (after merge). A required rule
 * with a wildcard type is always satisfiable; a required rule naming a concrete
 * subtype that is registered AND covered by an admitting rule (the rule itself, or
 * another rule) is satisfiable. Unsatisfiable iff the required child cannot be placed.
 */
function checkUnsatisfiable(
  parentKey: string,
  rule: ChildRule,
  registered: ReadonlySet<string>,
  errors: MetaModelError[],
): void {
  const min = rule.min ?? 0;
  if (min < 1) return; // optional → nothing to satisfy
  if (rule.childType === CHILD_RULE_WILDCARD) return; // any child satisfies it

  // A required rule must name at least one concrete, REGISTERED subtype that some
  // rule (incl. itself) admits. If none of its named subtypes is registered, the
  // required child can never be instantiated → unsatisfiable.
  const subTypes = subTypesOf(rule);
  const concrete = subTypes.filter((s) => s !== CHILD_RULE_WILDCARD);
  if (concrete.length === 0) return; // required of `type.*` — any registered subtype satisfies

  const anyRegistered = concrete.some((s) => registered.has(`${rule.childType}.${s}`));
  if (!anyRegistered) {
    errors.push(
      err(
        `unsatisfiable required child on "${parentKey}" (${describeRule(rule)}): ` +
          `min ${min} but no named subtype of "${rule.childType}" is registered.`,
      ),
    );
  }
}

/**
 * #4 — child C declares parent P via `parents`, but P's OWN children is a CLOSED set
 * (no `*` wildcard rule) that does not admit C. An OPEN parent (any `*` rule) admits
 * anything → no clash.
 */
function checkClosedSetClash(
  childKey: string,
  childType: string,
  childSubType: string,
  parentKey: string,
  registry: TypeRegistry,
  errors: MetaModelError[],
): void {
  const parentDef = lookup(parentKey, registry);
  if (parentDef === undefined) return; // dangling parent — reported by #1

  const ownRules = parentDef.childRules;
  const isOpen = ownRules.some((r) => isWildcardRule(r));
  if (isOpen) return; // open parent admits anything

  const admits = ownRules.some((r) =>
    childRuleMatches(r, { type: childType, subType: childSubType, name: CHILD_RULE_WILDCARD }),
  );
  if (!admits) {
    errors.push(
      err(
        `closed-set clash: child "${childKey}" claims parent "${parentKey}", but ` +
          `"${parentKey}"'s children is a closed set (no wildcard) that does not admit it.`,
      ),
    );
  }
}

/**
 * #5 — required-child cycle: following required (min>=1) child edges forms a cycle.
 * An edge A→B exists when A has a required rule naming a concrete subtype B. A cycle
 * with no non-required escape can never bottom out (A requires B requires A).
 */
function checkRequiredCycles(
  effective: Map<string, EffectiveConstraints>,
  sortedKeys: string[],
  errors: MetaModelError[],
): void {
  // Build the required-edge adjacency: A → each concrete required child subtype.
  const edges = new Map<string, string[]>();
  for (const k of sortedKeys) {
    const targets: string[] = [];
    for (const rule of effective.get(k)!.children) {
      if ((rule.min ?? 0) < 1) continue;
      if (rule.childType === CHILD_RULE_WILDCARD) continue;
      for (const sub of subTypesOf(rule)) {
        if (sub === CHILD_RULE_WILDCARD) continue;
        targets.push(`${rule.childType}.${sub}`);
      }
    }
    edges.set(k, targets);
  }

  // DFS for back-edges; report each distinct cycle once (keyed by its sorted node set).
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const reported = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue; // unregistered target — #1/#2 handles it
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Back-edge → cycle. Extract the cycle slice from the stack.
        const idx = stack.indexOf(next);
        const cycle = stack.slice(idx);
        const sig = [...cycle].sort().join(",");
        if (!reported.has(sig)) {
          reported.add(sig);
          errors.push(
            err(
              `required-child cycle that cannot bottom out: ${cycle.concat(next).join(" -> ")}.`,
            ),
          );
        }
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const k of sortedKeys) {
    if ((color.get(k) ?? WHITE) === WHITE) visit(k);
  }
}

/**
 * #6 — the same attr name contributed twice (across providers, or down the extends
 * chain) with a CONFLICTING valueType / required / default. Walks each type's own
 * attrs + its derived super (`<type>.base`) chain and compares same-name pairs.
 */
function checkAttrConflicts(
  type: string,
  subType: string,
  registry: TypeRegistry,
  registered: ReadonlySet<string>,
  errors: MetaModelError[],
): void {
  // Collect (attr, source-key) along the own → super chain.
  const seen = new Map<string, { attr: AttrSchema; from: string }>();
  const reported = new Set<string>();

  let curType: string | undefined = type;
  let curSub: string | undefined = subType;
  const guard = new Set<string>();
  while (curType !== undefined && curSub !== undefined) {
    const k = `${curType}.${curSub}`;
    if (guard.has(k)) break;
    guard.add(k);
    const def = registry.find(curType, curSub);
    if (def !== undefined) {
      for (const attr of def.attributes) {
        const prior = seen.get(attr.name);
        if (prior === undefined) {
          seen.set(attr.name, { attr, from: k });
        } else if (attrsConflict(prior.attr, attr)) {
          const sig = `${attr.name}|${prior.from}|${k}`;
          if (!reported.has(sig)) {
            reported.add(sig);
            errors.push(
              err(
                `conflicting attr redefinition: attr "${attr.name}" is declared on ` +
                  `"${prior.from}" and "${k}" with a conflicting valueType/required/default.`,
              ),
            );
          }
        }
      }
    }
    // Advance up the derived super chain (`<type>.base`).
    if (curSub === SUBTYPE_BASE) break;
    const baseKey = `${curType}.${SUBTYPE_BASE}`;
    if (!registered.has(baseKey)) break;
    curSub = SUBTYPE_BASE;
  }
}

/** Two same-name attrs conflict iff valueType, required, or default differ. */
function attrsConflict(a: AttrSchema, b: AttrSchema): boolean {
  return (
    a.valueType !== b.valueType ||
    a.required !== b.required ||
    !Object.is(a.default, b.default)
  );
}

// --- helpers ---------------------------------------------------------------

function subTypesOf(rule: ChildRule): string[] {
  const s = rule.childSubType;
  return typeof s === "string" ? [s] : [...s];
}

function isWildcardRule(rule: ChildRule): boolean {
  // An OPEN hook is a TYPE-wildcard rule (`*.*` / `*` of any subType) — it admits a
  // child of any type, so a new type can land under this parent. A `field.*` rule is
  // NOT open in this sense: it admits any field SUBTYPE but no other type, so a
  // `policy` child still clashes. Per spec §3.1 #4, the open escape is a `*` (type)
  // wildcard rule.
  return rule.childType === CHILD_RULE_WILDCARD;
}

function describeRule(rule: ChildRule): string {
  const sub = Array.isArray(rule.childSubType)
    ? `[${rule.childSubType.join(",")}]`
    : rule.childSubType;
  return `${rule.childType}.${sub} ${rule.childName}`;
}

function lookup(key: string, registry: TypeRegistry): TypeDefinition | undefined {
  const dot = key.indexOf(".");
  if (dot < 0) return undefined;
  return registry.find(key.slice(0, dot), key.slice(dot + 1));
}
