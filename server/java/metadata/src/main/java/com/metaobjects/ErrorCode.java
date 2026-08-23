/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects;

/**
 * Stable, language-neutral error codes — mirrors
 * {@code fixtures/conformance/ERROR-CODES.json} and the C# {@code ErrorCode} enum.
 *
 * <p>This is a <strong>closed</strong> set. Every member corresponds to an entry in
 * the shared conformance error-code registry. When a new code is added to
 * {@code ERROR-CODES.json} it must also be added here (and to the parallel C# and
 * TypeScript constants).</p>
 *
 * <p>Only the enum-validation path adopts coded exceptions in this phase. Other
 * call sites continue to throw {@link MetaDataException} with message-embedded codes
 * until they are migrated; the {@code ErrorCode} field on those exceptions remains
 * {@code null}.</p>
 *
 * @since 6.1.0
 */
public enum ErrorCode {

    /** The input is not valid JSON (parse failure before structural checks). */
    ERR_MALFORMED_JSON,

    /** The metadata document root is not a JSON object. */
    ERR_TOP_LEVEL_NOT_OBJECT,

    /** A node uses a type not registered in the registry. */
    ERR_UNKNOWN_TYPE,

    /** A node uses a subType not valid for its type. */
    ERR_UNKNOWN_SUBTYPE,

    /** A node omits subType and the type has no default subType. */
    ERR_MISSING_SUBTYPE,

    /** Two sibling nodes share the same name. */
    ERR_DUPLICATE_NAME,

    /** An extends/super reference names a node that does not exist. */
    ERR_UNRESOLVED_SUPER,

    /**
     * FR-024 (ADR-0029): a dotted extends ref resolved to a node whose type or
     * subtype does not match the extending node (a field may only extend a field
     * of the same subtype; an identity only an identity).
     */
    ERR_EXTENDS_TARGET_MISMATCH,

    /**
     * FR-024: an identity.* node has no name. Identities are named,
     * author-chosen (e.g. "id"), so the dotted by-name extends form can
     * address them. Vocabulary-only here until FR-024 Phase E (the Java
     * loader does not enforce the requirement yet).
     */
    ERR_IDENTITY_NAME_REQUIRED,

    /**
     * A {@code type.subType} declared with {@code maxOccurs} (e.g.
     * identity.primary, maxOccurs:1) appears more times than allowed under one
     * parent. The TS reference loader enforces it; other ports track the
     * vocabulary until they apply the singleton constraint.
     */
    ERR_TOO_MANY_OCCURRENCES,

    /**
     * FR-024: an identity.* on an object.projection lacks extends — a
     * projection identity is a pass-through of an entity identity.
     * Vocabulary-only here until FR-024 Phase E.
     */
    ERR_PROJECTION_IDENTITY_NOT_EXTENDED,

    /**
     * FR-024: identity key correspondence broken — an extended-identity field
     * has no local pass-through field extending it, or an explicit @fields
     * disagrees with the computed pass-through key. Vocabulary-only here
     * until FR-024 Phase E.
     */
    ERR_IDENTITY_KEY_MISMATCH,

    /**
     * FR-024 (ADR-0028): a source.* on an object.projection has a writable
     * @kind (table, or @kind omitted which defaults to table) — projection
     * sources must be read-only kinds. Vocabulary-only here until FR-024
     * Phase E.
     */
    ERR_PROJECTION_SOURCE_WRITABLE,
    ERR_PROJECTION_INHERITED_SOURCE,

    /** A child node type/subType is not permitted under its parent. */
    ERR_INVALID_SUBTYPE_CHILD,

    /** An attribute name is not declared on the node's type. */
    ERR_UNKNOWN_ATTR,

    /**
     * A reserved structural keyword ({@code name}, {@code package}, {@code extends},
     * {@code abstract}, {@code overlay}, {@code isArray}, {@code children}, {@code value})
     * was written as an {@code @}-prefixed attribute in canonical JSON.
     * The rule is unconditional — write the key bare.
     */
    ERR_RESERVED_ATTR,

    /** A required attribute is absent from the node. */
    ERR_MISSING_REQUIRED_ATTR,

    /** An attribute value fails its declared schema (type/range). */
    ERR_BAD_ATTR_VALUE,

    /** A layout @defaultSortField names a field absent from the entity. */
    ERR_BAD_DEFAULT_SORT_FIELD,

    /** Provider composition has a dependency cycle. */
    ERR_PROVIDER_DEPENDENCY_CYCLE,

    /** Two providers in a composition share the same id. */
    ERR_PROVIDER_DUPLICATE_ID,

    /** A provider declares a dependency id with no matching provider. */
    ERR_PROVIDER_MISSING_DEPENDENCY,

    /** A provider extend redefines an attr another provider already declared. */
    ERR_PROVIDER_ATTR_CONFLICT,

    /**
     * ADR-0050: a provider tried to project a REQUIRED attribute onto a type it does
     * not own (via extends). Projection is optional-only — a required attr registered
     * this way disappears silently whenever that provider is composed out, taking its
     * validation rule with it. Declare it with the type instead.
     */
    ERR_EXTEND_REQUIRED_ATTR,

    /** A node violates a subtype composition rule. */
    ERR_SUBTYPE_RULE_VIOLATION,

    /** An overlay node has no existing target to merge into. */
    ERR_OVERLAY_NO_TARGET,

    /** The YAML metadata input is not valid YAML, or cannot be desugared. */
    ERR_MALFORMED_YAML,

    /**
     * A YAML 1.2 silent type coercion produced a value whose runtime type differs from
     * the attribute's declared valueType (e.g. an unquoted {@code column: TRUE} parsed
     * as boolean for a string-typed attr). Emitted only by the YAML loader; canonical
     * JSON is unaffected.
     */
    ERR_YAML_COERCION,

    /** A field origin (passthrough/aggregate) declares an invalid path or attribute. */
    ERR_INVALID_ORIGIN,

    /**
     * FR-024 (ADR-0029): an implicit (omitted-{@code @via}) origin path is ambiguous —
     * more than one single-hop relationship leads from the base entity to the
     * {@code @from}/{@code @of} entity, or a projection's base entity cannot be derived
     * because its fields extend multiple entities and no extended identity anchors the
     * base. Vocabulary-only here until FR-024 Phase E (the Java loader does not run
     * the inference yet).
     */
    ERR_AMBIGUOUS_PATH,

    /**
     * FR-024 (ADR-0029): origin cardinality contract broken — a passthrough
     * {@code @via} path crosses a to-many hop (row-multiplying passthrough — you meant
     * aggregate), or an aggregate {@code @via} path is to-one at every hop (you meant
     * passthrough). Vocabulary-only here until FR-024 Phase E.
     */
    ERR_ORIGIN_CARDINALITY,

    /**
     * FR-024 (ADR-0029 decision 7): a field declares both an entity-nested extends
     * (shape lineage) and an {@code origin.passthrough @from} (data lineage) and they
     * disagree — the resolved {@code @from} target is not the field's resolved extends
     * target (nor anywhere on its extends chain). Host-agnostic (projections, entities,
     * values); aggregates and top-level abstract extends targets are never judged.
     * Vocabulary-only here until FR-024 Phase E (the Java loader does not run the
     * agreement check yet).
     */
    ERR_EXTENDS_ORIGIN_MISMATCH,

    /**
     * #185: a field carrying {@code origin.passthrough @from: "Entity.field"} declares a
     * {@code field.<subType>} or array-ness that differs from its resolved source field —
     * a passthrough forwards the value unchanged, so the type must be identical. Host-agnostic
     * (projections, entities, values, and the FR-015 stored-proc parameter refs the retired
     * {@code ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH} used to cover). Nullability is NOT
     * judged. Opt out of a deliberate type change with {@code @convert: true} (acknowledgement
     * only — no generated cast).
     */
    ERR_PASSTHROUGH_TYPE_MISMATCH,

    /**
     * FR-024 (spec §7): an object.entity field carrying an origin.* child is derived
     * (read-only) and must be providable — the entity must declare at least one source
     * with a read-only kind (view/materializedView/storedProc/tableFunction) to carry
     * it; table-only or source-less entities with origin-bearing fields error.
     * Projections and object.value hosts are exempt. Vocabulary-only here until
     * FR-024 Phase E.
     */
    ERR_DERIVED_FIELD_NO_READ_SOURCE,

    /** FR-024 (ADR-0028) hard cutover: an entity's PRIMARY source has a read-only @kind —
     *  read-only kinds are legal only in non-primary roles; a derived read model is an
     *  object.projection. Vocabulary-only here until Phase-E validation parity. */
    ERR_ENTITY_PRIMARY_SOURCE_READONLY,

    /**
     * FR-017: a M:N relationship's slim vocabulary is invalid — {@code @through} does not
     * name a junction declaring two {@code identity.reference} children, {@code @sourceRefField}
     * does not match one of them, or a M:N-only attr is set on a non-M:N relationship;
     * OR a relationship's {@code @objectRef} does not resolve to any object in the tree.
     */
    ERR_INVALID_RELATIONSHIP,

    /**
     * An {@code identity.reference} {@code @references} names an FK target object that
     * does not resolve to any object in the loaded tree (a dangling cross-reference).
     */
    ERR_INVALID_REFERENCE,

    /** A template declares a @payloadRef that does not resolve, or @requiredSlots that are not fields. */
    ERR_INVALID_TEMPLATE,

    /** Build-time verify: a template variable references a field the payload does not declare. */
    ERR_VAR_NOT_ON_PAYLOAD,

    /** Codegen (ADR-0044): two value-object FQNs in one payload artifact derive the same emitted
     *  record name even after package-qualification. Peer of ERR_VAR_NOT_ON_PAYLOAD. */
    ERR_PAYLOAD_NAME_COLLISION,

    /** Build-time verify: a template partial does not resolve in the configured provider. */
    ERR_PARTIAL_UNRESOLVED,

    /** Build-time verify (warning): a template's declared @requiredSlots slot is never referenced. */
    ERR_REQUIRED_SLOT_UNUSED,

    /**
     * Build-time verify: a template declares @requiredTags but its text omits a required
     * output tag's opening or closing form.
     */
    ERR_OUTPUT_TAG_MISSING,

    /** A dataGrid @filter references a non-filterable field or uses a disallowed op. */
    ERR_BAD_ATTR_FILTER,

    /** @storage "flattened" cannot be combined with isArray=true. */
    ERR_STORAGE_FLATTENED_ARRAY,

    /** @storage was set on a field that has no @objectRef. */
    ERR_STORAGE_WITHOUT_OBJECT_REF,

    /** ADR-0013: a field.object declares no @objectRef (use @dbColumnType: jsonb for an open map). */
    ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,

    /**
     * ADR-0042: a {@code field.object} / {@code field.map} {@code @objectRef} does not
     * resolve to any object in the loaded tree (a dangling target). The ref resolves
     * package-locally when bare (the referrer's package, else a root-level object) and
     * exactly when FQN — a bare cross-package ref no longer binds elsewhere. The
     * required-attr pass owns absence ({@code ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF});
     * this code fires only when {@code @objectRef} is present but resolves to nothing.
     */
    ERR_UNRESOLVED_OBJECT_REF,

    /** An object declares source nodes but none has role=primary. */
    ERR_SOURCE_NO_PRIMARY,

    /** An object declares more than one source node with role=primary. */
    ERR_SOURCE_MULTIPLE_PRIMARY,

    /** Phase-1 metadata-source-resolution: a {@code path} source declared in {@code .metaobjects/config.json} does not exist on disk. */
    ERR_SOURCE_UNRESOLVED,

    /** Phase-1 metadata-source-resolution: a declared source kind ({@code resource} or {@code package}) is not supported by this toolchain. */
    ERR_SOURCE_KIND_UNSUPPORTED,

    /** Phase-1 metadata-source-resolution: a {@code scope} include/exclude package pattern is malformed (empty pattern or empty {@code ::} segment). */
    ERR_SCOPE_PATTERN_INVALID,

    /** Phase-1 metadata-source-resolution: no metadata collection was discovered — no config declaring {@code sources}, and no default {@code metaobjects/} directory. */
    ERR_COLLECTION_NOT_FOUND,

    /**
     * FR-016 / ADR-0018: a {@code source.rdb} declares a kind-aware physical-name
     * alias ({@code @view} / {@code @materializedView} / {@code @proc} /
     * {@code @function}) that does not match its {@code @kind}. The legacy
     * {@code @table}-for-non-table case warns rather than errors.
     */
    ERR_PHYSICAL_NAME_KIND_MISMATCH,

    /**
     * FR-016 / ADR-0018: a {@code source.rdb} declares two or more kind-aware
     * physical-name aliases at once (e.g. both {@code @table} and {@code @view}).
     * Exactly one is permitted.
     */
    ERR_PHYSICAL_NAME_MULTIPLE,

    /**
     * FR-013: a field with {@code @readOnly: true} is the target of an
     * {@code identity.primary} with {@code @generation: "assigned"}. The
     * application has no path to populate the identity value.
     */
    ERR_MUTABILITY_AUTOSET_CONFLICT,

    ERR_MUTABILITY_DOWNGRADE,

    ERR_READONLY_ASSIGNED_PRIMARY,

    /**
     * FR-013: a concrete entity declares {@code @readOnly: false} on a field
     * whose extends-chain parent declares {@code @readOnly: true}. Read-only-ness
     * can only be upgraded, never downgraded.
     */

    /** FR-015: source.rdb @parameterRef names an object that does not exist. */
    ERR_PARAMETER_REF_UNRESOLVED,

    /** FR-015: source.rdb @parameterRef references an object.entity (not object.value). */
    ERR_PARAMETER_REF_NOT_VALUE_OBJECT,

    /** FR-015: source.rdb @parameterRef set on a non-callable kind (table/view/materializedView). */
    ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,

    // #185: ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH RETIRED — the narrow FR-015 parameter-ref
    // passthrough type check is generalized by the universal ERR_PASSTHROUGH_TYPE_MISMATCH (above),
    // which validateOrigins already applies to every origin.passthrough (value hosts included).

    /** FR-014: object.entity @discriminator names a field that does not exist on the entity. */
    ERR_DISCRIMINATOR_FIELD_NOT_FOUND,

    /** FR-014: two subtypes of the same root claim the same @discriminatorValue. */
    ERR_DISCRIMINATOR_VALUE_DUPLICATE,

    /** FR-014: a concrete subtype of a @discriminator-bearing root is missing @discriminatorValue. */
    ERR_DISCRIMINATOR_VALUE_MISSING,

    /** FR-014: @discriminatorValue is not a member of an enum discriminator's @values, or fails the field's coercion. */
    ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,

    /**
     * Two contributing files set the same {@code @attr} on the same node to
     * different non-empty values during overlay merge (FR5c). Envelope is
     * {@code format: "merged"} with both contributors listed.
     */
    ERR_MERGE_CONFLICT,

    /**
     * SP-H Unit9 — a field carries {@code @filterable: true} but its subtype has
     * no filter-operator band (e.g. {@code field.object}). Generating a filter
     * for it would emit an empty operator set — a route that rejects every request.
     */
    ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,

    /**
     * #335 Half B — a field carries {@code @sortable: true} but is an array or
     * its subtype has no filter-operator band (e.g. {@code field.object}), the
     * same subtype-support signal {@code @filterable} uses. Generating a sort
     * entry for it would emit an ORDER BY no dialect can execute.
     */
    ERR_SORTABLE_UNSUPPORTED_SUBTYPE,

    /**
     * #335 Half A — a whole-object {@code @agg:collect}'s value-object member has no
     * matching field (by name) on the {@code @via} terminal entity. The lowering
     * projects exactly the declared members; failing open here is how #270 turned a
     * curated value object into the full entity.
     */
    ERR_COLLECT_MEMBER_UNRESOLVED,

    /**
     * ADR-0023 Decision 2: a registration ({@code register}/{@code extendType}/
     * {@code registerCommonAttribute}/{@code addConstraint}/{@code registerType}/
     * {@code setDefaultSubType}/{@code addGlobalChildRequirement}/{@code registerProviders})
     * was attempted against a registry that has been sealed after its agreed
     * metamodel-provider bootstrap. Made-up metamodel attributes/types are
     * structurally impossible: codegen cannot register post-bootstrap.
     */
    ERR_REGISTRY_SEALED,

    /**
     * FR-032 (ADR-0032): a ref-bearing attribute in canonical JSON carries a
     * relative reference form (a value starting with {@code ::} or {@code ..::}).
     * Canonical JSON is the self-contained interchange form and MUST be fully
     * qualified — relative forms are a YAML-authoring affordance the desugar
     * expands, so they must never survive into canonical JSON.
     */
    ERR_RELATIVE_REF_IN_CANONICAL,

    /**
     * Index-key resolution for {@code index.lookup} AND {@code identity.secondary}
     * (#342) — the key is {@code @fields} XOR {@code @expr}: neither declared, BOTH
     * declared ({@code @expr} is used INSTEAD of {@code @fields}), whichever is
     * declared supplies no key, or a named field does not exist on the owning
     * entity's effective (resolved, via {@code extends:}) field set.
     */
    ERR_INVALID_INDEX,

    /**
     * #195: an {@code origin.computed} {@code @expr} tree contains a node whose
     * kind/op/fn is not in the closed expression grammar (field/value refs,
     * comparisons sharing the filter op vocabulary, {@code isNull}/{@code isNotNull},
     * {@code and}/{@code or}/{@code not}, {@code coalesce}). Fail-closed per ADR-0023;
     * the detail names the offending token.
     */
    ERR_UNKNOWN_EXPR_NODE,

    /**
     * #195: an {@code origin.computed} {@code @expr} tree's inferred root type does
     * not equal the carrying field's declared {@code field.<subType>}. A computed
     * column's type is DERIVED from its expression, never asserted (no {@code @convert}
     * escape), so a mismatch is a hard load error (sibling of
     * {@code ERR_PASSTHROUGH_TYPE_MISMATCH}).
     */
    ERR_COMPUTED_TYPE_MISMATCH,

    /**
     * #208 (DDL-ownership escape valves, design doc §5 R1): a {@code source.rdb}
     * declares both {@code @sql} and {@code @unmanaged} — the two mutually
     * exclusive non-default states of one DDL-ownership axis (an author-supplied
     * body contradicts "someone else owns this DDL").
     */
    ERR_SQL_BODY_WITH_UNMANAGED,

    /**
     * #208 (design doc §5 R2): a {@code source.rdb} declares {@code @sql} with a
     * writable {@code @kind} ("table", the default) — {@code @sql} is legal only
     * on a read-only kind (view/materializedView/storedProc/tableFunction); a
     * writable table is either fully modeled or marked {@code @unmanaged}, never
     * opaque-bodied.
     */
    ERR_SQL_BODY_ON_WRITABLE_KIND,

    /**
     * #208 (design doc §5 R4/R5): a field carrying an {@code origin.*} (derived)
     * child — or, for an {@code object.projection}, a row-scope {@code @filter}
     * (#207) — lives under a host object that declares an {@code @sql} read
     * source. The synthesized derivation/filter and the author's verbatim SQL
     * body are two sources of truth for the same data.
     */
    ERR_ORIGIN_UNDER_SQL_BODY,

    /**
     * #246: a {@code field.enum} both extends a shared package-level abstract
     * enum and declares its own {@code @values}. One shared enum type has one
     * member set — the own {@code @values} would be silently dropped in
     * codegen. Remove the own {@code @values} to inherit the shared set, or
     * extend a concrete (non-shared) enum instead.
     */
    ERR_ENUM_EXTENDS_VALUES_CONFLICT,

    /**
     * A {@code field.enum} carries {@code @intValueMap} together with
     * {@code isArray=true}. Int-backing is a persistence-layer codec and no port
     * implements it element-wise over an array column, so the combination would
     * silently persist member SYMBOLS into an integer array. An array-of-enum
     * stays string-backed: drop {@code @intValueMap}, or make the field scalar.
     */
    ERR_ENUM_INT_VALUE_MAP_ARRAY,

    /** An internal loader error with no stable error code. */
    ERR_UNKNOWN,
}
