// feature-combinations.ts — small metadata models that compose features PAIRWISE.
//
// WHY. Every corpus in the repo exercises each feature on its own: the shared model has a
// TPH hierarchy, an M:N self-join, required fields, defaults. None of them points a
// reference at a TPH subtype, declares one on an abstract level, or puts a required
// default on a subtype. The first real app built on MetaObjects found nine defects in an
// afternoon and every one sat where two features meet, with every gate green. Composing
// by hand does not scale — the interesting combinations are exactly the ones nobody
// thought to write — so this module enumerates feature AXES and picks a set of models
// covering every valid pair of values (a pairwise covering array), then builds each
// model as canonical JSON.
//
// Axes, each a place a real model varies:
//   hierarchy  none | tph | tph-mid       (tph-mid: an abstract level between base and subtypes)
//   holder     plain | base | subtype | mid   — the entity DECLARING the reference/relationship
//   target     plain | base | subtype | self  — the entity it POINTS AT
//   link       reference | one | m2m | m2m-self | m2m-symmetric
//   junction   surrogate | composite     (the M:N link table's primary key)
//   extra      none | required | required-default   (a non-key field on the holder)
//
// Entities: plain holder `Order`, plain target `Customer`; TPH base `Party`
// (@discriminator), subtypes `Carrier` (the subtype TARGET) and `Broker` (the subtype
// HOLDER); abstract level `Organization` between Party and Carrier; M:N link table `Link`.

export const AXES = {
  hierarchy: ["none", "tph", "tph-mid"],
  holder: ["plain", "base", "subtype", "mid"],
  target: ["plain", "base", "subtype", "self"],
  link: ["reference", "one", "m2m", "m2m-self", "m2m-symmetric"],
  junction: ["surrogate", "composite"],
  extra: ["none", "required", "required-default"],
} as const;

export type Axis = keyof typeof AXES;
export type Combination = { [A in Axis]: (typeof AXES)[A][number] };

const AXIS_NAMES = Object.keys(AXES) as Axis[];

function holderEntity(c: Combination): string {
  return { plain: "Order", base: "Party", subtype: "Broker", mid: "Organization" }[c.holder];
}

function targetEntity(c: Combination): string {
  return c.target === "self"
    ? holderEntity(c)
    : { plain: "Customer", base: "Party", subtype: "Carrier" }[c.target];
}

const isSelfJoin = (c: Combination) => c.link === "m2m-self" || c.link === "m2m-symmetric";
const isManyToMany = (c: Combination) => c.link === "m2m" || isSelfJoin(c);

/** Whether a combination describes a model the metamodel accepts and the axes mean. */
export function isValid(c: Combination): boolean {
  if (c.hierarchy === "none" && (c.holder !== "plain" || c.target === "base" || c.target === "subtype")) return false;
  if (c.holder === "mid" && c.hierarchy !== "tph-mid") return false;
  // A self-join points at its own declaring entity. A plain reference may too (a parent
  // pointer); a heterogeneous M:N may not.
  if (isSelfJoin(c) && c.target !== "self") return false;
  if (c.link === "m2m" && c.target === "self") return false;
  // A heterogeneous M:N needs two DIFFERENT entities.
  if (c.link === "m2m" && holderEntity(c) === targetEntity(c)) return false;
  // `@symmetric` / a self-join onto an abstract level has no concrete rows to join.
  if (c.holder === "mid" && c.target === "self") return false;
  // The link-table key only exists for M:N; pin it elsewhere so it does not multiply cases.
  if (!isManyToMany(c) && c.junction !== "surrogate") return false;
  return true;
}

function allCombinations(): Combination[] {
  let out: Array<Partial<Combination>> = [{}];
  for (const axis of AXIS_NAMES) {
    out = out.flatMap((partial) => AXES[axis].map((value) => ({ ...partial, [axis]: value })));
  }
  return (out as Combination[]).filter(isValid);
}

function pairsOf(c: Combination): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < AXIS_NAMES.length; i++) {
    for (let j = i + 1; j < AXIS_NAMES.length; j++) {
      const a = AXIS_NAMES[i]!;
      const b = AXIS_NAMES[j]!;
      pairs.push(`${a}=${c[a]}|${b}=${c[b]}`);
    }
  }
  return pairs;
}

/**
 * A deterministic pairwise covering set: every pair of axis values that occurs in SOME
 * valid combination occurs in at least one chosen combination. Greedy (pick whichever
 * candidate covers the most still-uncovered pairs, first in enumeration order on a tie),
 * so the set is stable across runs and a failing case keeps its name.
 */
export function pairwiseCombinations(): Combination[] {
  const candidates = allCombinations();
  const uncovered = new Set(candidates.flatMap(pairsOf));
  const chosen: Combination[] = [];
  while (uncovered.size > 0) {
    let best = candidates[0]!;
    let bestScore = -1;
    for (const c of candidates) {
      const score = pairsOf(c).filter((p) => uncovered.has(p)).length;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    chosen.push(best);
    for (const p of pairsOf(best)) uncovered.delete(p);
  }
  return chosen;
}

/** A stable, readable name for a combination. */
export function caseName(c: Combination): string {
  return AXIS_NAMES.map((a) => `${a}=${c[a]}`).join(" ");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const pk = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };
const idField = { "field.long": { name: "id" } };

/** The canonical-JSON model for one combination. */
export function buildModel(c: Combination): unknown {
  const holder = holderEntity(c);
  const target = targetEntity(c);
  const members = new Map<string, unknown[]>();
  const add = (entity: string, ...nodes: unknown[]) => members.get(entity)!.push(...nodes);

  const entities: Array<{ name: string; header: Record<string, unknown> }> = [
    { name: "Customer", header: {} },
    { name: "Order", header: {} },
  ];
  members.set("Customer", [{ "source.rdb": { "@table": "customers" } }, idField, pk]);
  members.set("Order", [{ "source.rdb": { "@table": "orders" } }, idField, pk]);

  if (c.hierarchy !== "none") {
    entities.push({ name: "Party", header: { "@discriminator": "partyType" } });
    members.set("Party", [
      { "source.rdb": { "@table": "parties" } },
      idField,
      { "field.enum": { name: "partyType", "@values": ["Carrier", "Broker"] } },
      pk,
    ]);
    if (c.hierarchy === "tph-mid") {
      entities.push({ name: "Organization", header: { extends: "Party", abstract: true } });
      members.set("Organization", [{ "field.string": { name: "legalName", "@maxLength": 80 } }]);
    }
    entities.push({
      name: "Carrier",
      header: { extends: c.hierarchy === "tph-mid" ? "Organization" : "Party", "@discriminatorValue": "Carrier" },
    });
    members.set("Carrier", [{ "field.string": { name: "scac", "@maxLength": 4 } }]);
    entities.push({ name: "Broker", header: { extends: "Party", "@discriminatorValue": "Broker" } });
    members.set("Broker", [{ "field.string": { name: "mcNumber", "@maxLength": 20 } }]);
  }

  if (c.extra !== "none") {
    add(holder, { "field.string": {
      name: "status",
      "@maxLength": 20,
      "@required": true,
      ...(c.extra === "required-default" ? { "@default": "open" } : {}),
    } });
  }

  if (c.link === "reference" || c.link === "one") {
    const fkField = c.target === "self" ? `parent${holder}Id` : `${lowerFirst(target)}Id`;
    add(holder,
      { "field.long": { name: fkField } },
      { "identity.reference": { name: `fk${fkField}`, "@fields": fkField, "@references": target } },
    );
    if (c.link === "one") {
      add(holder, { "relationship.association": {
        name: c.target === "self" ? "parent" : lowerFirst(target), "@cardinality": "one", "@objectRef": target,
        "@sourceRefField": fkField,
      } });
    }
  } else {
    const [sourceField, targetField] = isSelfJoin(c)
      ? [`from${holder}Id`, `to${holder}Id`]
      : [`${lowerFirst(holder)}Id`, `${lowerFirst(target)}Id`];
    const link: unknown[] = [
      { "source.rdb": { "@table": "links" } },
      ...(c.junction === "surrogate" ? [idField] : []),
      { "field.long": { name: sourceField, "@required": true } },
      { "field.long": { name: targetField, "@required": true } },
      c.junction === "surrogate"
        ? pk
        : { "identity.primary": { name: "pk", "@fields": [sourceField, targetField] } },
      { "identity.reference": { name: "fkSource", "@fields": sourceField, "@references": holder } },
      { "identity.reference": { name: "fkTarget", "@fields": targetField, "@references": target } },
    ];
    entities.push({ name: "Link", header: {} });
    members.set("Link", link);
    add(holder, { "relationship.association": {
      name: "related", "@cardinality": "many", "@objectRef": target, "@through": "Link",
      ...(c.link === "m2m-self" ? { "@sourceRefField": sourceField } : {}),
      ...(c.link === "m2m-symmetric" ? { "@symmetric": true } : {}),
    } });
  }

  return {
    "metadata.root": {
      package: "combo",
      children: entities.map(({ name, header }) => ({
        "object.entity": { name, ...header, children: members.get(name) },
      })),
    },
  };
}
