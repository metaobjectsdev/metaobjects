"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .attr_class_map import attr_class_for
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_PROPERTIES,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
    ATTR_SUBTYPES,
)
from .meta.core.field import field_constants as fc
from .meta.core.validator import validator_constants as vc
from .meta.core.field.field_constants import (
    AUTO_SET_VALUES,
    FIELD_ATTR_AUTO_SET,
    FIELD_ATTR_COERCE_DEFAULT,
    FIELD_ATTR_COLUMN,
    FIELD_ATTR_CURRENCY,
    FIELD_ATTR_DEFAULT,
    FIELD_ATTR_ENUM_ALIAS,
    FIELD_ATTR_ENUM_DOC,
    FIELD_ATTR_EXAMPLE,
    FIELD_ATTR_FILTERABLE,
    FIELD_ATTR_INSTRUCTION,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_NORMALIZE,
    FIELD_ATTR_OBJECT_REF,
    FIELD_ATTR_PRECISION,
    FIELD_ATTR_READ_ONLY,
    FIELD_ATTR_REQUIRED,
    FIELD_ATTR_SCALE,
    FIELD_ATTR_SORTABLE,
    FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
    FIELD_ATTR_STORAGE,
    FIELD_ATTR_UNIQUE,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
    NORMALIZE_DEFAULT,
    NORMALIZE_MODES,
    SORT_ORDER_VALUES,
    STORAGE_VALUES,
)
from .meta.core.field.meta_field import MetaField
from .meta.persistence.db.db_constants import (
    FIELD_ATTR_DB_COLUMN_TYPE,
    FIELD_ATTR_DB_INDEXED,
)
from .meta.core.identity.identity_constants import (
    GENERATION_VALUES,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_ATTR_UNIQUE,
    IDENTITY_REFERENCE_ATTR_ENFORCE,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_PRIMARY,
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_SUBTYPE_SECONDARY,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_VALUE,
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
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COLLECTION,
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
    SOURCE_ATTR_TABLE,
    SOURCE_ATTR_VIEW,
    SOURCE_RDB_KINDS,
    SOURCE_ROLES,
    SOURCE_SUBTYPE_RDB,
)
from .meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_COLUMNS,
    LAYOUT_ATTR_DEFAULT_SORT_FIELD,
    LAYOUT_ATTR_DEFAULT_SORT_ORDER,
    LAYOUT_ATTR_FILTER,
    LAYOUT_ATTR_FILTERABLE,
    LAYOUT_ATTR_PAGE_SIZE,
    LAYOUT_SUBTYPES,
    LAYOUT_SUBTYPE_DATA_GRID,
)
from .meta.presentation.layout.meta_layout import MetaLayout
from .meta.presentation.view.meta_view import MetaView
from .meta.presentation.view.view_constants import (
    VIEW_ATTR_LOCALE,
    VIEW_SUBTYPE_CURRENCY,
    VIEW_SUBTYPES,
)
from .provider import Provider
from .registry import AttrSchema, ChildRule, NodeFactory, TypeDefinition, TypeRegistry
from .shared.base_types import (
    SUBTYPE_BASE,
    SUBTYPE_ROOT,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
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
            )
        )


# metadata.root — accepts top-level objects, root-level fields (shared abstracts),
# and template.* (FR-004).
core_provider.add(
    TypeDefinition(
        type=TYPE_METADATA,
        sub_type=SUBTYPE_ROOT,
        factory=MetaRoot,
        child_rules=[
            ChildRule(TYPE_OBJECT, "*"),
            ChildRule(TYPE_FIELD, "*"),
            ChildRule(TYPE_TEMPLATE, "*"),
        ],
    )
)

# object.* (entity, value)
_OBJECT_CHILD_RULES = [
    ChildRule(TYPE_FIELD, "*"),
    ChildRule(TYPE_IDENTITY, "*"),
    ChildRule(TYPE_ATTR, "*"),
    ChildRule(TYPE_SOURCE, "*"),
    ChildRule(TYPE_RELATIONSHIP, "*"),
    ChildRule(TYPE_LAYOUT, "*"),
    # template.* under object.entity — a declared prompt/output lives WITH its
    # entity (AI LLM-call trace persistence; the trace entity carries a nested
    # template.prompt). Mirrors Java MetaObject.optionalChild("template","*","*").
    ChildRule(TYPE_TEMPLATE, "*"),
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
# value-object — registered on object.value ONLY (not entity/base). Closed enum
# (none|collapse|strip, default strip); resolved at codegen time when a field
# omits its own @normalize.
_OBJECT_VALUE_ATTRS = list(_OBJECT_COMMON_ATTRS) + [
    AttrSchema(
        name=FIELD_ATTR_NORMALIZE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=NORMALIZE_MODES,
        default=NORMALIZE_DEFAULT,
    ),
]
for _obj_sub in OBJECT_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_OBJECT,
            sub_type=_obj_sub,
            factory=MetaObject,
            child_rules=list(_OBJECT_CHILD_RULES),
            attrs=(
                list(_OBJECT_VALUE_ATTRS)
                if _obj_sub == OBJECT_SUBTYPE_VALUE
                else list(_OBJECT_COMMON_ATTRS)
            ),
        )
    )

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
    AttrSchema(name=FIELD_ATTR_FILTERABLE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    AttrSchema(name=FIELD_ATTR_SORTABLE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
    AttrSchema(
        name=FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=SORT_ORDER_VALUES,
    ),
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
    # FR-010 field-teaching attrs (any field): free-text shown in the generated
    # output-format prompt fragment. Never carried in comments.
    AttrSchema(name=FIELD_ATTR_EXAMPLE, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=FIELD_ATTR_INSTRUCTION, value_type=ATTR_SUBTYPE_STRING, required=False),
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
            # FR-010: properties-shaped maps, field.enum only.
            # @enumAlias: off-vocabulary token -> canonical member (extract alias-fold).
            # @enumDoc:   member -> human-readable description (guide prompt fragment).
            AttrSchema(
                name=FIELD_ATTR_ENUM_ALIAS,
                value_type=ATTR_SUBTYPE_PROPERTIES,
                required=False,
            ),
            AttrSchema(
                name=FIELD_ATTR_ENUM_DOC,
                value_type=ATTR_SUBTYPE_PROPERTIES,
                required=False,
            ),
            # FR-011: present-but-uncoercible extract fallback member. Membership
            # against the effective @values is validated post-load in
            # validation_passes (ERR_BAD_ATTR_VALUE), mirroring the @values pass.
            AttrSchema(
                name=FIELD_ATTR_COERCE_DEFAULT,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
            ),
            # FR-011: per-field ASCII normalization mode for tolerant enum extract.
            # Closed enum (none|collapse|strip); allowed_values gates it →
            # ERR_BAD_ATTR_VALUE. The default ("strip") is resolved at codegen time
            # (field → owning object.value → "strip").
            AttrSchema(
                name=FIELD_ATTR_NORMALIZE,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=NORMALIZE_MODES,
                default=NORMALIZE_DEFAULT,
            ),
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
    )
)

# identity.secondary — @fields required stringArray; @unique optional boolean
# (true → UNIQUE index, false → plain index). Cross-port; mirrors TS secondaryIdentityAttrs.
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_SECONDARY,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            AttrSchema(name=IDENTITY_ATTR_UNIQUE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
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

# origin.passthrough — @from required, @via optional
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_PASSTHROUGH,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_FROM, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.aggregate — @agg, @of, @via all required; @agg has allowed values
_AGG_ALLOWED = ("count", "sum", "avg", "min", "max")
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
            AttrSchema(name=ORIGIN_ATTR_OF, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=True),
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

# view.* (base + 13 control kinds). Only view.currency carries a documented attr
# (@locale); all other subtypes have none. Mirrors TS core-types view registration.
for _view_sub in VIEW_SUBTYPES:
    _view_attrs = (
        [AttrSchema(name=VIEW_ATTR_LOCALE, value_type=ATTR_SUBTYPE_STRING, required=False)]
        if _view_sub == VIEW_SUBTYPE_CURRENCY
        else []
    )
    core_provider.add(
        TypeDefinition(
            type=TYPE_VIEW,
            sub_type=_view_sub,
            factory=MetaView,
            attrs=_view_attrs,
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# layout.* (base, dataGrid); @columns is a stringArray — scalar desugars to array;
# @filter is a FilterAttr — shorthand values desugar to op-objects
_layout_datagrid_attrs = [
    AttrSchema(name=LAYOUT_ATTR_COLUMNS, value_type=ATTR_SUBTYPE_STRING, is_array=True),
    AttrSchema(name=LAYOUT_ATTR_DEFAULT_SORT_FIELD, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(
        name=LAYOUT_ATTR_DEFAULT_SORT_ORDER,
        value_type=ATTR_SUBTYPE_STRING,
        allowed_values=("asc", "desc"),
    ),
    AttrSchema(name=LAYOUT_ATTR_PAGE_SIZE, value_type=ATTR_SUBTYPE_INT),
    # @filterable — boolean; the generated grid exposes column-filtering UI. Cross-port.
    AttrSchema(name=LAYOUT_ATTR_FILTERABLE, value_type=ATTR_SUBTYPE_BOOLEAN),
    AttrSchema(name=LAYOUT_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER),
]
for _sub in LAYOUT_SUBTYPES:
    _attrs = list(_layout_datagrid_attrs) if _sub == LAYOUT_SUBTYPE_DATA_GRID else []
    core_provider.add(
        TypeDefinition(
            type=TYPE_LAYOUT,
            sub_type=_sub,
            factory=MetaLayout,
            attrs=_attrs,
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

# template.* (FR-004) — base + prompt + output + toolcall. @payloadRef / @textRef
# / @format / @maxChars / @owner / @since / @requiredTags are shared across prompt
# + output; prompt also carries @maxTokens / @requiredSlots / @model. toolcall
# (ADR-0011) does NOT inherit the shared attrs — it declares its own
# (@toolName required + @payloadRef required + @owner + @since). No @textRef
# requirement: a tool-call has no renderable text body.
# Validation in validation_passes.py.
_TEMPLATE_SHARED_ATTRS = [
    # @payloadRef is required on the concrete subtypes (output/prompt). The generic
    # required-attr schema check (validation_passes Check 1) enforces it — there is
    # no separate manual pass (matches TS). template.base gets NO shared attrs.
    AttrSchema(name=tc.TEMPLATE_ATTR_PAYLOAD_REF, value_type=ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(name=tc.TEMPLATE_ATTR_TEXT_REF, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(
        name=tc.TEMPLATE_ATTR_FORMAT,
        value_type=ATTR_SUBTYPE_STRING,
        allowed_values=tc.ALLOWED_FORMATS,
    ),
    AttrSchema(name=tc.TEMPLATE_ATTR_MAX_CHARS, value_type=ATTR_SUBTYPE_INT),
    AttrSchema(name=tc.TEMPLATE_ATTR_OWNER, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(name=tc.TEMPLATE_ATTR_SINCE, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(name=tc.TEMPLATE_ATTR_REQUIRED_TAGS, value_type=ATTR_SUBTYPE_STRING, is_array=True),
]
# template.output also carries the FR-010 @promptStyle presentation attr — a
# closed enum (allowed_values), default "guide". NOT on prompt/toolcall.
#
# It also carries @kind (closed enum document|email, default "document") + the
# email part-refs (@subjectRef / @htmlBodyRef / @textBodyRef). @kind closed-enum
# membership is enforced via allowed_values (ERR_BAD_ATTR_VALUE), exactly like
# @format / @promptStyle; the conditional ref requirements live in
# validation_passes._validate_templates. @textRef is left non-required here (it is
# conditionally required by kind), matching TS/Java. NOT on prompt/toolcall.
_TEMPLATE_OUTPUT_ATTRS = list(_TEMPLATE_SHARED_ATTRS) + [
    AttrSchema(
        name=tc.TEMPLATE_ATTR_PROMPT_STYLE,
        value_type=ATTR_SUBTYPE_STRING,
        allowed_values=tc.PROMPT_STYLES,
        default=tc.PROMPT_STYLE_DEFAULT,
    ),
    AttrSchema(
        name=tc.TEMPLATE_ATTR_KIND,
        value_type=ATTR_SUBTYPE_STRING,
        allowed_values=tc.ALLOWED_KINDS,
        default=tc.TEMPLATE_KIND_DEFAULT,
    ),
    AttrSchema(name=tc.TEMPLATE_ATTR_SUBJECT_REF, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(name=tc.TEMPLATE_ATTR_HTML_BODY_REF, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(name=tc.TEMPLATE_ATTR_TEXT_BODY_REF, value_type=ATTR_SUBTYPE_STRING),
]
_TEMPLATE_PROMPT_ATTRS = list(_TEMPLATE_SHARED_ATTRS) + [
    AttrSchema(name=tc.TEMPLATE_ATTR_MAX_TOKENS, value_type=ATTR_SUBTYPE_INT),
    AttrSchema(name=tc.TEMPLATE_ATTR_REQUIRED_SLOTS, value_type=ATTR_SUBTYPE_STRING, is_array=True),
    AttrSchema(name=tc.TEMPLATE_ATTR_MODEL, value_type=ATTR_SUBTYPE_STRING),
    # @responseRef — template.prompt ONLY (AI trace; peer of @payloadRef). Carved
    # out of the cross-port registry manifest (TS_PILOT_VOCAB) until promoted.
    AttrSchema(name=tc.TEMPLATE_ATTR_RESPONSE_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
]
_TEMPLATE_TOOLCALL_ATTRS = [
    AttrSchema(name=tc.TEMPLATE_ATTR_TOOL_NAME, value_type=ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(name=tc.TEMPLATE_ATTR_PAYLOAD_REF, value_type=ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(name=tc.TEMPLATE_ATTR_OWNER, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(name=tc.TEMPLATE_ATTR_SINCE, value_type=ATTR_SUBTYPE_STRING),
]
# template.base — abstract anchor; carries NO attrs (the shared attrs live only on
# the concrete subtypes prompt/output, matching TS TEMPLATE_ATTRS_MAP[base] = []).
core_provider.add(
    TypeDefinition(
        type=TYPE_TEMPLATE,
        sub_type=SUBTYPE_BASE,
        factory=MetaTemplate,
        attrs=[],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
core_provider.add(
    TypeDefinition(
        type=TYPE_TEMPLATE,
        sub_type=tc.TEMPLATE_SUBTYPE_OUTPUT,
        factory=MetaTemplate,
        attrs=list(_TEMPLATE_OUTPUT_ATTRS),
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
core_provider.add(
    TypeDefinition(
        type=TYPE_TEMPLATE,
        sub_type=tc.TEMPLATE_SUBTYPE_PROMPT,
        factory=MetaTemplate,
        attrs=list(_TEMPLATE_PROMPT_ATTRS),
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
core_provider.add(
    TypeDefinition(
        type=TYPE_TEMPLATE,
        sub_type=tc.TEMPLATE_SUBTYPE_TOOLCALL,
        factory=MetaTemplate,
        attrs=list(_TEMPLATE_TOOLCALL_ATTRS),
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)


# ---------------------------------------------------------------------------
# The canonical default provider set (cross-port `coreProviders`).
#
# Mirrors TS's `coreProviders = [coreTypesProvider, dbProvider, docProvider,
# templateProvider]` and C#'s DefaultRegistry composition. The core types are
# registered first; the DB-domain (`db_provider`) and template/output domain
# (`template_provider`) then EXTEND the core field types via TypeRegistry.extend,
# and the documentation provider adds the common doc attrs. Spread to add more:
# `[*core_providers, my_provider]`.
# ---------------------------------------------------------------------------
from .meta.persistence.db.db_provider import db_provider  # noqa: E402
from .meta.template.template_provider import template_provider  # noqa: E402
from .documentation.doc_provider import doc_provider  # noqa: E402

core_providers: list[Provider] = [
    core_provider,
    db_provider,
    doc_provider,
    template_provider,
]
