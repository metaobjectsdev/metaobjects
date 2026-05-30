import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects.codegen.instance_artifacts import is_abstract, emits_instance_artifacts
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _entity(name: str, *, abstract: bool) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.is_abstract = abstract
    return o


def test_is_abstract_true_for_abstract_entity() -> None:
    assert is_abstract(_entity("AbstractRecord", abstract=True)) is True


def test_is_abstract_false_for_concrete_entity() -> None:
    assert is_abstract(_entity("Widget", abstract=False)) is False


def test_emits_instance_artifacts_false_for_abstract() -> None:
    assert emits_instance_artifacts(_entity("AbstractRecord", abstract=True)) is False


def test_emits_instance_artifacts_true_for_concrete() -> None:
    assert emits_instance_artifacts(_entity("Widget", abstract=False)) is True
