"""FR-016 / ADR-0018 — per-kind physical-name aliases on source.rdb.

Each ``source.rdb`` may declare at most one of
``@table`` / ``@view`` / ``@materializedView`` / ``@proc`` / ``@function``. The
chosen alias must match the source's ``@kind``, with one pre-1.0 legacy
exception: ``@table`` is also accepted for non-table kinds (e.g.
``@kind: "storedProc"`` + ``@table: "fn_x"``), which emits a
``WARN_LEGACY_PHYSICAL_NAME_ALIAS``.

Codes emitted by this pass:
    * ``ERR_BAD_ATTR_VALUE``           — any kind-aware alias set to ``""``.
    * ``ERR_PHYSICAL_NAME_MULTIPLE``   — two or more kind-aware aliases on one source.
    * ``ERR_PHYSICAL_NAME_KIND_MISMATCH`` — alias other than ``@table`` set with
      a non-matching ``@kind``.
    * ``WARN_LEGACY_PHYSICAL_NAME_ALIAS`` — ``@table`` set with a non-table
      ``@kind`` (legacy spelling). Loader accepts.

Mirrors the TS reference
``packages/metadata/src/persistence/source/validate-source-physical-names.ts``.
"""
from __future__ import annotations

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.persistence.source.meta_source import MetaSource
from ..meta.persistence.source.source_constants import (
    ALL_PHYSICAL_NAME_ALIASES,
    PHYSICAL_NAME_ATTR_BY_KIND,
    SOURCE_ATTR_TABLE,
    SOURCE_SUBTYPE_RDB,
)
from ..shared.base_types import TYPE_OBJECT, TYPE_SOURCE
from ..source.error_source import (
    LoaderWarning,
    WARN_LEGACY_PHYSICAL_NAME_ALIAS,
)


def _kind_for_alias(alias: str) -> str:
    for kind, attr in PHYSICAL_NAME_ATTR_BY_KIND.items():
        if attr == alias:
            return kind
    return "(unknown)"


def validate_source_physical_names(
    root: MetaData,
    errors: list[MetaError],
    envelope_warnings: list[LoaderWarning] | None = None,
    legacy_warnings: list[str] | None = None,
) -> None:
    """Run the FR-016 / ADR-0018 per-kind physical-name validation.

    ``envelope_warnings`` collects the FR5c-style envelope warnings (today only
    ``WARN_LEGACY_PHYSICAL_NAME_ALIAS``). ``legacy_warnings`` mirrors the
    cross-port string warnings channel — populated with the same code string
    so the legacy ``warnings: list[str]`` consumers see something too.
    """
    for obj in root.own_children():
        if obj.type != TYPE_OBJECT:
            continue
        for source in obj.own_children():
            if source.type != TYPE_SOURCE:
                continue
            if source.sub_type != SOURCE_SUBTYPE_RDB:
                continue
            if not isinstance(source, MetaSource):
                continue

            # Empty-string check first — explicit "" is meaningless and an
            # authoring error regardless of which alias was used. Run before
            # the multi/mismatch checks so an empty value can't slip through.
            for attr in ALL_PHYSICAL_NAME_ALIASES:
                v = source.attr(attr)
                if isinstance(v, str) and v == "":
                    errors.append(
                        MetaError(
                            f'source.rdb on object "{obj.name}" sets @{attr} '
                            "to an empty string; physical name attrs require a "
                            "non-empty value",
                            ErrorCode.ERR_BAD_ATTR_VALUE,
                            envelope=source.source,
                        )
                    )

            set_aliases = [
                a for a in ALL_PHYSICAL_NAME_ALIASES
                if isinstance(source.attr(a), str) and source.attr(a)
            ]

            if len(set_aliases) > 1:
                joined = ", ".join(f"@{a}" for a in set_aliases)
                errors.append(
                    MetaError(
                        f'source.rdb on object "{obj.name}" declares multiple '
                        f"physical-name aliases ({joined}); set exactly one",
                        ErrorCode.ERR_PHYSICAL_NAME_MULTIPLE,
                        envelope=source.source,
                    )
                )
                continue

            if not set_aliases:
                continue

            chosen = set_aliases[0]
            expected = PHYSICAL_NAME_ATTR_BY_KIND.get(source.effective_kind())

            if chosen == expected:
                continue

            # Legacy: @table is permitted for non-table kinds with a warning.
            if chosen == SOURCE_ATTR_TABLE:
                msg = (
                    f'source.rdb on object "{obj.name}" uses @table with '
                    f'@kind: "{source.effective_kind()}"; prefer the '
                    f"kind-matching alias @{expected} (ADR-0018)"
                )
                if envelope_warnings is not None:
                    envelope_warnings.append(
                        LoaderWarning(
                            code=WARN_LEGACY_PHYSICAL_NAME_ALIAS,
                            message=msg,
                            source=source.source,
                        )
                    )
                if legacy_warnings is not None:
                    legacy_warnings.append(WARN_LEGACY_PHYSICAL_NAME_ALIAS)
                continue

            # Any other mismatch is a hard error.
            errors.append(
                MetaError(
                    f'source.rdb on object "{obj.name}" uses @{chosen} with '
                    f'@kind: "{source.effective_kind()}"; @{chosen} is only '
                    f'valid for @kind: "{_kind_for_alias(chosen)}"',
                    ErrorCode.ERR_PHYSICAL_NAME_KIND_MISMATCH,
                    envelope=source.source,
                )
            )
