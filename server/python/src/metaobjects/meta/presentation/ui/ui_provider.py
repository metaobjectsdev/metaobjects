"""ui_provider — the presentation + query-surface MetaDataTypeProvider
(cross-port ``metaobjects-ui``).

EXTENDS the core-registered types with the UI / query-surface markers that are
NOT core properties:
  - every field subtype: ``@filterable`` / ``@sortable`` / ``@sortableDefaultOrder``
    (Project D generated CRUD filter + sort allowlists);
  - ``view.currency``: ``@locale`` (BCP 47 currency display formatting);
  - ``layout.dataGrid``: ``@pageSize`` / ``@defaultSortField`` / ``@defaultSortOrder``
    / ``@filterable`` / ``@filter`` / ``@columns`` (Project B metadata-driven grid).

These were previously registered in ``core_types``; FR-033 re-homes them here to
match the TS provider split (``uiProvider``), the C# ``UiMetaDataProvider``, and
Java's UI concern provider. The attrs + their value-types / required-ness /
allowed-values / defaults are DATA — read from the embedded
``spec/metamodel/ui.json`` (single-sourced, never hand-copied) via
:func:`load_provider_extends`. The composed registry is UNCHANGED (the manifest is
provider-agnostic) — this only moves WHICH provider registers each attr.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import TypeRegistry
from ....shared.base_types import TYPE_FIELD
from ...core.field import field_constants as fc
from ...provider_extends import register_extends

# The ui.json ``extends`` directives apply to ``field.*`` (every field subtype),
# ``view.currency`` and ``layout.dataGrid``. The shared register_extends() expands
# a ``"*"`` field subtype to every concrete field subtype (the shared FIELD_SUBTYPES
# tuple — which excludes ``enum`` — PLUS ``field.enum``), mirroring db_provider /
# prompt_provider, so the UI markers reach every field including enum.
_FIELD_SUBTYPES: tuple[str, ...] = (*fc.FIELD_SUBTYPES, fc.FIELD_SUBTYPE_ENUM)

#: The embedded shared provider-definition file this provider sources its attrs from.
_UI_DEFINITION_FILE = "ui.json"


def _register(registry: TypeRegistry) -> None:
    register_extends(
        registry,
        _UI_DEFINITION_FILE,
        field_subtype_expansion={TYPE_FIELD: _FIELD_SUBTYPES},
    )


def _make_ui_provider() -> Provider:
    p = Provider("metaobjects-ui", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


ui_provider = _make_ui_provider()
