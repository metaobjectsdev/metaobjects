// SP-G Registry Conformance — the TS reference emitter.
//
// Walks an assembled core TypeRegistry and serializes the LOGICAL metamodel
// vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This is
// the single-source contract the other four ports (C#, Java, Kotlin, Python)
// must byte-match — a structural gate against the SP-C class of silent
// vocabulary drift (a port's registry diverging — wrong attr names, missing
// subtypes, different required-ness — with every behavioral corpus still green).
//
// The IN/OUT boundary is documented in fixtures/registry-conformance/README.md.
// In short, the manifest emits: type.subType + per-type/per-attr `description`
// (FR-033) + attrs[{name, valueType, isArray, required, allowedValues?,
// description, rules?, example?, whenToUse?}] + the structural constraint graph
// (children / parents / cardinality, FR-033) + commonAttrs + defaultSubTypes.
// `allowedValues` (ADR-0036 Wave 1, decision 5) is the closed value-set of a
// closed-enum attr — emitted ONLY when the attr declares one, OMITTED for open /
// format-validated attrs (@currency, @locale). It byte-gates closed vocabularies
// cross-port (the gate that catches a value-set silently drifting between ports).
// EXCLUDED (per-port-physical or not-universally-tracked-on-the-registry):
// factories/native bindings; AttrSchema.default.
//
// FR-033 Task 5 GREW the manifest: it now also emits the documentation surface
// (every type/attr carries a required, non-empty `description`; optional `rules`/
// `example`/`whenToUse`) AND the full structural constraint graph (each type's
// `children` from childRules — childType/childSubType/childName + optional
// cardinality min/max/named — and optional `parents`). Growing the canonical
// RED-flags the other four ports' registry-conformance until they reconcile
// (the intended intermediate state, same as the FR-032 sweep).

import type { AttrSchema, ChildRule, TypeDefinition, TypeRegistry } from "./registry.js";
import { ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_STRINGARRAY } from "./core/attr/attr-constants.js";
import {
  EXCLUDED_PER_TYPE_ATTRS,
  ExclusionReason,
  isExcludedTypeSubType,
  manifestRequiredOverride,
} from "./registry-manifest-exclusions.js";

/** One attribute in the manifest — the logical, cross-port-identical facet. */
interface ManifestAttr {
  name: string;
  /** The attr's SCALAR value-type subtype, or null for a polymorphic/untyped attr (e.g. @default). */
  valueType: string | null;
  /** True for an array-valued attr (a list of the scalar `valueType`); the orthogonal array axis. */
  isArray: boolean;
  required: boolean;
  /**
   * The closed value-set of a closed-enum attr (ADR-0036 Wave 1, decision 5).
   * Emitted ONLY when the attr declares a non-empty `allowedValues` set; OMITTED
   * for open / format-validated attrs (e.g. @currency ISO-4217, @locale BCP-47).
   * This byte-gates closed-enum vocabularies cross-port — the gate that catches a
   * value-set drifting between ports (the failure mode the dbColumnType slim hit).
   */
  allowedValues?: readonly string[];
  /** FR-033 — human/AI-facing description of the attribute (required, non-empty). */
  description: string;
  /** FR-033 — prose documenting the complex rules enforced in code. Emitted only when present. */
  rules?: string;
  /** FR-033 — an example value. Emitted only when present. */
  example?: string;
  /** FR-033 — guidance on when to reach for this attribute. Emitted only when present. */
  whenToUse?: string;
}

/** One structural child rule of a type (FR-033 constraint graph). */
interface ManifestChild {
  /** The admitted child `type` (`"*"` = any). */
  childType: string;
  /** The admitted child subType — a single subtype, `"*"` (any), or a list of admitted subtypes. */
  childSubType: string | readonly string[];
  /** The admitted child name (`"*"` = any). */
  childName: string;
  /** Cardinality lower bound — emitted only when defined on the rule. */
  min?: number;
  /** Cardinality upper bound (`null` = unbounded) — emitted only when defined on the rule. */
  max?: number | null;
  /** Whether the child must carry an explicit name — emitted only when defined on the rule. */
  named?: boolean;
}

/** One registered (type, subType) in the manifest, with its docs + attrs + constraint graph. */
interface ManifestType {
  type: string;
  subType: string;
  /** FR-033 — human/AI-facing description of the type/subType (required, non-empty). */
  description: string;
  /** FR-033 — prose documenting the complex rules enforced in code. Emitted only when present. */
  rules?: string;
  /** FR-033 — an example. Emitted only when present. */
  example?: string;
  /** FR-033 — guidance on when to reach for this type/subType. Emitted only when present. */
  whenToUse?: string;
  attrs: ManifestAttr[];
  /** FR-033 — the type's structural child rules (sorted), the constraint graph. */
  children: ManifestChild[];
  /** FR-033 — the child-side placement claim (sorted). Emitted only when present + non-empty. */
  parents?: string[];
}

/**
 * The Metamodel spec version — the shared, rolled-up name for the frozen core
 * vocabulary (ADR-0035 §2 / docs/1.0-readiness.md C4). It is a version TAG on this
 * manifest (the byte-exact bill of materials), NOT a per-provider or per-file marker:
 * every port emits the same string, asserted by registry-conformance. Pre-1.0 the
 * vocabulary is still `0.x` (semver = unstable, may change) but largely settled going
 * into the quiet period; the 1.0 cut (readiness G1) freezes it to `"1.0"`. Decoupled
 * from every package line — it is the spec version, not a package version.
 *
 * The current value is the declaration below and nothing else. Do not restate it in
 * prose: `scripts/check-metamodel-version.mjs --set` rewrites the declaration, so any
 * copy in a comment goes stale on the very next bump (it said `"0.9"` here while the
 * constant read `"0.10"`). Bump with that script — never by hand — so the manifest and
 * all four port constants move together.
 */
export const METAMODEL_VERSION = "0.13";

/** The full canonical manifest. All collections are sorted for byte-stability. */
interface RegistryManifest {
  /** The Metamodel spec version (first key — a header). See {@link METAMODEL_VERSION}. */
  metamodelVersion: string;
  types: ManifestType[];
  commonAttrs: ManifestAttr[];
  defaultSubTypes: Record<string, string>;
}

/** ASCII-string compare so the sort is locale-independent and byte-stable across ports. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalize one AttrSchema to the manifest's logical attr shape — decomposing
 * array-ness into a scalar `valueType` + an orthogonal `isArray` flag.
 *
 * An attr is array-valued when its schema sets `isArray: true` (the cross-port
 * model). For resilience, a legacy `valueType: "stringarray"` token is also
 * decomposed to `{ valueType: "string", isArray: true }` — so no `stringarray`
 * token ever reaches the manifest. A polymorphic attr (no valueType) is `null` +
 * non-array.
 */
function toManifestAttr(attr: AttrSchema): ManifestAttr {
  const isLegacyStringArray = attr.valueType === ATTR_SUBTYPE_STRINGARRAY;
  const isArray = attr.isArray === true || isLegacyStringArray;
  // The scalar value-type: a legacy stringarray token collapses to "string";
  // otherwise the declared valueType (omitted → null for polymorphic attrs).
  const valueType = isLegacyStringArray
    ? ATTR_SUBTYPE_STRING
    : (attr.valueType ?? null);
  // FR-033: the documentation surface (`description` required + non-empty;
  // `rules`/`example`/`whenToUse` emitted ONLY when present) follows the
  // existing facets, preserving key order for byte-stability.
  // The closed value-set, emitted only when present + non-empty (decision 5).
  // AttrValue is string | number | boolean | array; a closed enum is always a set
  // of scalar string members, so stringify each for a stable cross-port surface.
  // Spread BEFORE `description` so the JSON key order is name → valueType →
  // isArray → required → (allowedValues?) → description → (rules?/example?/whenToUse?).
  const hasAllowed = attr.allowedValues !== undefined && attr.allowedValues.length > 0;
  const out: ManifestAttr = {
    name: attr.name,
    valueType,
    isArray,
    required: attr.required,
    ...(hasAllowed ? { allowedValues: attr.allowedValues!.map((v) => String(v)) } : {}),
    description: attr.description,
  };
  if (attr.rules !== undefined) out.rules = attr.rules;
  if (attr.example !== undefined) out.example = attr.example;
  if (attr.whenToUse !== undefined) out.whenToUse = attr.whenToUse;
  return out;
}

/** The canonical sort key for a child rule: childType, then the childSubType
 *  string (or comma-joined list), then childName — ASCII codepoint compare. */
function childSubTypeKey(childSubType: string | readonly string[]): string {
  return Array.isArray(childSubType) ? childSubType.join(",") : (childSubType as string);
}

/**
 * Normalize one structural ChildRule to the manifest's child shape (FR-033).
 * Cardinality (`min`/`max`/`named`) is emitted ONLY when defined on the rule —
 * legacy wildcard rules leave them undefined and must NOT fabricate cardinality.
 * `max` may legitimately be `null` (unbounded); `null` is emitted, `undefined`
 * is omitted.
 */
function toManifestChild(rule: ChildRule): ManifestChild {
  const out: ManifestChild = {
    childType: rule.childType,
    childSubType: rule.childSubType,
    childName: rule.childName,
  };
  if (rule.min !== undefined) out.min = rule.min;
  if (rule.max !== undefined) out.max = rule.max;
  if (rule.named !== undefined) out.named = rule.named;
  return out;
}

/** Sort the constraint graph by (childType, childSubTypeKey, childName) — ASCII. */
function sortedChildren(rules: readonly ChildRule[]): ManifestChild[] {
  return rules
    .map(toManifestChild)
    .sort(
      (a, b) =>
        compareStrings(a.childType, b.childType) ||
        compareStrings(childSubTypeKey(a.childSubType), childSubTypeKey(b.childSubType)) ||
        compareStrings(a.childName, b.childName),
    );
}

/** Sort attrs by name (ascending, ASCII). */
function sortedAttrs(attrs: readonly AttrSchema[]): ManifestAttr[] {
  return attrs
    .map(toManifestAttr)
    .sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * Sort PER-TYPE attrs, keeping only those the explicit classification marks
 * INCLUDED (logical cross-port vocabulary). A per-type attr classified with any
 * `ExclusionReason` (structural keyword, native binding, per-type `description`
 * commonAttr dup) is carved out — for a documented reason, never a silent
 * name-match. The filter is a no-op for TS (which never registers the carved-out
 * names as per-type attrs); it is applied uniformly so the cross-port contract
 * is explicit. NOTE: `description` is filtered ONLY here — it remains in the
 * `commonAttrs` block (built via `sortedAttrs`, unfiltered).
 */
function sortedPerTypeAttrs(
  attrs: readonly AttrSchema[],
  type: string,
  subType: string,
): ManifestAttr[] {
  return sortedAttrs(attrs.filter((a) => classifyPerTypeAttr(a.name) === INCLUDED)).map(
    (attr) => {
      // FR-024-pending requiredness override (the attr-level analogue of the
      // Fr024Pending row carve-out): the TS registry already registers the
      // FR-024 requiredness, but the manifest keeps emitting the pre-FR-024
      // agreed value until the Phase-E atomic all-ports flip.
      const required = manifestRequiredOverride(type, subType, attr.name);
      return required === undefined ? attr : { ...attr, required };
    },
  );
}

/**
 * The boundary classifier (Wave 3b). For every per-type attr the emitter
 * encounters, the in/out decision is an EXPLICIT classification — never a silent
 * default. Returns either an `ExclusionReason` (carved out, with a documented
 * category) or `INCLUDED` (logical cross-port vocabulary). It is TOTAL: there is
 * no "unclassified" third state, so a port can never silently let an unreasoned
 * facet through — the self-documenting property the conformance test asserts.
 *
 * This replaces the prior tautology — a bare `EXCLUDED.has(name)` whose negative
 * branch silently meant "logical". The decision is now centralized and reasoned;
 * the cross-port byte-canonical + ADR-0023 (sealed agreed-vocabulary registry)
 * together guarantee that an `INCLUDED` attr really is agreed vocabulary rather
 * than an accidental registration, so inclusion-by-classification is sound.
 *
 * NOTE on liveness: a per-type attr exclusion (e.g. `extends`, `object`) is a
 * CROSS-PORT carve-out that only the OO ports (Java/Kotlin) physically register;
 * TS/C#/Python never register those names, so a single port's emitter cannot
 * judge a carve-out "dead" — that is a cross-port property, asserted by the
 * shared byte-canonical, not here.
 */
const INCLUDED = "included" as const;
export type AttrClassification = ExclusionReason | typeof INCLUDED;

export function classifyPerTypeAttr(name: string): AttrClassification {
  return EXCLUDED_PER_TYPE_ATTRS.get(name) ?? INCLUDED;
}

/**
 * Build one manifest type entry from its full TypeDefinition (FR-033). Key order
 * is fixed for byte-stability: `type`, `subType`, `description`, then optional
 * `rules`/`example`/`whenToUse` (emitted only when present), then `attrs`,
 * `children` (the sorted constraint graph), and optional `parents` (emitted only
 * when present + non-empty, sorted ASCII).
 */
function toManifestType(def: TypeDefinition): ManifestType {
  // Build in fixed key order. Optional docs facets (rules/example/whenToUse) sit
  // between `description` and `attrs`, so they are spread into the literal (when
  // present) to preserve insertion order — `attrs`/`children`/`parents` follow.
  const out: ManifestType = {
    type: def.typeId.type,
    subType: def.typeId.subType,
    description: def.description,
    ...(def.rules !== undefined ? { rules: def.rules } : {}),
    ...(def.example !== undefined ? { example: def.example } : {}),
    ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
    attrs: sortedPerTypeAttrs(def.attributes, def.typeId.type, def.typeId.subType),
    children: sortedChildren(def.childRules),
  };
  if (def.parents !== undefined && def.parents.length > 0) {
    out.parents = [...def.parents].sort(compareStrings);
  }
  return out;
}

/**
 * Build the canonical registry manifest object from an assembled registry.
 *
 * The registry must already be composed (e.g. `composeRegistry(coreProviders)`)
 * so all providers — core types, db-domain attrs, common doc attrs — have run.
 */
export function buildRegistryManifest(registry: TypeRegistry): RegistryManifest {
  // Walk every registered (type, subType). `allTypes()` returns the TypeIds;
  // `find` gives each one's full TypeDefinition (description / attributes /
  // childRules / parents / rules / example / whenToUse) in a single lookup.
  const types: ManifestType[] = registry
    .allTypes()
    // Skip excluded (type, subType) rows: the `metadata.base` inheritance
    // anchor (C-5) + the generic TS-presentation `view.*` controls (B-2).
    .filter((typeId) => !isExcludedTypeSubType(typeId.type, typeId.subType))
    .map((typeId) =>
      toManifestType(
        // The type IS registered (it came from allTypes()), so find() is defined.
        registry.find(typeId.type, typeId.subType) as TypeDefinition,
      ),
    )
    // Sort by the full "type.subType" key for a stable, port-independent order.
    .sort((a, b) =>
      compareStrings(`${a.type}.${a.subType}`, `${b.type}.${b.subType}`),
    );

  const commonAttrs = sortedAttrs(registry.getCommonAttrs());

  // defaultSubTypes: rebuild with sorted keys so JSON.stringify emits a stable
  // key order. There is no public "all default subTypes" accessor, so derive
  // the candidate type names from the registered types and probe each.
  const typeNames = Array.from(new Set(types.map((t) => t.type))).sort(
    compareStrings,
  );
  const defaultSubTypes: Record<string, string> = {};
  for (const typeName of typeNames) {
    const defaultSub = registry.defaultSubTypeOf(typeName);
    if (defaultSub !== undefined) {
      defaultSubTypes[typeName] = defaultSub;
    }
  }

  return { metamodelVersion: METAMODEL_VERSION, types, commonAttrs, defaultSubTypes };
}

/**
 * Emit the canonical registry manifest as a byte-stable JSON string.
 *
 * Serialization contract — every port MUST match this exactly:
 *  - 2-space indentation (JSON.stringify(_, _, 2)).
 *  - Object keys in a fixed order (JSON.stringify preserves insertion order):
 *    the manifest is built with `metamodelVersion` (first — the spec-version
 *    header), then `types`, `commonAttrs`, `defaultSubTypes`.
 *    - Each attr: `name`, `valueType`, `isArray`, `required`, then optional
 *      `allowedValues` (omitted unless the attr declares a non-empty closed set —
 *      decision 5), then `description`, then optional `rules`, `example`,
 *      `whenToUse` (each omitted when absent).
 *    - Each type: `type`, `subType`, `description`, then optional `rules`,
 *      `example`, `whenToUse` (omitted when absent), then `attrs`, `children`,
 *      then optional `parents` (omitted when absent/empty).
 *    - Each child (FR-033 constraint graph): `childType`, `childSubType`,
 *      `childName`, then optional `min`, `max`, `named` (each emitted ONLY when
 *      defined on the rule — legacy wildcard rules omit all three; `max: null`
 *      is emitted when the rule sets it null, omitted when undefined).
 *  - All arrays sorted: `types` by "type.subType"; each `attrs` by name;
 *    each type's `children` by the tuple (childType, childSubTypeKey, childName)
 *    where childSubTypeKey is the string or the comma-joined list; `parents`
 *    ascending; `commonAttrs` by name; `defaultSubTypes` keys sorted.
 *  - `valueType: null` literal for polymorphic/untyped attrs.
 *  - `childSubType` is a string OR a string[] (a list of admitted subtypes).
 *  - `description` is required + non-empty on every type and attr (gated by the
 *    coverage assertion in registry-conformance.test.ts — mirrors ADR-0023).
 *  - A single trailing newline (matches the repo's committed-canonical style).
 */
export function emitRegistryManifest(registry: TypeRegistry): string {
  const manifest = buildRegistryManifest(registry);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
