"""reporting_provider -- the reporting pack (cross-port ``metaobjects-reporting``).

FR-044: ``dimension.*``, ``measure.*``, ``segment.filter`` and ``object.report``, plus
the rules that admit them on types core owns (an entity holds dimension / measure /
segment children) and the ``@segment`` attr on ``origin.aggregate`` / ``origin.first``;
those ride in ``reporting.json`` ``extends`` and are applied below. It is its OWN
provider so a project can leave it out; it is in the default bundle
(``core_providers``), so every existing model loads unchanged. ``object.report`` folds
``object.base`` (``extends_base``) from the core provider's registration. Mirrors the TS
``reportingProvider``.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from ....shared.base_types import (
    TYPE_ATTR,
    TYPE_DIMENSION,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_MEASURE,
    TYPE_OBJECT,
    TYPE_SEGMENT,
    TYPE_SOURCE,
)
from ...provider_extends import register_extends
from ..attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_EXPRESSION,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_STRING,
)
from ..object.meta_object import MetaObject
from ..object.object_constants import (
    OBJECT_REPORT_ATTR_DIMENSIONS,
    OBJECT_REPORT_ATTR_FILTER,
    OBJECT_REPORT_ATTR_FROM,
    OBJECT_REPORT_ATTR_MEASURES,
    OBJECT_REPORT_ATTR_SEGMENT,
    OBJECT_REPORT_ATTR_SPINE,
    OBJECT_SUBTYPE_REPORT,
)
from .meta_dimension import MetaDimension
from .meta_measure import MetaMeasure
from .meta_segment import MetaSegment
from .reporting_constants import (
    DIMENSION_SUBTYPE_ATTRIBUTE,
    DIMENSION_SUBTYPE_TIME,
    MEASURE_AGGS,
    MEASURE_SUBTYPE_AGGREGATE,
    MEASURE_SUBTYPE_DERIVED,
    MEASURE_SUBTYPE_RATIO,
    REPORTING_ATTR_AGG,
    REPORTING_ATTR_DEFAULT,
    REPORTING_ATTR_DENOMINATOR,
    REPORTING_ATTR_DISTINCT,
    REPORTING_ATTR_EXPR,
    REPORTING_ATTR_FILTER,
    REPORTING_ATTR_GRAINS,
    REPORTING_ATTR_NUMERATOR,
    REPORTING_ATTR_OF,
    REPORTING_ATTR_SEGMENT,
    REPORTING_ATTR_VIA,
    SEGMENT_SUBTYPE_FILTER,
    TIME_GRAINS,
)

reporting_provider = Provider("metaobjects-reporting", dependencies=("metaobjects-core-types",))

# FR-044 -- object.report: declared dimensions x measures of ONE entity (@from),
# compiled to a read-only view. Its fields and identity are DERIVED (the loader
# refuses declared ones, R4), so it carries the projection's child set (no
# relationship / template). reporting.json's report block (extends_base) is the
# strict graph the spec pass re-derives onto this def; it declares ONLY the report
# attrs, so the shared discriminator attrs folded from object.base are pruned
# exactly as on projection.
reporting_provider.add(
    TypeDefinition(
        type=TYPE_OBJECT,
        sub_type=OBJECT_SUBTYPE_REPORT,
        factory=MetaObject,
        extends_base=True,
        child_rules=[
            ChildRule(TYPE_FIELD, "*"),
            ChildRule(TYPE_IDENTITY, "*"),
            ChildRule(TYPE_ATTR, "*"),
            ChildRule(TYPE_SOURCE, "*"),
            ChildRule(TYPE_LAYOUT, "*"),
        ],
        attrs=[
            AttrSchema(name=OBJECT_REPORT_ATTR_FROM, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(
                name=OBJECT_REPORT_ATTR_DIMENSIONS,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                is_array=True,
            ),
            AttrSchema(
                name=OBJECT_REPORT_ATTR_MEASURES,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                is_array=True,
            ),
            AttrSchema(name=OBJECT_REPORT_ATTR_SEGMENT, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=OBJECT_REPORT_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER, required=False),
            # R8: the to-one path from @from whose entity supplies the report's rows.
            AttrSchema(name=OBJECT_REPORT_ATTR_SPINE, value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
    )
)

# One vocabulary, one block: a report names dimensions and measures, and both may
# reference a segment. Attr scoping is per-subtype exactly as
# spec/metamodel/reporting.json declares it.
_DIMENSION_COMMON_ATTRS = [
    AttrSchema(name=REPORTING_ATTR_OF, value_type=ATTR_SUBTYPE_STRING, required=True),
    AttrSchema(name=REPORTING_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
]
reporting_provider.add(
    TypeDefinition(
        type=TYPE_DIMENSION,
        sub_type=DIMENSION_SUBTYPE_ATTRIBUTE,
        factory=MetaDimension,
        attrs=list(_DIMENSION_COMMON_ATTRS),
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
reporting_provider.add(
    TypeDefinition(
        type=TYPE_DIMENSION,
        sub_type=DIMENSION_SUBTYPE_TIME,
        factory=MetaDimension,
        attrs=[
            *_DIMENSION_COMMON_ATTRS,
            # Weeks start Monday (ISO-8601) in every lowering; 'hour' is refused on
            # a field.date by the loader (D4), not by the closed set.
            AttrSchema(
                name=REPORTING_ATTR_GRAINS,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                is_array=True,
                allowed_values=TIME_GRAINS,
            ),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
reporting_provider.add(
    TypeDefinition(
        type=TYPE_MEASURE,
        sub_type=MEASURE_SUBTYPE_AGGREGATE,
        factory=MetaMeasure,
        attrs=[
            AttrSchema(
                name=REPORTING_ATTR_AGG,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                allowed_values=MEASURE_AGGS,
            ),
            # isArray: a bare string coerces to a one-element list (the tuple form
            # is a distinct count, M2). Optional (M0): only @agg any/all may omit
            # it, to quantify their @filter/@segment over the rows instead of
            # aggregating a column.
            AttrSchema(
                name=REPORTING_ATTR_OF,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                is_array=True,
            ),
            AttrSchema(name=REPORTING_ATTR_DISTINCT, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
            AttrSchema(name=REPORTING_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER, required=False),
            AttrSchema(name=REPORTING_ATTR_SEGMENT, value_type=ATTR_SUBTYPE_STRING, required=False),
            # What the measure reads when it would otherwise be null; M7/M8 decide where it is legal.
            AttrSchema(name=REPORTING_ATTR_DEFAULT, value_type=ATTR_SUBTYPE_INT, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
reporting_provider.add(
    TypeDefinition(
        type=TYPE_MEASURE,
        sub_type=MEASURE_SUBTYPE_RATIO,
        factory=MetaMeasure,
        attrs=[
            AttrSchema(name=REPORTING_ATTR_NUMERATOR, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=REPORTING_ATTR_DENOMINATOR, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=REPORTING_ATTR_DEFAULT, value_type=ATTR_SUBTYPE_INT, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
# FR-044 R13: measure.derived — FR-037 R5's first arithmetic wave; no @default.
reporting_provider.add(
    TypeDefinition(
        type=TYPE_MEASURE,
        sub_type=MEASURE_SUBTYPE_DERIVED,
        factory=MetaMeasure,
        attrs=[
            AttrSchema(name=REPORTING_ATTR_EXPR, value_type=ATTR_SUBTYPE_EXPRESSION, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
reporting_provider.add(
    TypeDefinition(
        type=TYPE_SEGMENT,
        sub_type=SEGMENT_SUBTYPE_FILTER,
        factory=MetaSegment,
        attrs=[
            AttrSchema(name=REPORTING_ATTR_FILTER, value_type=ATTR_SUBTYPE_FILTER, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)


def _register(registry: TypeRegistry) -> None:
    register_extends(registry, "reporting.json")


reporting_provider.on_register(_register)
