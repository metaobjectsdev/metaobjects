// Phase A3 — attribute-schema validation pass.
//
// Consumes the per-(type, subType) attribute schema populated in core-types.ts
// (Phase A2). For each node in the loaded typed tree, looks up
// registry.attrsOf(node.type, node.subType) and checks the node's OWN
// @-attributes against that schema:
//
//   1. Required attrs present       — every AttrSchema with required:true must
//                                      have a matching attr on the node.
//   2. Declared attrs well-typed    — for each @-attr ON the node that IS in the
//                                      schema, its value must satisfy the
//                                      MetaAttr instance's own validateValue.
//   3. allowedValues honored        — declared attrs with a non-empty
//                                      allowedValues set must hold a member value.
//   4. Undeclared attrs             — under strict load (ADR-0023) an own
//                                      @-attr that matches NO per-type attr
//                                      schema AND NO commonAttr is an
//                                      ERR_UNKNOWN_ATTR. In lax mode (strict
//                                      false) it stays the legacy open policy:
//                                      NOT an error, NOT a warning. Own-only,
//                                      so an inherited/overlaid declared attr
//                                      (validated on its declaring node) is fine.
//   5. Structural-child placement    — FR-033: under strict load a STRUCTURAL
//      (Check 0b)                       child (field/identity/source/… — not an
//                                      attr) not admitted by the parent's
//                                      registered childRules is ERR_CHILD_NOT_
//                                      ALLOWED (the structural analogue of #4). A
//                                      no-op under today's wildcard childRules —
//                                      the rail strict per-subtype rules use in S1.
//
// `default` values are NOT auto-applied — A3 is pure validation, not mutation.
//
// Checks 2+3 dispatch to the materialized MetaAttr instance: each attr is a
// MetaAttr that owns validateValue(value): ValueError[] (resolved by its
// subType, which the parser chose from the declared valueType). The central
// value-shape helper + the per-shape subtype sets are gone — value-shape
// knowledge now lives on the instance. The pass maps each ValueError to a
// ParseError with the unchanged ERR_BAD_ATTR_VALUE code, so conformance
// fixtures stay green.
//
// Modeled on src/subtype-rules.ts: a recursive walk producing an
// { errors, warnings } result. All A3 findings are ERRORS; warnings stays [].

import type { MetaData } from "./shared/meta-data.js";
import { ParseError } from "./errors.js";
import type { AttrSchema, TypeRegistry } from "./registry.js";
import { childRuleMatches } from "./registry.js";
import { TYPE_FIELD, TYPE_METADATA } from "./shared/base-types.js";
import { ATTR_SUBTYPE_PROPERTIES } from "./core/attr/attr-constants.js";
// #337: turns "unknown X" into "retired in V — here is the migration". Changes no load
// outcome; retired vocabulary still fails with the same code.
import { retiredAttr, retiredAttrValue, retirementHint } from "./retired-vocabulary.js";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_COERCE_DEFAULT,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_INT_VALUE_MAP,
  ENUM_MEMBER_PATTERN,
} from "./core/field/field-constants.js";
import {
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_VALUES,
  DB_COLUMN_TYPE_LEGAL_SUBTYPES,
  type DbColumnTypeValue,
} from "./persistence/db/db-constants.js";

export interface AttrSchemaValidationResult {
  errors: ParseError[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function validateAttrSchema(
  root: MetaData,
  registry: TypeRegistry,
  // ADR-0023 — strict load closes the open-attr policy: an own @-attr matching
  // no per-type schema and no commonAttr → ERR_UNKNOWN_ATTR. Defaults false so
  // existing lax callers keep the legacy open policy; the library's own loader
  // (and the conformance runner) load strict.
  strict = false,
): AttrSchemaValidationResult {
  const errors: ParseError[] = [];
  // Tracks (type.subType) pairs for which ERR_PROVIDER_ATTR_CONFLICT has already
  // been emitted. The conflict is a registry-state condition, not a per-node
  // condition — emit it once per (type, subType), not once per node instance.
  const reportedConflicts = new Set<string>();
  walk(root, registry, errors, reportedConflicts, strict);
  return { errors, warnings: [] };
}

function walk(
  node: MetaData,
  registry: TypeRegistry,
  errors: ParseError[],
  reportedConflicts: Set<string>,
  strict: boolean,
): void {
  validateNode(node, registry, errors, reportedConflicts, strict);
  // ADR-0039: own — structural walk visiting every physical node once at its site.
  for (const child of node.ownChildren()) {
    walk(child, registry, errors, reportedConflicts, strict);
  }
}

/** A node label for error messages, e.g. `origin.aggregate 'weekCount'`. */
function nodeLabel(node: MetaData): string {
  const head = `${node.type}.${node.subType}`;
  return node.name !== "" ? `${head} '${node.name}'` : head;
}

function validateNode(
  node: MetaData,
  registry: TypeRegistry,
  errors: ParseError[],
  reportedConflicts: Set<string>,
  strict: boolean,
): void {
  // Build the effective schema in a single pass: per-type attrs win on name
  // collision; common attrs fill in for unclaimed names. Surface common-vs-per-type
  // collisions in the same pass — a name in both lists means a provider tried to
  // overload a declared attr. The conflict is registry-state (not per-node), so
  // emit ONE error per (type, subType), tracked via `reportedConflicts`.
  // Even when a conflict exists, the per-type attr still wins (the common attr
  // for that name is suppressed) so type-checking proceeds normally for everything else.
  const byName = new Map<string, AttrSchema>();
  for (const spec of registry.attrsOf(node.type, node.subType)) byName.set(spec.name, spec);

  const typeKey = `${node.type}.${node.subType}`;
  for (const ca of registry.getCommonAttrs()) {
    if (byName.has(ca.name)) {
      if (!reportedConflicts.has(typeKey)) {
        errors.push(
          new ParseError(
            `Common attr '${ca.name}' conflicts with per-type attr on ${typeKey}`,
            { code: "ERR_PROVIDER_ATTR_CONFLICT", source: node.source },
          ),
        );
        reportedConflicts.add(typeKey);
      }
      continue; // per-type wins
    }
    byName.set(ca.name, ca);
  }

  // --- Check 0 (ADR-0023): strict-load undeclared-attr rejection ---
  //
  // Runs BEFORE the byName.size early-return: a node type with no per-type
  // schema and no common attrs (byName empty) must still reject an authored
  // @-attr under strict. Own-attrs only — an inherited/overlaid declared attr
  // was validated on its declaring node and never appears in ownMetaAttrs().
  // An own attr matching neither a per-type schema entry nor a commonAttr is
  // a made-up attribute → ERR_UNKNOWN_ATTR (closing the open policy). In lax
  // mode this stays a no-op (legacy open-attr behavior).
  if (strict) {
    // ADR-0039: own — validates THIS node's OWN declared attrs; an inherited/
    // overlaid declared attr was validated on its declaring node (never in ownMetaAttrs).
    for (const inst of node.ownMetaAttrs()) {
      // attr.properties is a first-class, registered, canonical attr subtype
      // whose designed purpose is an arbitrary-named structural property bag
      // (its NAME is intentionally not declared by any per-type schema). It is
      // sanctioned vocabulary, not a made-up attribute, so strict-attr exempts
      // a materialized properties-attr from ERR_UNKNOWN_ATTR. (A typo'd plain
      // @-attr still fails — only the `properties` subtype is exempt.)
      if (inst.subType === ATTR_SUBTYPE_PROPERTIES) continue;
      if (!byName.has(inst.name)) {
        // #337: if we RETIRED this name, say so. "Not declared by any registered
        // provider" is true and reads as "your metadata is malformed", which sent one
        // adopter to file a registration bug against a deliberate, documented breaking
        // change. Unrecognised names still report generically — a typo is a typo.
        const retired = retiredAttr(typeKey, inst.name);
        errors.push(
          new ParseError(
            `Unknown attribute '@${inst.name}' on ${nodeLabel(node)} — ` +
              (retired !== undefined
                ? retirementHint(retired)
                : `not declared by any registered provider for ${typeKey}`),
            { code: "ERR_UNKNOWN_ATTR", source: node.source },
          ),
        );
      }
    }
  }

  // --- Check 0b (FR-033): strict-load structural-child placement ---
  //
  // The structural analogue of Check 0. A STRUCTURAL child (field/identity/
  // source/validator/… — attrs never appear in ownChildren()) must be admitted
  // by the parent's registered childRules under the same wildcard match
  // semantics used everywhere (childType/childSubType/childName may be "*", and
  // childSubType may be a list). A child the rules do not admit → ERR_CHILD_NOT_
  // ALLOWED. A NO-OP today: every parent carries wildcard structural childRules
  // (e.g. field.* / validator.*) that admit everything — the rail strict
  // per-subtype rules will use in S1. Lax mode keeps the legacy open policy.
  //
  // An UNREGISTERED parent (no def) cannot be judged here (ERR_UNKNOWN_TYPE /
  // ERR_UNKNOWN_SUBTYPE is reported elsewhere); skip so we never double-report.
  if (strict) {
    const parentDef = registry.find(node.type, node.subType);
    if (parentDef !== undefined) {
      const rules = parentDef.childRules;
      // ADR-0039: own — validates THIS node's OWN declared children (an inherited
      // child was placement-checked on its declaring parent).
      for (const child of node.ownChildren()) {
        const admitted = rules.some((r) =>
          childRuleMatches(r, {
            type: child.type,
            subType: child.subType,
            name: child.name,
          }),
        );
        if (!admitted) {
          errors.push(
            new ParseError(
              `Child ${nodeLabel(child)} is not allowed under ${nodeLabel(node)} — ` +
                `no registered child rule for ${typeKey} admits ` +
                `(type='${child.type}', subType='${child.subType}', name='${child.name}')`,
              { code: "ERR_CHILD_NOT_ALLOWED", source: node.source },
            ),
          );
        }
      }
    }
  }

  if (byName.size === 0) return;

  // --- Check 1: required attrs present ---
  //
  // Use attrs() (own + inherited via extends:) to determine presence.
  // A node that legitimately inherits a required attr from its super must NOT be
  // flagged as missing it — inherited attrs count as satisfying the requirement.
  // Contrast with Checks 2+3 below, which iterate own attrs only: inherited attrs
  // were already validated on the node that declared them, so re-checking would
  // double-report. This mirrors the effective-vs-own split in subtype-rules.ts.
  //
  // #236: an ABSTRACT node is a template, not an instantiated node — it may omit a
  // required attr for concrete subtypes / `extends` to supply (e.g. an abstract
  // `template.prompt` that hoists shared children but leaves `@payloadRef` to its
  // concretes). Enforcement stays at the CONCRETE level: a concrete node's resolving
  // attrs() must satisfy the requirement (a concrete missing it — inherited or own —
  // still errors). Consistent with ADR-0039 (resolving-default; abstract = the
  // metamodel's incompleteness escape).
  if (!node.isAbstract) {
    const effective = node.attrs();
    for (const spec of byName.values()) {
      if (spec.required && !effective.has(spec.name)) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} is missing required attribute '@${spec.name}'`,
            { code: "ERR_MISSING_REQUIRED_ATTR", source: node.source },
          ),
        );
      }
    }
  }

  // --- Checks 2 + 3: declared attrs on the node are well-typed + in range ---
  // ADR-0039: own — validates THIS node's OWN declared attrs (inherited attrs were
  // validated on the declaring node; own-attrs-only policy).
  for (const inst of node.ownMetaAttrs()) {
    const spec = byName.get(inst.name);
    if (spec === undefined) continue; // undeclared attr → open policy: ignore.
    const value = inst.value;
    if (value === undefined) continue;

    // Check 2: the instance validates its own value shape. When the declared
    // valueType is absent (e.g. @default), skip — any AttrValue is valid.
    if (spec.valueType !== undefined) {
      const valueErrors = inst.validateValue(value);
      if (valueErrors.length > 0) {
        for (const ve of valueErrors) {
          errors.push(new ParseError(`${nodeLabel(node)} ${ve.message}`, { code: "ERR_BAD_ATTR_VALUE", source: node.source }));
        }
        continue; // type wrong → skip allowedValues
      }
    }

    // Check 3: allowedValues membership. For an isArray attr the value is an array,
    // so each ELEMENT must be a member (not the array as a whole); a scalar attr
    // checks the value directly.
    //
    // @dbColumnType is exempt here: it carries `allowedValues` ONLY so the value-set
    // surfaces in the registry manifest (ADR-0036 Wave 1, decision 5), but its real
    // constraint is the (subtype × value) pairing enforced below in Check 6 — which
    // emits the single ERR_BAD_ATTR_VALUE for both an unrecognized value and an
    // illegal pairing. Running the flat membership check too would double-report.
    if (
      inst.name !== FIELD_ATTR_DB_COLUMN_TYPE &&
      spec.allowedValues !== undefined &&
      spec.allowedValues.length > 0
    ) {
      const allowed = spec.allowedValues;
      const offenders = Array.isArray(value)
        ? value.filter((v) => !allowed.includes(v))
        : allowed.includes(value)
          ? []
          : [value];
      for (const bad of offenders) {
        // #337: a member we REMOVED reads very differently from a member that never
        // existed. `@status: abandoned` was valid one release ago, so "not one of the
        // allowed values" invites the reader to conclude the enum is broken.
        const retiredValue = retiredAttrValue(typeKey, inst.name, bad);
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${inst.name}' has value ` +
              `'${String(bad)}' which is not one of the allowed values: ` +
              `${allowed.map((v) => String(v)).join(", ")}` +
              (retiredValue !== undefined ? ` — ${retirementHint(retiredValue)}` : ""),
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      }
    }
  }

  // --- Check 4: field.enum @values content rules ---
  //
  // Only for field.enum nodes that carry an own @values attr (concrete or
  // abstract). Concrete fields that extend an abstract enum inherit @values
  // from the super; the super was already validated when it was declared, so
  // only own @values need checking here (mirrors the own-attrs-only policy of
  // Checks 2+3 above — inherited attrs were validated on the declaring node).
  if (node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM) {
    // #246: the shared-enum super, if any — a root-level abstract field.enum (one
    // whose parent is the metadata root, not an object). FR-019 materializes such a
    // declaration ONCE per port as a single named type, so anything a consuming
    // field re-declares that is part of the shared TYPE's contract is a conflict.
    // Immediate-super-only, matching codegen's resolveSharedEnumDecl (enum-shared.ts)
    // so the validator and the collapse agree on what "shared" means.
    const sharedSuper =
      node.superData !== undefined &&
      node.superData.isAbstract &&
      node.superData.parent?.type === TYPE_METADATA
        ? node.superData
        : undefined;

    // ADR-0039: own — validates the @values DECLARED on this node; a concrete enum
    // extending an abstract one inherits already-validated @values (own-attrs-only).
    const rawValues = node.ownAttrs().get(FIELD_ATTR_VALUES);
    if (Array.isArray(rawValues)) {
      if (rawValues.length === 0) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} must declare at least one value in '@${FIELD_ATTR_VALUES}'.`,
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      } else {
        // rawValues is the only array variant of AttrValue, so each member is a
        // string (StringArrayAttr.coerce stringifies every element on load).
        const seen = new Set<string>();
        for (const member of rawValues) {
          if (!ENUM_MEMBER_PATTERN.test(member)) {
            errors.push(
              new ParseError(
                `${nodeLabel(node)} attribute '@${FIELD_ATTR_VALUES}' member '${member}' ` +
                  `is not a valid identifier (must match ${ENUM_MEMBER_PATTERN.source}). ` +
                  `Non-identifier-safe member strings require a symbol↔value mapping (deferred).`,
                { code: "ERR_BAD_ATTR_VALUE", source: node.source },
              ),
            );
          } else if (seen.has(member)) {
            errors.push(
              new ParseError(
                `${nodeLabel(node)} attribute '@${FIELD_ATTR_VALUES}' has duplicate member '${member}'.`,
                { code: "ERR_BAD_ATTR_VALUE", source: node.source },
              ),
            );
          } else {
            seen.add(member);
          }
        }
      }

      // #246: a field.enum extending a shared package-level abstract enum that
      // ALSO declares its own @values is a conflict: one shared enum type has one
      // member set, so codegen's shared-enum collapse would silently drop this
      // field's own @values in favor of the shared type's. Own-attrs-only
      // (matches the rest of Check 4): only fires when THIS node declares
      // @values itself, not when it merely inherits.
      if (sharedSuper !== undefined) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} extends shared abstract enum '${nodeLabel(sharedSuper)}' AND declares its own ` +
              `'@${FIELD_ATTR_VALUES}' — a shared enum's member set is owned by the shared declaration; ` +
              `remove the own '@${FIELD_ATTR_VALUES}' to inherit it, or extend a non-shared enum instead.`,
            { code: "ERR_ENUM_EXTENDS_VALUES_CONFLICT", source: node.source },
          ),
        );
      }
    }

    // --- Check 5 (FR-011): enum fallback attrs must be a member of @values ---
    //
    // Both @coerceDefault (extract-time coercion fallback) and @default (absent-fill
    // member) name an enum member, so each must be one of the field's @values.
    // Only validate when THIS node owns the attr (own-attrs-only policy, matching
    // Checks 2+3). The membership set is the EFFECTIVE @values — own or inherited
    // via extends: — so a concrete enum that owns the fallback attr and inherits
    // @values from an abstract super still validates correctly.
    //
    // @coerceDefault is enum-only by registration, but @default is polymorphic
    // (a column default on string/int/bool/etc. fields), so the @default membership
    // check is gated to field.enum — @default on non-enum fields is NOT touched.
    if (node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM) {
      const effectiveValues = node.attrs().get(FIELD_ATTR_VALUES);
      const members = Array.isArray(effectiveValues) ? effectiveValues : [];

      for (const attrName of [FIELD_ATTR_COERCE_DEFAULT, FIELD_ATTR_DEFAULT]) {
        // ADR-0039: own — validates the fallback attr DECLARED on this node
        // (membership set below uses effective node.attrs(); own-attrs-only policy).
        const ownValue = node.ownAttrs().get(attrName);
        if (typeof ownValue === "string" && !members.includes(ownValue)) {
          errors.push(
            new ParseError(
              `${nodeLabel(node)} attribute '@${attrName}' value ` +
                `'${ownValue}' is not one of '@${FIELD_ATTR_VALUES}': ` +
                `${members.join(", ")}.`,
              { code: "ERR_BAD_ATTR_VALUE", source: node.source },
            ),
          );
        }
      }
    }

    // --- Check 5a: @intValueMap is scalar-only (design D7) ---
    //
    // Int-backing is a persistence-layer CODEC, and no port implements it
    // element-wise over an array column: OMDB's EnumCodec and Kotlin's
    // customEnumeration are scalar by construction, Python would bind the symbol
    // list straight into an integer[], and TS's sqlite branch serializes an array
    // as JSON text before the enum case is ever reached. Two ports that DO compose
    // (TS/Postgres via .array(), C# via PrimitiveCollection) are not a feature —
    // shipping a claim four ports silently get wrong is the field.byte/short/class
    // mistake. Rejected at LOAD so it fails identically everywhere.
    //
    // BOTH reads are RESOLVING, unlike Check 5b below: the illegal thing is the
    // EFFECTIVE combination. Post-#246 the map must live on the shared abstract
    // declaration, so the field that inherits it is exactly where isArray gets
    // declared — an own-only read would see the two halves on different nodes and
    // never fire.
    if (node.attrs().get(FIELD_ATTR_INT_VALUE_MAP) !== undefined && node.resolvedIsArray()) {
      errors.push(
        new ParseError(
          `${nodeLabel(node)} declares '@${FIELD_ATTR_INT_VALUE_MAP}' with isArray=true; ` +
            `int-backing is scalar-only — an array-of-enum persists its member symbols. ` +
            `Remove '@${FIELD_ATTR_INT_VALUE_MAP}', or make the field scalar.`,
          { code: "ERR_ENUM_INT_VALUE_MAP_ARRAY", source: node.source },
        ),
      );
    }

    // --- Check 5b: field.enum @intValueMap content rules ---
    //
    // Optional. Own-only (mirrors Checks 4/5's own-attrs-only policy) — an
    // inherited @intValueMap is validated on its declaring node. The generic
    // "is this an object of integers" shape check already ran via IntMapAttr
    // (attr subtype `intMap`); this validates the field.enum-SPECIFIC
    // semantics: key-set-equals-@values, and no two members share a value.
    const rawIntValueMap = node.ownAttrs().get(FIELD_ATTR_INT_VALUE_MAP);
    if (rawIntValueMap !== undefined && typeof rawIntValueMap === "object" && rawIntValueMap !== null) {
      // #246 (int-backed twin): the symbol→int mapping is a property of the enum
      // VOCABULARY, not of one column that uses it — it is @values' numeric half.
      // A shared enum is materialized once as a single type, so a per-field map
      // would give one logical type N storage encodings (and, where a port emits
      // per-TYPE codec artifacts, two same-named declarations). Same remedy as the
      // @values half: declare it on the shared declaration and inherit it.
      if (sharedSuper !== undefined) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} extends shared abstract enum '${nodeLabel(sharedSuper)}' AND declares its own ` +
              `'@${FIELD_ATTR_INT_VALUE_MAP}' — a shared enum's integer backing is owned by the shared ` +
              `declaration; move '@${FIELD_ATTR_INT_VALUE_MAP}' onto '${nodeLabel(sharedSuper)}' to inherit it, ` +
              `or extend a non-shared enum instead.`,
            { code: "ERR_ENUM_EXTENDS_VALUES_CONFLICT", source: node.source },
          ),
        );
      }
      const map = rawIntValueMap as Record<string, number>;
      const effectiveValues = node.attrs().get(FIELD_ATTR_VALUES);
      const declaredMembers: string[] = Array.isArray(effectiveValues) ? effectiveValues : [];
      const memberSet = new Set(declaredMembers);
      const mapKeys = Object.keys(map);
      const keySet = new Set(mapKeys);

      const missing = declaredMembers.filter((m) => !keySet.has(m));
      const extra = mapKeys.filter((k) => !memberSet.has(k));
      if (missing.length > 0 || extra.length > 0) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${FIELD_ATTR_INT_VALUE_MAP}' keys must exactly match '@${FIELD_ATTR_VALUES}' members` +
              (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "") +
              (extra.length > 0 ? ` (unknown: ${extra.join(", ")})` : "") + ".",
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      }

      const seenValues = new Map<number, string>();
      for (const [member, value] of Object.entries(map)) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue; // IntMapAttr already reported this
        const owner = seenValues.get(value);
        if (owner !== undefined) {
          errors.push(
            new ParseError(
              `${nodeLabel(node)} attribute '@${FIELD_ATTR_INT_VALUE_MAP}' members '${owner}' and '${member}' ` +
                `share the same value ${value}; every member must have a unique int.`,
              { code: "ERR_BAD_ATTR_VALUE", source: node.source },
            ),
          );
        } else {
          seenValues.set(value, member);
        }
      }
    }
  }

  // --- Check 6 (R6 Plan 2b): @dbColumnType (logical subtype × value) pairing ---
  //
  // @dbColumnType is a physical column-type override registered on every field
  // subtype by the dbProvider. Its legal value depends on the field's logical
  // subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp),
  // a pairing that a flat allowedValues set cannot express — so validate it here.
  // Own-only (matches Checks 2+3): an inherited @dbColumnType was validated on
  // the declaring node. Both an unrecognized value and an illegal pairing emit
  // ERR_BAD_ATTR_VALUE naming the field, the value, and the legal set.
  if (node.type === TYPE_FIELD) {
    // ADR-0039: own — @dbColumnType is physical, never inherited (and an inherited
    // one was pairing-checked on its declaring node; own-attrs-only policy).
    const ownValue = node.ownAttrs().get(FIELD_ATTR_DB_COLUMN_TYPE);
    if (typeof ownValue === "string") {
      const legalSubtypes = (DB_COLUMN_TYPE_VALUES as readonly string[]).includes(ownValue)
        ? DB_COLUMN_TYPE_LEGAL_SUBTYPES[ownValue as DbColumnTypeValue]
        : undefined;
      if (legalSubtypes === undefined || !legalSubtypes.includes(node.subType)) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${FIELD_ATTR_DB_COLUMN_TYPE}' value ` +
              `'${ownValue}' is not legal on field.${node.subType}. ` +
              `Legal @${FIELD_ATTR_DB_COLUMN_TYPE} pairings: ` +
              `${DB_COLUMN_TYPE_VALUES.map(
                (v) => `${v} (field.${DB_COLUMN_TYPE_LEGAL_SUBTYPES[v].join("/field.")})`,
              ).join(", ")}.`,
            { code: "ERR_BAD_ATTR_VALUE", source: node.source },
          ),
        );
      }
    }
  }
}
