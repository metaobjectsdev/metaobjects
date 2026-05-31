"""Runtime object-model conformance runner (Python port).

Drives the shared corpus at ``fixtures/object-model-conformance/`` (repo root)
through the Python runtime object model: ``MetaObject.new_instance()``,
``ValueObject``, ``MetaField.get_value`` / ``set_value``, and
``ObjectClassRegistry`` binding. The 7 scenarios in the corpus README are the
behavioral contract — assertions are behavioral (type-kind, back-ref identity,
field values, list contents, overflow), not byte-identity.

Mirrors the Java ``ObjectModelConformanceTest`` and the TS
``object-model-conformance.test.ts`` runners. The corpus dir is resolved by
walking up to the repo root (same as the sibling recover-conformance runner).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from metaobjects import (
    ObjectClassRegistry,
    ValueObject,
    load_directory,
)
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject

PERSON_FQN = "com::example::om::Person"


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "object-model-conformance"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError(
        "fixtures/object-model-conformance not found walking up from tests/"
    )


_CORPUS = _find_corpus()


def _objects(root: object) -> list[MetaObject]:
    return [c for c in root.children() if isinstance(c, MetaObject)]  # type: ignore[attr-defined]


def _find_object(root: object, name: str) -> MetaObject:
    obj = next((o for o in _objects(root) if o.name == name), None)
    if obj is None:
        raise RuntimeError(f"corpus missing object {name!r}")
    return obj


@pytest.fixture(scope="module")
def model() -> tuple[MetaObject, MetaObject, MetaObject]:
    result = load_directory(_CORPUS)
    assert result.errors == [], f"corpus load errors: {result.errors}"
    person = _find_object(result.root, "Person")
    address = _find_object(result.root, "Address")
    tag = _find_object(result.root, "Tag")
    return person, address, tag


def _resolve_object_ref(field: MetaField, objects: list[MetaObject]) -> MetaObject:
    """Resolve a field's nested ``@objectRef`` target via the package-folded key."""
    ref = field.object_ref
    assert ref is not None, f"field {field.name} has no @objectRef"
    target = next((o for o in objects if o.resolution_key() == ref), None)
    assert target is not None, f"no object found for @objectRef {ref}"
    return target


# 1. instantiate-value -------------------------------------------------------
def test_scenario_1_instantiate_value(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, _, _ = model
    inst = person.new_instance()
    assert isinstance(inst, ValueObject)
    assert inst.get_meta_data() is person


# 2. scalar-round-trip -------------------------------------------------------
def test_scenario_2_scalar_round_trip(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, _, _ = model
    inst = person.new_instance()
    name_field = person.get_meta_field("name")
    age_field = person.get_meta_field("age")
    assert name_field is not None and age_field is not None

    name_field.set_value(inst, "Ada")
    age_field.set_value(inst, 36)

    assert name_field.get_value(inst) == "Ada"
    age = age_field.get_value(inst)
    assert age == 36
    assert isinstance(age, int)


# 3. nested-object -----------------------------------------------------------
def test_scenario_3_nested_object(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, address, _ = model
    objects = [person, address]

    person_inst = person.new_instance()
    home_field = person.get_meta_field("home")
    assert home_field is not None

    address_mo = _resolve_object_ref(home_field, objects)
    assert address_mo is address

    address_inst = address_mo.new_instance()
    address.get_meta_field("street").set_value(address_inst, "1 Main")  # type: ignore[union-attr]
    address.get_meta_field("city").set_value(address_inst, "Anytown")  # type: ignore[union-attr]

    home_field.set_value(person_inst, address_inst)

    got_home = home_field.get_value(person_inst)
    assert isinstance(got_home, ValueObject)
    assert address.get_meta_field("street").get_value(got_home) == "1 Main"  # type: ignore[union-attr]
    assert address.get_meta_field("city").get_value(got_home) == "Anytown"  # type: ignore[union-attr]
    assert got_home.get_meta_data() is address


# 4. array-of-objects --------------------------------------------------------
def test_scenario_4_array_of_objects(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, _, tag = model
    objects = [person, tag]

    person_inst = person.new_instance()
    tags_field = person.get_meta_field("tags")
    assert tags_field is not None
    assert tags_field.is_array is True

    tag_mo = _resolve_object_ref(tags_field, objects)
    assert tag_mo is tag

    tag_a = tag_mo.new_instance()
    tag.get_meta_field("label").set_value(tag_a, "a")  # type: ignore[union-attr]
    tag_b = tag_mo.new_instance()
    tag.get_meta_field("label").set_value(tag_b, "b")  # type: ignore[union-attr]

    tags_field.set_value(person_inst, [tag_a, tag_b])

    got_tags = tags_field.get_value(person_inst)
    assert isinstance(got_tags, list)
    assert len(got_tags) == 2
    assert tag.get_meta_field("label").get_value(got_tags[0]) == "a"  # type: ignore[union-attr]
    assert tag.get_meta_field("label").get_value(got_tags[1]) == "b"  # type: ignore[union-attr]
    assert got_tags[0].get_meta_data() is tag
    assert got_tags[1].get_meta_data() is tag


# 5. overflow ----------------------------------------------------------------
def test_scenario_5_overflow(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, _, _ = model
    inst = person.new_instance()
    assert isinstance(inst, ValueObject)
    inst.set("nickname", "Countess")
    assert inst.get("nickname") == "Countess"


# 6. bound-type --------------------------------------------------------------
def test_scenario_6_bound_type(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    person, address, tag = model
    objects = [person, address, tag]

    # A port-local "aware" backing type. Generated code would self-register a
    # factory like this at import time.
    class PersonObj:
        def __init__(self, mo: Optional[MetaObject] = None) -> None:
            self.name: Optional[str] = None
            self.age: Optional[int] = None
            self.home: object = None
            self.tags: object = None
            self._mo: Optional[MetaObject] = mo

        def get_meta_data(self) -> Optional[MetaObject]:
            return self._mo

        def set_meta_data(self, mo: MetaObject) -> None:
            self._mo = mo

    registry = ObjectClassRegistry()
    registry.register(PERSON_FQN, lambda mo: PersonObj(mo))

    inst = person.new_instance(registry)
    assert isinstance(inst, PersonObj)
    assert inst.get_meta_data() is person

    # scalar — set_value/get_value go through getattr/setattr for native types
    person.get_meta_field("name").set_value(inst, "Ada")  # type: ignore[union-attr]
    person.get_meta_field("age").set_value(inst, 36)  # type: ignore[union-attr]
    assert person.get_meta_field("name").get_value(inst) == "Ada"  # type: ignore[union-attr]
    assert person.get_meta_field("age").get_value(inst) == 36  # type: ignore[union-attr]
    assert inst.name == "Ada"
    assert inst.age == 36

    # nested (Address falls back to ValueObject — nothing registered for it)
    home_field = person.get_meta_field("home")
    assert home_field is not None
    address_inst = _resolve_object_ref(home_field, objects).new_instance(registry)
    assert isinstance(address_inst, ValueObject)
    address.get_meta_field("street").set_value(address_inst, "1 Main")  # type: ignore[union-attr]
    home_field.set_value(inst, address_inst)
    got_home = home_field.get_value(inst)
    assert isinstance(got_home, ValueObject)
    assert address.get_meta_field("street").get_value(got_home) == "1 Main"  # type: ignore[union-attr]

    # array
    tags_field = person.get_meta_field("tags")
    assert tags_field is not None
    tag_mo = _resolve_object_ref(tags_field, objects)
    tag_a = tag_mo.new_instance(registry)
    tag.get_meta_field("label").set_value(tag_a, "a")  # type: ignore[union-attr]
    tags_field.set_value(inst, [tag_a])
    got_tags = tags_field.get_value(inst)
    assert isinstance(got_tags, list)
    assert len(got_tags) == 1
    assert tag.get_meta_field("label").get_value(got_tags[0]) == "a"  # type: ignore[union-attr]

    # does not leak into the default registry
    assert isinstance(person.new_instance(), ValueObject)


# 7. no-binding-fallback -----------------------------------------------------
def test_scenario_7_no_binding_fallback(
    model: tuple[MetaObject, MetaObject, MetaObject],
) -> None:
    _, address, _ = model
    empty = ObjectClassRegistry()
    assert isinstance(address.new_instance(empty), ValueObject)
    assert isinstance(address.new_instance(), ValueObject)
