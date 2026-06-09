"""Cross-port enum conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/enum/input``) and asserts
that the entity's enum fields are emitted as Pydantic ``Literal[...]`` member sets:
an INLINE enum (``status``) carries its own ``@values``, and a field that
``extends`` the abstract ``Priority`` enum (``priority``) inherits its members.
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


def test_extended_abstract_enum_inherits_member_set() -> None:
    src = render_entity_model(_by_name()["Ticket"])
    # `priority extends Priority` inherits LOW/MEDIUM/HIGH (the abstract-enum reuse path).
    assert 'priority: Literal["LOW", "MEDIUM", "HIGH"]' in src
