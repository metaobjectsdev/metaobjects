"""FR-015 — ``source.rdb`` ``@parameterRef`` typed-input rules.

Codes:
    * ``ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND`` — ``@parameterRef`` set with a
      non-callable ``@kind`` (only ``storedProc`` / ``tableFunction`` accept
      parameters). Checked before resolution so authoring mistakes surface first.
    * ``ERR_PARAMETER_REF_UNRESOLVED`` — ``@parameterRef`` names a non-existent
      object.
    * ``ERR_PARAMETER_REF_NOT_VALUE_OBJECT`` — ``@parameterRef`` points at an
      object that is not an ``object.value``.

Note (#185): the parameter-field passthrough type-match check formerly emitted
here (``ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH``) is RETIRED. It is subsumed
by the universal ``ERR_PASSTHROUGH_TYPE_MISMATCH`` in ``validation_passes.py``,
whose origin-paths pass runs over every object — value hosts (parameter shapes)
included — so a parameter field's ``origin.passthrough`` type mismatch is now
caught there (with the ``@convert: true`` opt-out).

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
from ..naming_refs import resolve_object_ref
from ..shared.base_types import TYPE_OBJECT, TYPE_SOURCE

_CALLABLE_KINDS = frozenset({SOURCE_KIND_STORED_PROC, SOURCE_KIND_TABLE_FUNCTION})


def validate_source_parameter_ref(root: MetaData, errors: list[MetaError]) -> None:
    # ADR-0039 (mirrors the TS validate-source-parameter-ref): resolving is the
    # default. Root has no super, so children()==own_children() here, but the
    # inheritable reads below RESOLVE — @parameterRef on the source, the parameter
    # value-object's fields, and the referenced entity's field can all be inherited
    # via extends. The SOURCE iteration stays own (a source is validated on the
    # entity that declares it), as does origin.* (never inherits; ADR-0029).
    for obj in root.children():
        if obj.type != TYPE_OBJECT:
            continue
        # ADR-0042 — a bare @parameterRef resolves package-local (this object's
        # package, else root-level); an FQN resolves exactly. Shares the single
        # resolve_object_ref matcher — NO bare-name-anywhere fallback (which would
        # silently bind a same-named value-object in another package).
        referrer_pkg = obj.package or obj.file_default_package or ""
        for source in obj.own_children():
            if source.type != TYPE_SOURCE or source.sub_type != SOURCE_SUBTYPE_RDB:
                continue
            if not isinstance(source, MetaSource):
                continue
            # ADR-0039: resolving — a source may inherit @parameterRef via extends
            # (mirrors the TS `source.attr`, which resolves —
            # validate-source-parameter-ref.ts:76).
            ref = source.get_meta_attr(SOURCE_ATTR_PARAMETER_REF)
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

            target = resolve_object_ref(root, ref, referrer_pkg)
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

            # #185 — the parameter-field passthrough type-match check formerly here
            # (ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH) is RETIRED; the universal
            # ERR_PASSTHROUGH_TYPE_MISMATCH in validation_passes.py now covers it
            # (its origin-paths pass runs over every object, value hosts included).
