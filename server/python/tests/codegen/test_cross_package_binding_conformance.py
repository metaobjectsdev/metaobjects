"""Cross-port conformance for Python codegen: codegen binds the target a reference names.

Loads the shared fixture (``fixtures/codegen-conformance/cross-package-binding/input``) and
checks ``expected-bindings.json`` (ADR-0059 Decision 7): every ``identity.reference`` binds the
object its canonical value names, every relationship binds the same object in the M:N and
to-one resolution the generated router and model code use, and nothing binds by short name or
by the package of the entity that inherits an attribute.
"""
import json
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.router_generator import RouterGenerator, reverse_fks_for
from metaobjects.codegen.runtime.m2m_codegen import build_object_index, resolve_m2m_descriptors
from metaobjects.meta.core.identity.identity_constants import IDENTITY_REFERENCE_ATTR_REFERENCES
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.relationship.derive_m2m_fields import derive_m2m_fields
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.meta.core.relationship.relationship_constants import (
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_THROUGH,
)
from metaobjects.meta.core.relationship.relationship_references import (
    reference_fields,
    resolve_relationship_reference,
)
from metaobjects.naming_refs import ref_target
from metaobjects.source_resolution import resolve_table_name

_FIXTURE = Path(__file__).resolve().parents[4] / "fixtures/codegen-conformance/cross-package-binding"
_EXPECTED = json.loads((_FIXTURE / "expected-bindings.json").read_text(encoding="utf-8"))

_ROOT = MetaDataLoader.from_directory(_FIXTURE / "input").root
_ENTITIES = [o for o in _ROOT.children() if isinstance(o, MetaObject)]
_INDEX = build_object_index(_ENTITIES)


def _split(path: str) -> tuple[MetaObject, str]:
    key, member = path.rsplit(".", 1)
    return _INDEX[key], member


def _member(entity: MetaObject, member: str):
    return next(c for c in entity.children() if c.name == member)


@pytest.mark.parametrize("path", sorted(_EXPECTED["references"]))
def test_identity_reference_binds_the_expected_object(path: str) -> None:
    entity, name = _split(path)
    bound = ref_target(_member(entity, name), IDENTITY_REFERENCE_ATTR_REFERENCES)
    assert bound is not None
    assert bound.resolution_key() == _EXPECTED["references"][path]


_RELATIONS = sorted(_EXPECTED["relations"])


@pytest.mark.parametrize("path", _RELATIONS)
def test_relationship_resolution_used_by_codegen(path: str) -> None:
    want = _EXPECTED["relations"][path]
    entity, name = _split(path)
    rel = _member(entity, name)
    assert isinstance(rel, MetaRelationship)
    target = ref_target(rel, RELATIONSHIP_ATTR_OBJECT_REF)
    assert target is not None and target.resolution_key() == want["target"]
    assert resolve_table_name(target) == want["targetTable"]

    if want["cardinality"] == "many":
        junction = ref_target(rel, RELATIONSHIP_ATTR_THROUGH)
        assert junction is not None and junction.resolution_key() == want["junction"]
        assert resolve_table_name(junction) == want["junctionTable"]
        fields = derive_m2m_fields(rel, entity, _INDEX)
        assert fields.source_field == want["sourceJoinField"]
        assert fields.target_field == want["targetJoinField"]
        descriptor = next(d for d in resolve_m2m_descriptors(entity, _INDEX) if d.relation_name == name)
        assert descriptor.target_entity == target.name
        assert descriptor.target_table == want["targetTable"]
        assert descriptor.junction_table == want["junctionTable"]
    else:
        reference = resolve_relationship_reference(entity, name, target)
        assert reference is not None
        assert reference_fields(reference)[0] == want["fkField"]
        assert any(
            rfk.fk_field == want["fkField"] and rfk.target_entity == target.name
            for rfk in reverse_fks_for(entity)
        )


@pytest.mark.parametrize("key", ["a::Post", "acme::Order"])
def test_generated_router_traverses_the_expected_relations(key: str) -> None:
    entity = _INDEX[key]
    source = RouterGenerator().render_router(entity, _INDEX)
    assert source is not None
    expected = [p for p in _RELATIONS if p.startswith(key + ".") and _EXPECTED["relations"][p]["cardinality"] == "many"]
    assert expected
    for path in expected:
        relation = path.rsplit(".", 1)[1]
        assert f"def find_related_{relation}(" in source
        assert f"/{relation}" in source
    expected_tables = {_EXPECTED["relations"][p]["targetTable"] for p in expected}
    descriptors = resolve_m2m_descriptors(entity, _INDEX)
    assert {d.target_table for d in descriptors} == expected_tables
    for wrong in ("a_tags", "acme_labels", "acme_customers"):
        assert wrong not in {d.target_table for d in descriptors}
        assert wrong not in source
