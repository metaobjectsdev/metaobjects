"""FR-015 — ``source.rdb`` ``@parameterRef`` typed-input rules.

Codes:
    * ``ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND`` — ``@parameterRef`` set with a
      non-callable ``@kind`` (only ``storedProc`` / ``tableFunction`` accept
      parameters). Checked before resolution so authoring mistakes surface first.
    * ``ERR_PARAMETER_REF_UNRESOLVED`` — ``@parameterRef`` names a non-existent
      object.
    * ``ERR_PARAMETER_REF_NOT_VALUE_OBJECT`` — ``@parameterRef`` points at an
      object that is not an ``object.value``.
    * ``ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH`` — a parameter field uses
      ``origin.passthrough @from: "Entity.field"`` but its subtype does not match
      the referenced field's subtype.

Mirrors the TS reference
``packages/metadata/src/persistence/source/validate-source-parameter-ref.ts``.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source.source_constants import (
    SOURCE_ATTR_PARAMETER_REF,
    SOURCE_KIND_STORED_PROC,
    SOURCE_KIND_TABLE_FUNCTION,
    SOURCE_SUBTYPE_RDB,
)
from ..meta.core.object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_VALUE,
)
from ..meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_FROM,
    ORIGIN_SUBTYPE_PASSTHROUGH,
)
from ..shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_ORIGIN, TYPE_SOURCE
from ..shared.separators import PACKAGE_SEP

_CALLABLE_KINDS = frozenset({SOURCE_KIND_STORED_PROC, SOURCE_KIND_TABLE_FUNCTION})


def validate_source_parameter_ref(root: MetaData, errors: list[MetaError]) -> None:
    # Pre-index every object by name AND fqn so resolution costs O(1) per source.
    object_index: dict[str, MetaData] = {}
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        object_index[obj.name] = obj
        fqn = (
            f"{obj.package}{PACKAGE_SEP}{obj.name}"
            if obj.package
            else obj.name
        )
        object_index[fqn] = obj

    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        for source in obj.own_children():
            if source.type != TYPE_SOURCE or source.sub_type != SOURCE_SUBTYPE_RDB:
                continue
            if not isinstance(source, MetaSource):
                continue
            ref = source.attr(SOURCE_ATTR_PARAMETER_REF)
            if not isinstance(ref, str) or ref == "":
                continue

            # ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND — before resolution.
            if source.effective_kind() not in _CALLABLE_KINDS:
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" has @parameterRef but '
                        f'@kind is "{source.effective_kind()}"; only "storedProc" '
                        'or "tableFunction" accept parameters',
                        ErrorCode.ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,
                        envelope=source.source,
                    )
                )
                continue

            target = object_index.get(ref)
            if target is None:
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" @parameterRef = "{ref}" '
                        "does not resolve to any known object",
                        ErrorCode.ERR_PARAMETER_REF_UNRESOLVED,
                        envelope=source.source,
                    )
                )
                continue

            if target.sub_type != OBJECT_SUBTYPE_VALUE:
                reason = (
                    "an object.entity (entities have identity; parameter shapes "
                    "are value-objects)"
                    if target.sub_type == OBJECT_SUBTYPE_ENTITY
                    else f"an object.{target.sub_type}"
                )
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" @parameterRef = "{ref}" '
                        f"resolves to {reason}; use an object.value",
                        ErrorCode.ERR_PARAMETER_REF_NOT_VALUE_OBJECT,
                        envelope=source.source,
                    )
                )
                continue

            # ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH — each parameter field
            # with origin.passthrough must match the referenced field's subtype.
            for param_field in target.own_children():
                if param_field.type != TYPE_FIELD:
                    continue
                passthrough = next(
                    (
                        c
                        for c in param_field.own_children()
                        if c.type == TYPE_ORIGIN
                        and c.sub_type == ORIGIN_SUBTYPE_PASSTHROUGH
                    ),
                    None,
                )
                if passthrough is None:
                    continue
                frm = passthrough.attr(ORIGIN_ATTR_FROM)
                if not isinstance(frm, str) or frm == "":
                    continue
                dot = frm.find(".")
                if dot < 0:
                    continue
                target_entity_name = frm[:dot]
                target_field_name = frm[dot + 1:]
                target_entity = object_index.get(target_entity_name)
                if target_entity is None:
                    continue  # origin-paths pass surfaces this
                target_field = next(
                    (
                        c
                        for c in target_entity.own_children()
                        if c.type == TYPE_FIELD and c.name == target_field_name
                    ),
                    None,
                )
                if target_field is None:
                    continue
                if param_field.sub_type != target_field.sub_type:
                    errors.append(
                        MetaError(
                            f'parameter field "{param_field.name}" '
                            f"(field.{param_field.sub_type}) on @parameterRef "
                            f'"{ref}" uses origin.passthrough @from: "{frm}", but '
                            f"{target_entity.name}.{target_field_name} is "
                            f"field.{target_field.sub_type}; types must match",
                            ErrorCode.ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH,
                            envelope=param_field.source,
                        )
                    )
