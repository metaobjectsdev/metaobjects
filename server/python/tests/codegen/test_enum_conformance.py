"""Cross-port enum conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/enum/input``) and asserts that an
INLINE enum (``status``) is emitted as a Pydantic ``Literal[...]`` member set carrying its own
``@values``, while a field that ``extends`` the package-level abstract ``Priority`` enum
(``priority``) is materialized ONCE as a module-level ``class Priority(str, Enum)`` (FR-019,
ADR-0026) and merely REFERENCED (imported from the shared ``enums`` module), not inlined.
"""
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generators.entity_model import render_entity_model


_FIXTURE_DIR = Path(__file__).resolve().parents[4] / "fixtures/codegen-conformance/enum/input"


def _by_name() -> dict[str, MetaObject]:
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    return {
        o.name.split("::")[-1]: o
        for o in root.own_children()
        if isinstance(o, MetaObject)
    }


def test_inline_enum_field_is_literal_member_set() -> None:
    src = render_entity_model(_by_name()["Ticket"])
    # `status` declares its own @values; required → no `| None`.
    assert 'status: Literal["OPEN", "PENDING", "CLOSED"]' in src


def test_extended_abstract_enum_is_materialized_and_referenced() -> None:
    # FR-019: `priority extends Priority` (a package-level abstract enum) is typed as the
    # materialized `Priority` class, imported from the shared `enums` module — NOT inlined.
    src = render_entity_model(_by_name()["Ticket"])
    assert "priority: Priority" in src
    assert "from .enums import Priority" in src
    assert 'priority: Literal["LOW", "MEDIUM", "HIGH"]' not in src
