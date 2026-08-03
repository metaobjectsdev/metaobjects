"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .attr_class_map import attr_class_for
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_EXPRESSION,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPES,
)
from .meta.core.field import field_constants as fc
from .meta.core.validator import validator_constants as vc
from .meta.core.field.field_constants import (
    AUTO_SET_VALUES,
    FIELD_ATTR_AUTO_SET,
    FIELD_ATTR_CURRENCY,
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_PROVIDED,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_PRECISION,
    FIELD_ATTR_READ_ONLY,
    FIELD_ATTR_REQUIRED,
    FIELD_ATTR_SCALE,
    FIELD_ATTR_STORAGE,
    FIELD_ATTR_STRING_FORMAT,
    FIELD_ATTR_UNIQUE,
    FIELD_ATTR_VALUE_TYPE,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
    STORAGE_VALUES,
    STRING_FORMAT_VALUES,
)
from .meta.core.field.meta_field import MetaField
from .meta.persistence.db.db_constants import (
    FIELD_ATTR_DB_INDEXED,
)
from .meta.core.identity.identity_constants import (
    GENERATION_VALUES,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_REFERENCE_ATTR_ENFORCE,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_PRIMARY,
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_SUBTYPE_SECONDARY,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.index.index_constants import INDEX_ATTR_FIELDS, INDEX_SUBTYPES
from .meta.core.index.meta_index import MetaIndex
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
    OBJECT_PROJECTION_ATTR_FILTER,
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPES,
)
from .meta.core.relationship.meta_relationship import MetaRelationship
from .meta.core.relationship.relationship_constants import (
    REFERENTIAL_ACTIONS,
    RELATIONSHIP_ATTR_CARDINALITY,
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_ON_DELETE,
    RELATIONSHIP_ATTR_ON_UPDATE,
    RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
    RELATIONSHIP_ATTR_SYMMETRIC,
    RELATIONSHIP_ATTR_THROUGH,
    RELATIONSHIP_SUBTYPES,
)
from .meta.meta_data import MetaData
from .meta.meta_root import MetaRoot
from .meta.persistence.origin.meta_origin import MetaOrigin
from .meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_AGG,
    ORIGIN_ATTR_CONVERT,
    ORIGIN_ATTR_DISTINCT,
    ORIGIN_ATTR_EXPR,
    ORIGIN_ATTR_FILTER,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_ORDER_BY,
    ORIGIN_ATTR_VIA,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COLLECTION,
    ORIGIN_SUBTYPE_COMPUTED,
    ORIGIN_SUBTYPE_FIRST,
    ORIGIN_SUBTYPE_PASSTHROUGH,
)
from .meta.template.meta_template import MetaTemplate
from .meta.template import template_constants as tc
from .meta.persistence.source.meta_source import MetaSource
from .meta.persistence.source.source_constants import (
    SOURCE_ATTR_FUNCTION,
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_MATERIALIZED_VIEW,
    SOURCE_ATTR_PARAMETER_REF,
    SOURCE_ATTR_PROC,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_SQL,
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_UNMANAGED,
    SOURCE_ATTR_VIEW,
    SOURCE_RDB_KINDS,
    SOURCE_ROLES,
    SOURCE_SUBTYPE_RDB,
)
from .meta.presentation.layout.layout_constants import (
    LAYOUT_SUBTYPES,
)
from .meta.presentation.layout.meta_layout import MetaLayout
from .meta.presentation.view.meta_view import MetaView
from .meta.presentation.view.view_constants import (
    VIEW_SUBTYPES,
)
from .provider import Provider
from .registry import AttrSchema, ChildRule, NodeFactory, TypeDefinition, TypeRegistry
from .validation_types import ReferenceDescriptor
from .shared.base_types import (
    SUBTYPE_BASE,
    SUBTYPE_ROOT,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_INDEX,
    TYPE_LAYOUT,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
    TYPE_SOURCE,
    TYPE_TEMPLATE,
    TYPE_VALIDATOR,
    TYPE_VIEW,
)

class _CoreProvider(Provider):
    """Subclass of Provider that also designates default subTypes for YAML authoring (ADR-0006).

    `metadata` has exactly one subtype (`root`) so the default is unambiguous;
    `object` defaults to `entity` (the common case). Other types (field,
    validator, ...) have no default — authoring always writes the full
    `type.subType`. Mirrors registerCoreTypeDefs in TS core-types.ts.
    """

    def register_types(self, registry: TypeRegistry) -> None:
        super().register_types(registry)
        registry.set_default_sub_type(TYPE_METADATA, SUBTYPE_ROOT)
        registry.set_default_sub_type(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)


core_provider = _CoreProvider("metaobjects-core-types")


def _register_subtypes(
    provider: Provider,
    type_name: str,
    subtypes: tuple[str, ...],
    factory: NodeFactory,
    child_rules: list[ChildRule] | None = None,
    attrs: list[AttrSchema] | None = None,
    references: list[ReferenceDescriptor] | None = None,
) -> None:
    """Register one TypeDefinition per subtype. Centralises loop boilerplate only —
    all type knowledge (subtypes tuple, node class, child rules) stays with the caller."""
    for sub in subtypes:
        provider.add(
            TypeDefinition(
                type=type_name,
                sub_type=sub,
                factory=factory,
                child_rules=list(child_rules) if child_rules else [],
                attrs=list(attrs) if attrs else [],
                references=list(references) if references else [],
            )
        )


# metadata.root — the document-root WRAPPER. FR-033 (sub-step B2): metadata.root is
# NOT declared in any spec/metamodel/*.json provider file; both this port and the TS
# reference HAND-CODE the root (the single documented hand-coded exception to the
# JSON-sourced model). Its STRUCTURAL children must byte-match the cross-port golden:
# description "Root metadata document" and EXACTLY the four genuinely-open structural
# wildcards a document root legitimately holds — field / object / template / validator
# (mirrors the TS core-types.ts root def and the Java MetaRoot registration). Because
# it is undeclared in the JSON, the strict-children pass leaves it untouched, so the
# children registered HERE are emitted verbatim. The any-attr wildcard is intentionally
# omitted — the golden carries attrs:[] for the root (no metadata-attr vocabulary).
core_provider.add(
    TypeDefinition(
        type=TYPE_METADATA,
        sub_type=SUBTYPE_ROOT,
        factory=MetaRoot,
        description="Root metadata document",
        child_rules=[
            ChildRule(TYPE_FIELD, "*"),
            ChildRule(TYPE_OBJECT, "*"),
            ChildRule(TYPE_TEMPLATE, "*"),
            ChildRule(TYPE_VALIDATOR, "*"),
        ],
    )
)


# object.* (entity, value, projection)
_OBJECT_CHILD_RULES = [
    ChildRule(TYPE_FIELD, "*"),
    ChildRule(TYPE_IDENTITY, "*"),
    ChildRule(TYPE_INDEX, "*"),
    ChildRule(TYPE_ATTR, "*"),
    ChildRule(TYPE_SOURCE, "*"),
    ChildRule(TYPE_RELATIONSHIP, "*"),
    ChildRule(TYPE_LAYOUT, "*"),
    # template.* under object.entity — a declared prompt/output lives WITH its
    # entity (AI LLM-call trace persistence; the trace entity carries a nested
    # template.prompt). Mirrors Java MetaObject.optionalChild("template","*","*").
    ChildRule(TYPE_TEMPLATE, "*"),
]
# FR-024 (ADR-0028): object.projection licenses NO relationship and NO template
# children — a projection is a derived read-only representation, never a
# relationship host. Mirrors the TS reference's per-subtype projectionRules.
_PROJECTION_CHILD_RULES = [
    ChildRule(TYPE_FIELD, "*"),
    ChildRule(TYPE_IDENTITY, "*"),
    ChildRule(TYPE_ATTR, "*"),
    ChildRule(TYPE_SOURCE, "*"),
    ChildRule(TYPE_LAYOUT, "*"),
]
# FR-014: @discriminator / @discriminatorValue (TPH single-table inheritance) are
# registered on EVERY object subtype (base/entity/value) — cross-port contract.
_OBJECT_COMMON_ATTRS = [
    AttrSchema(name=OBJECT_ATTR_DISCRIMINATOR, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(
        name=OBJECT_ATTR_DISCRIMINATOR_VALUE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
    ),
]
# FR-011: @normalize is an object-level default for the enum fields of a payload
# value-object — registered on object.value ONLY (not entity/base). FR-033 re-homes
# it to the prompt domain provider (`prompt_provider`, metaobjects-prompt) via
# TypeRegistry.extend (prompt.json declares it on object.value), matching the TS
# promptProvider split. object.value carries only the shared object attrs in core.
for _obj_sub in OBJECT_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_OBJECT,
            sub_type=_obj_sub,
            factory=MetaObject,
            child_rules=list(
                _PROJECTION_CHILD_RULES
                if _obj_sub == OBJECT_SUBTYPE_PROJECTION
                else _OBJECT_CHILD_RULES
            ),
            attrs=list(_OBJECT_COMMON_ATTRS),
        )
    )

# #207 — object.projection carries an optional row-scope @filter (a portable
# attr.filter object — the SAME attr subtype as origin.aggregate's @filter) that
# lowers to a view-level SQL WHERE. The object loop above registered every subtype
# with the shared discriminator attrs; append @filter to the projection def
# (mirrors the field.currency enrichment below, and the TS object provider, where
# object.json's projection block declares the filter attr child). The strict
# per-subtype attr scoping (apply_spec_descriptions) then keeps @filter on
# projection and prunes the shared discriminator attrs — object.json's projection
# block declares ONLY @filter.
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_OBJECT and _def.sub_type == OBJECT_SUBTYPE_PROJECTION:
        _def.attrs.append(
            AttrSchema(
                name=OBJECT_PROJECTION_ATTR_FILTER,
                value_type=ATTR_SUBTYPE_FILTER,
                required=False,
            )
        )
        break

# field.* (one factory, data_type by subtype)
# Note: FIELD_SUBTYPE_ENUM is excluded from FIELD_SUBTYPES; it is registered
# separately below with its required @values AttrSchema (sharing these child rules).
_FIELD_CHILD_RULES = [
    ChildRule(TYPE_ATTR, "*"),
    ChildRule(TYPE_ORIGIN, "*"),
    ChildRule(TYPE_VIEW, "*"),
    ChildRule(TYPE_VALIDATOR, "*"),
]
# Common field attrs declared by the core port. Each attr carries a declared
# `value_type` so the YAML desugar's D2 type-coercion guard (ADR-0006) can
# detect a YAML 1.2 silently-coerced unquoted value (e.g. `maxLength: true`
# coerced to boolean instead of the int it should be).
#
# Mirrors server/typescript/packages/metadata/src/core/field/field-schema.ts
# `commonFieldAttrs` and server/csharp/MetaObjects/Core/Field/FieldSchema.cs
# `CommonFieldAttrs` so Python's coercion coverage stays at parity.
#
# The TS port registers `@column` through a dedicated dbProvider that extends
# field types; Python keeps it on the core field defs until a full Python
# db-codegen port lands.
_FIELD_COMMON_ATTRS = [
    AttrSchema(name=FIELD_ATTR_OBJECT_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
    # @storage applies to field.object only (cross-port); validation_passes enforces
    # the shape rules + non-object-subtype guard. Declared at the common level so
    # the AttrSchema parser doesn't reject it on field.object before validation runs.
    AttrSchema(
        name=FIELD_ATTR_STORAGE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=STORAGE_VALUES,
    ),
    AttrSchema(name=FIELD_ATTR_REQUIRED, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    # @readOnly — field exposed read-only (omitted from create/update input DTOs).
    # Cross-port logical field attr (every field subtype). Mirrors TS commonFieldAttrs.
    AttrSchema(name=FIELD_ATTR_READ_ONLY, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    AttrSchema(name=FIELD_ATTR_UNIQUE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    # @db.indexed — DB-domain index-intent flag on every field subtype. The TS
    # port registers it through a dedicated metaobjects-db provider; Python keeps
    # the DB-domain physical attrs (@column / @dbColumnType / @db.indexed) on the
    # core field defs (same rationale as @column / @dbColumnType below).
    AttrSchema(name=FIELD_ATTR_DB_INDEXED, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    # @default is polymorphic: its value type follows the OWNING field's
    # subtype. No single fixed valueType can capture that, so value_type is
    # intentionally None (declared-but-untyped). The YAML coercion guard
    # skips entries with value_type=None.
    AttrSchema(name=FIELD_ATTR_DEFAULT, value_type=None, required=False),
    AttrSchema(name=FIELD_ATTR_MAX_LENGTH, value_type=ATTR_SUBTYPE_INT, required=False),
    AttrSchema(name=FIELD_ATTR_PRECISION, value_type=ATTR_SUBTYPE_INT, required=False),
    AttrSchema(name=FIELD_ATTR_SCALE, value_type=ATTR_SUBTYPE_INT, required=False),
    AttrSchema(
        name=FIELD_ATTR_AUTO_SET,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=AUTO_SET_VALUES,
    ),
    # NOTE: the DB-domain physical field attrs (@column, @dbColumnType) are NOT
    # declared here — they are DB-domain concerns registered by the dedicated
    # `db_provider` (metaobjects-db) via TypeRegistry.extend, mirroring the
    # cross-port end-state (Java CoreDBMetaDataProvider / TS dbProvider / C#
    # DbMetaDataProvider). The @dbColumnType (subtype × value) pairing legality is
    # still enforced by the loader's _validate_db_column_type pass (unconditional).
    #
    # FR-033 — the UI / query-surface markers (@filterable / @sortable /
    # @sortableDefaultOrder) and the prompt / field-teaching markers (@example /
    # @instruction) are NO LONGER declared here. They are re-homed to the dedicated
    # `ui_provider` (metaobjects-ui) and `prompt_provider` (metaobjects-prompt) via
    # TypeRegistry.extend, matching the TS provider split (uiProvider / promptProvider).
    # The composed registry is unchanged (the manifest is provider-agnostic).
]
_register_subtypes(
    core_provider,
    TYPE_FIELD,
    fc.FIELD_SUBTYPES,
    factory=MetaField,
    child_rules=_FIELD_CHILD_RULES,
    attrs=_FIELD_COMMON_ATTRS,
)

# field.currency carries the @currency attr (ISO 4217) IN ADDITION to the common
# field attrs. The bulk loop above registered field.currency with the common
# attrs; append @currency to that definition (mirrors TS, where field.currency's
# attr set = commonFieldAttrs + currencyFieldAttr).
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_FIELD and _def.sub_type == fc.FIELD_SUBTYPE_CURRENCY:
        _def.attrs.append(
            AttrSchema(name=FIELD_ATTR_CURRENCY, value_type=ATTR_SUBTYPE_STRING, required=False)
        )
        break

# field.string carries the @stringFormat attr (ADR-0036/0037 Wave 3 — a closed
# validation format: email | hostname) IN ADDITION to the common field attrs. The
# field stays a plain string (native binding + DB column unchanged); codegen owns
# the canonical matcher per format. Append @stringFormat to the field.string def
# registered by the bulk loop (mirrors TS, where field.string's attr set =
# commonFieldAttrs + the @stringFormat closed-enum attr). The closed value-set
# (allowed_values) gates the manifest's allowedValues + the loader value check.
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_FIELD and _def.sub_type == fc.FIELD_SUBTYPE_STRING:
        _def.attrs.append(
            AttrSchema(
                name=FIELD_ATTR_STRING_FORMAT,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=STRING_FORMAT_VALUES,
            )
        )
        break

# #234 — field.uri / field.inet carry the @lenient attr (opt out of strict URI / IP-literal
# well-formedness; codegen binds a plain string, and field.inet a text column) IN ADDITION to the
# common field attrs. Mirrors the @stringFormat enrichment above (and TS/Java/C#).
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_FIELD and _def.sub_type in (fc.FIELD_SUBTYPE_URI, fc.FIELD_SUBTYPE_INET):
        _def.attrs.append(
            AttrSchema(name=fc.FIELD_ATTR_LENIENT, value_type=ATTR_SUBTYPE_BOOLEAN, required=False)
        )

# field.map carries the @valueType attr (scalar value subtype) IN ADDITION to the
# common field attrs (@objectRef is already common). The bulk loop registered
# field.map with the common attrs; append @valueType to that definition (mirrors
# TS, where field.map's attr set = commonFieldAttrs + @valueType + @objectRef).
# The exactly-one-of @valueType/@objectRef rule is enforced by validation_passes.
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_FIELD and _def.sub_type == fc.FIELD_SUBTYPE_MAP:
        _def.attrs.append(
            AttrSchema(name=FIELD_ATTR_VALUE_TYPE, value_type=ATTR_SUBTYPE_STRING, required=False)
        )
        break

# ADR-0042 — a field.object / field.map @objectRef must RESOLVE (a dangling target
# fails the load, closing the gap #191 surfaced as a misleading downstream error).
# The required-attr pass owns absence (ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF); this
# reference descriptor fires only when @objectRef is present but resolves to nothing
# → ERR_UNRESOLVED_OBJECT_REF. Mirrors the TS core-types.ts registerCoreTypeDefs.
for _def in core_provider._defs:  # noqa: SLF001 (provider build-time enrichment)
    if _def.type == TYPE_FIELD and _def.sub_type in (
        fc.FIELD_SUBTYPE_OBJECT,
        fc.FIELD_SUBTYPE_MAP,
    ):
        _def.references.append(
            ReferenceDescriptor(
                FIELD_ATTR_OBJECT_REF, TYPE_OBJECT, None, False, "ERR_UNRESOLVED_OBJECT_REF"
            )
        )

# field.enum — dedicated registration with required @values attr.
# Inherits every common field attr (column / required / unique / default /
# maxLength / filterable / sortable / etc.) so the D2 type-coercion guard
# applies uniformly across all fields.
core_provider.add(
    TypeDefinition(
        type=TYPE_FIELD,
        sub_type=FIELD_SUBTYPE_ENUM,
        factory=MetaField,
        attrs=list(_FIELD_COMMON_ATTRS) + [
            AttrSchema(
                name=FIELD_ATTR_VALUES,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                is_array=True,
            ),
            # FR-019 (ADR-0026): @provided boolean — marks an abstract package-level enum
            # as externally provided (codegen references it instead of materializing). The
            # boolean AttrSchema rejects a non-boolean value (ERR_BAD_ATTR_VALUE).
            AttrSchema(
                name=FIELD_ATTR_PROVIDED,
                value_type=ATTR_SUBTYPE_BOOLEAN,
                required=False,
            ),
            # FR-033 — the field.enum tolerant-extract overlays (@enumAlias / @enumDoc /
            # @coerceDefault / @normalize) are NO LONGER declared here; they are re-homed
            # to the prompt domain provider (`prompt_provider`, metaobjects-prompt) via
            # TypeRegistry.extend, matching the TS promptProvider split. @values + @provided
            # stay in core (they are core field.enum properties, declared in field.json).
        ],
        child_rules=_FIELD_CHILD_RULES,
    )
)

# attr.* (factory resolved per subtype via the attr-class map at parse time)
_register_subtypes(
    core_provider,
    TYPE_ATTR,
    ATTR_SUBTYPES,
    factory=lambda t, s, n: attr_class_for(s)(t, s, n),
)

# identity.primary — @fields required stringArray; @generation optional with allowed values
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_PRIMARY,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            AttrSchema(
                name=IDENTITY_ATTR_GENERATION,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=GENERATION_VALUES,
            ),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
        # max_occurs/default_name are hardcoded here (matching the values in
        # spec_metamodel/identity.json, which this port does NOT yet read). Sourcing them from
        # that JSON — true single-source-of-truth across all ports — is the config-driven-
        # validation work tracked in issue #51.
        max_occurs=1,
        default_name="primary",
    )
)

# identity.secondary — @fields required stringArray. Always enforces uniqueness;
# use index.lookup for non-unique indexes. @unique is no longer a core attr
# (removed — the secondary index is always unique by definition).
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_SECONDARY,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# identity.reference — @fields (required), @references (required), @enforce (optional boolean)
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_REFERENCE,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            AttrSchema(name=IDENTITY_REFERENCE_ATTR_REFERENCES, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=IDENTITY_REFERENCE_ATTR_ENFORCE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
        # @references is a cross-reference to a real object (FK target) — the loader's
        # registry-derived validation resolves it; "Entity.field" resolves the entity head.
        references=[ReferenceDescriptor(
            IDENTITY_REFERENCE_ATTR_REFERENCES, TYPE_OBJECT, None, True, "ERR_INVALID_REFERENCE")],
    )
)

# index.lookup — non-unique lookup index on one or more fields.
# Distinct from identity.secondary (which always enforces uniqueness).
# Physical attrs (@orders/@expr/@where/@using) are contributed by the db provider.
for _idx_sub in INDEX_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_INDEX,
            sub_type=_idx_sub,
            factory=MetaIndex,
            attrs=[
                AttrSchema(name=INDEX_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            ],
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# relationship.* (base, association, aggregation, composition).
# @onDelete / @onUpdate are validated against REFERENTIAL_ACTIONS — kebab-case
# values (cascade / set-null / restrict / no-action). Defaults derive from the
# relationship subtype at consumption time, not at validation time.
_RELATIONSHIP_ATTRS = [
    # Logical relationship attrs (cross-port; on every relationship subtype incl. base).
    # @cardinality is an open string at the metamodel level (no allowed_values) — the
    # legal-value check is a downstream concern, matching TS.
    AttrSchema(name=RELATIONSHIP_ATTR_CARDINALITY, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=RELATIONSHIP_ATTR_OBJECT_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
    # FR-017 slim M:N vocabulary — @through (junction entity), @sourceRefField
    # (directed-self-join disambiguator), @symmetric (undirected-self-join flag).
    # The pre-FR-017 @joinEntity/@joinFields attrs are REMOVED (FK fields derive
    # from the junction's two identity.reference children).
    AttrSchema(name=RELATIONSHIP_ATTR_THROUGH, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=RELATIONSHIP_ATTR_SOURCE_REF_FIELD, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=RELATIONSHIP_ATTR_SYMMETRIC, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    AttrSchema(
        name=RELATIONSHIP_ATTR_ON_DELETE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=REFERENTIAL_ACTIONS,
    ),
    AttrSchema(
        name=RELATIONSHIP_ATTR_ON_UPDATE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=REFERENTIAL_ACTIONS,
    ),
]
_register_subtypes(
    core_provider,
    TYPE_RELATIONSHIP,
    RELATIONSHIP_SUBTYPES,
    factory=MetaRelationship,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
    attrs=_RELATIONSHIP_ATTRS,
    # @objectRef is a cross-reference to a real object (the relationship target); the
    # loader's registry-derived validation resolves it (dangling target = load error).
    references=[ReferenceDescriptor(
        RELATIONSHIP_ATTR_OBJECT_REF, TYPE_OBJECT, None, False, "ERR_INVALID_RELATIONSHIP")],
)

# source.* — base (no attrs) + rdb (paradigm subtype with @table/@kind/@role/@schema).
# ADR-0007: read-only-ness is derived from @kind; multi-source one-primary rule is
# enforced in validation_passes.py.
core_provider.add(
    TypeDefinition(
        type=TYPE_SOURCE,
        sub_type=SUBTYPE_BASE,
        factory=MetaSource,
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
core_provider.add(
    TypeDefinition(
        type=TYPE_SOURCE,
        sub_type=SOURCE_SUBTYPE_RDB,
        factory=MetaSource,
        attrs=[
            # FR-016 / ADR-0018 — per-kind physical-name aliases (all five fill
            # the same internal slot; only one may be set per source).
            AttrSchema(name=SOURCE_ATTR_TABLE, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=SOURCE_ATTR_VIEW, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(
                name=SOURCE_ATTR_MATERIALIZED_VIEW,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
            ),
            AttrSchema(name=SOURCE_ATTR_PROC, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=SOURCE_ATTR_FUNCTION, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(
                name=SOURCE_ATTR_KIND,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=SOURCE_RDB_KINDS,
            ),
            AttrSchema(
                name=SOURCE_ATTR_ROLE,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=SOURCE_ROLES,
            ),
            AttrSchema(name=SOURCE_ATTR_SCHEMA, value_type=ATTR_SUBTYPE_STRING, required=False),
            # FR-024/#208 escape valves — registration only, no validation/lowering here.
            AttrSchema(name=SOURCE_ATTR_SQL, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=SOURCE_ATTR_UNMANAGED, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
            # FR-015 — @parameterRef: input-shape object.value for proc/table-function sources.
            AttrSchema(
                name=SOURCE_ATTR_PARAMETER_REF,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
            ),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.base — no schema (pass-through container)
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=SUBTYPE_BASE,
        factory=MetaOrigin,
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.passthrough — @from required, @via optional, @convert optional (#185).
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_PASSTHROUGH,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_FROM, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
            # #185 — opt out of the type-preserving ERR_PASSTHROUGH_TYPE_MISMATCH check.
            AttrSchema(name=ORIGIN_ATTR_CONVERT, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.aggregate — @agg required; @of/@via/@distinct/@orderBy optional.
# FR-024 (ADR-0029): @via is inferable when exactly one single-hop relationship
# reaches the @of entity. #195: @of relaxed to optional (any/all forbid it, the
# rest require it) — presence is enforced per-@agg in the origin validation pass;
# @agg vocabulary extended with any/all (predicate quantifiers) + collect (array
# rollup); @distinct (collect set-semantics) + @orderBy (element/row ordering) added.
_AGG_ALLOWED = ("count", "sum", "avg", "min", "max", "any", "all", "collect")
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_AGGREGATE,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(
                name=ORIGIN_ATTR_AGG,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                allowed_values=_AGG_ALLOWED,
            ),
            AttrSchema(name=ORIGIN_ATTR_OF, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=ORIGIN_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER, required=False),
            AttrSchema(name=ORIGIN_ATTR_DISTINCT, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
            AttrSchema(name=ORIGIN_ATTR_ORDER_BY, value_type=ATTR_SUBTYPE_STRING, required=False, is_array=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.computed (#195) — a row-level value from the base entity's own fields
# via a structured @expr tree (attr.expression). No related rows / @via.
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_COMPUTED,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_EXPR, value_type=ATTR_SUBTYPE_EXPRESSION, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.first (#195) — the single related row selected by @orderBy along @via,
# projecting @of. @of + @orderBy required; @via + @filter optional.
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_FIRST,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_OF, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=ORIGIN_ATTR_ORDER_BY, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            AttrSchema(name=ORIGIN_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.collection — owned-array origin (@via required, points at a relationship path).
# Mirrors Java's CollectionOrigin / TS origin.collection. Path traversal is intentionally
# NOT enforced here (matches TS).
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_COLLECTION,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# view.* (base + 13 control kinds). FR-033 — view.currency's @locale is re-homed to
# the UI domain provider (`ui_provider`, metaobjects-ui) via TypeRegistry.extend
# (ui.json declares @locale on view.currency), matching the TS uiProvider split. Core
# registers every view subtype with NO own attrs.
for _view_sub in VIEW_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_VIEW,
            sub_type=_view_sub,
            factory=MetaView,
            attrs=[],
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# layout.* (base, dataGrid). FR-033 — every layout.dataGrid attr (@columns /
# @defaultSortField / @defaultSortOrder / @pageSize / @filterable / @filter) is
# re-homed to the UI domain provider (`ui_provider`, metaobjects-ui) via
# TypeRegistry.extend (ui.json declares them on layout.dataGrid), matching the TS
# uiProvider split. Core registers every layout subtype with NO own attrs.
for _sub in LAYOUT_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_LAYOUT,
            sub_type=_sub,
            factory=MetaLayout,
            attrs=[],
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# validator.* — base + required/length/regex/numeric/array. Subtype + attr
# vocabulary is cross-port identical (mirrors TS VALIDATOR_ATTRS_MAP). @min/@max
# are shared by base/length/numeric/array; regex adds @pattern. Codegen reads these
# children to emit each port's input-validation constraints (SP-C validator parity).
_VALIDATOR_MIN_MAX_ATTRS = [
    AttrSchema(name=vc.VALIDATOR_ATTR_MIN, value_type=ATTR_SUBTYPE_INT),
    AttrSchema(name=vc.VALIDATOR_ATTR_MAX, value_type=ATTR_SUBTYPE_INT),
]
_VALIDATOR_ATTRS_BY_SUBTYPE: dict[str, list[AttrSchema]] = {
    SUBTYPE_BASE: list(_VALIDATOR_MIN_MAX_ATTRS),
    vc.VALIDATOR_SUBTYPE_REQUIRED: [],
    vc.VALIDATOR_SUBTYPE_LENGTH: list(_VALIDATOR_MIN_MAX_ATTRS),
    vc.VALIDATOR_SUBTYPE_REGEX: [
        *_VALIDATOR_MIN_MAX_ATTRS,
        AttrSchema(name=vc.VALIDATOR_ATTR_PATTERN, value_type=ATTR_SUBTYPE_STRING),
    ],
    vc.VALIDATOR_SUBTYPE_NUMERIC: list(_VALIDATOR_MIN_MAX_ATTRS),
    vc.VALIDATOR_SUBTYPE_ARRAY: list(_VALIDATOR_MIN_MAX_ATTRS),
    # Cross-field validators — entity-scoped, reference sibling fields by name.
    vc.VALIDATOR_SUBTYPE_COMPARISON: [
        AttrSchema(name=vc.VALIDATOR_ATTR_LEFT, value_type=ATTR_SUBTYPE_STRING, required=True),
        AttrSchema(name=vc.VALIDATOR_ATTR_OP, value_type=ATTR_SUBTYPE_STRING, required=True,
                   allowed_values=("gt", "gte", "lt", "lte", "ne", "eq")),
        AttrSchema(name=vc.VALIDATOR_ATTR_RIGHT, value_type=ATTR_SUBTYPE_STRING, required=True),
    ],
    vc.VALIDATOR_SUBTYPE_REQUIRED_WHEN: [
        AttrSchema(name=vc.VALIDATOR_ATTR_FIELD, value_type=ATTR_SUBTYPE_STRING, required=True),
        AttrSchema(name=vc.VALIDATOR_ATTR_WHEN, value_type=ATTR_SUBTYPE_STRING, required=True),
        AttrSchema(name=vc.VALIDATOR_ATTR_EQUALS, value_type=ATTR_SUBTYPE_STRING, required=True),
    ],
    vc.VALIDATOR_SUBTYPE_PRESENT_IFF: [
        AttrSchema(name=vc.VALIDATOR_ATTR_FIELD, value_type=ATTR_SUBTYPE_STRING, required=True),
        AttrSchema(name=vc.VALIDATOR_ATTR_WHEN, value_type=ATTR_SUBTYPE_STRING, required=True),
        AttrSchema(name=vc.VALIDATOR_ATTR_EQUALS, value_type=ATTR_SUBTYPE_STRING, required=True),
    ],
    vc.VALIDATOR_SUBTYPE_AT_LEAST_ONE: [
        AttrSchema(name=vc.VALIDATOR_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
    ],
}
for _sub, _attrs in _VALIDATOR_ATTRS_BY_SUBTYPE.items():
    core_provider.add(
        TypeDefinition(
            type=TYPE_VALIDATOR,
            sub_type=_sub,
            factory=lambda t, s, n: MetaData(t, s, n),
            attrs=list(_attrs),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# template.* (FR-004) — base + prompt + output + toolcall. FR-033 — core registers
# the four template TYPES (a single MetaTemplate backs every subtype; validation in
# validation_passes.py) but carries NO own per-subtype attrs. The full per-subtype
# template attr vocabulary (@payloadRef / @textRef / @format / @maxChars / @kind /
# @promptStyle / @toolName / @responseRef / …) is re-homed to the prompt domain
# provider (`prompt_provider`, metaobjects-prompt) via TypeRegistry.extend
# (prompt.json declares them on template.prompt / output / toolcall), matching the TS
# core-types→promptProvider split (where the template type is also attr-free in core).
for _tmpl_sub in (
    SUBTYPE_BASE,
    tc.TEMPLATE_SUBTYPE_OUTPUT,
    tc.TEMPLATE_SUBTYPE_PROMPT,
    tc.TEMPLATE_SUBTYPE_TOOLCALL,
):
    core_provider.add(
        TypeDefinition(
            type=TYPE_TEMPLATE,
            sub_type=_tmpl_sub,
            factory=MetaTemplate,
            attrs=[],
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )


# ---------------------------------------------------------------------------
# The canonical default provider set (cross-port `coreProviders`).
#
# Mirrors TS's `coreProviders = [coreTypesProvider, dbProvider, docProvider,
# promptProvider, uiProvider]` and C#'s DefaultRegistry composition. The core types
# are registered first; the DB-domain (`db_provider`), prompt / AI + serialization
# domain (`prompt_provider`) and UI / query-surface domain (`ui_provider`) then
# EXTEND the core types via TypeRegistry.extend, and the documentation provider adds
# the common doc attrs. FR-033 re-homed the field's filter/sort/teaching/extract +
# view/layout + template attrs out of core into ui/prompt; the composed set is
# unchanged. Spread to add more: `[*core_providers, my_provider]`.
# ---------------------------------------------------------------------------
from .meta.persistence.db.db_provider import db_provider  # noqa: E402
from .meta.template.prompt_provider import prompt_provider  # noqa: E402
from .meta.presentation.ui.ui_provider import ui_provider  # noqa: E402
from .documentation.doc_provider import doc_provider  # noqa: E402

core_providers: list[Provider] = [
    core_provider,
    db_provider,
    doc_provider,
    prompt_provider,
    ui_provider,
]

# #265 — the ids of the LIBRARY providers above, as a frozen set. Consulted by
# spec_metamodel._apply_strict_attr_scoping (via TypeRegistry.attr_origin) to
# decide whether an attr's provenance is "library" (still prunable against the
# strict per-subtype allow-list) or a consumer's own provider (never pruned).
LIBRARY_PROVIDER_IDS: frozenset[str] = frozenset(p.id for p in core_providers)
