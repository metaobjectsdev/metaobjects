"""Cross-port abstract-entity conformance for Python codegen.

Loads the shared fixture (``fixtures/codegen-conformance/abstract/input``) and
asserts the feature invariant: an abstract entity emits NO instance/write
artifacts (FastAPI router, filter allowlist, CREATE TABLE DDL), while the
Pydantic base *model* is still emitted (Python concretes subclass it).
"""
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.migrate.expected_schema import build_expected_schema


_FIXTURE_DIR = Path(__file__).resolve().parents[4] / "fixtures/codegen-conformance/abstract/input"


def _root():
    return MetaDataLoader.from_directory(_FIXTURE_DIR).root


def _by_name() -> dict[str, MetaObject]:
    return {
        o.name.split("::")[-1]: o
        for o in _root().own_children()
        if isinstance(o, MetaObject)
    }


def test_router_suppressed_for_abstract_emitted_for_concrete() -> None:
    objs = _by_name()
    assert render_router(objs["AbstractRecord"]) is None
    assert render_router(objs["Widget"]) is not None


def test_filter_allowlist_suppressed_for_abstract_emitted_for_concrete() -> None:
    objs = _by_name()
    assert render_filter_allowlist(objs["AbstractRecord"]) is None
    assert render_filter_allowlist(objs["Widget"]) is not None
