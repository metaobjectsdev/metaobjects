"""ADR-0039 codegen gate — a concrete field/entity that ``extends`` an abstract
parent must inherit its effective properties through Python codegen.

Reuses the shared cross-port conformance fixture
(``fixtures/conformance/extends-abstract-field-inheritance``) whose ``Contact``
entity extends an abstract ``BaseEntity`` and whose ``tags`` / ``balance`` /
``addresses`` fields extend abstract ``field.string`` (isArray + @maxLength),
``field.decimal`` (@precision/@scale) and ``field.object`` (@objectRef + @storage +
isArray) declarations.

Pre-fix (own-only reads) the array-ness / @objectRef inherited from the abstract
parents was silently dropped, so ``tags``/``addresses`` generated as scalars and the
runtime write coercer mis-typed arrays. This test pins that every inherited effective
property is honored.
"""
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.entity_model import EntityModelGenerator


_FIXTURE_DIR = (
    Path(__file__).resolve().parents[4]
    / "fixtures/conformance/extends-abstract-field-inheritance/input"
)


def _emit() -> dict[str, str]:
    root = MetaDataLoader.from_directory(_FIXTURE_DIR).root
    entities = [o for o in root.own_children() if isinstance(o, MetaObject)]
    ctx = GenContext(
        entities=entities,
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir=""),
        warn=lambda _m: None,
    )
    return {f.path: f.content for f in EntityModelGenerator().generate(ctx)}


def test_concrete_field_inherits_isarray_from_abstract_string() -> None:
    """``tags extends acme::Tags`` (abstract field.string isArray:true) → ``list[str]``."""
    contact = _emit()["Contact.py"]
    assert "tags: list[str]" in contact, (
        "tags must inherit isArray:true from the abstract Tags field -> list[str]"
    )


def test_concrete_field_inherits_isarray_and_objectref_from_abstract_object() -> None:
    """``addresses extends acme::AddressBag`` (abstract field.object isArray:true +
    @objectRef acme::Address) → ``list[Address]`` (both the array-ness AND the object
    target are inherited)."""
    files = _emit()
    contact = files["Contact.py"]
    assert "addresses: list[Address]" in contact, (
        "addresses must inherit isArray:true + @objectRef -> list[Address]"
    )
    assert "from .Address import Address" in contact, (
        "the inherited @objectRef target must be imported"
    )
    # The referenced value-object model is emitted from its own declaration.
    assert "Address.py" in files


def test_concrete_field_inherits_decimal_from_abstract() -> None:
    """``balance extends acme::Money`` (abstract field.decimal) → Decimal, NOT array."""
    contact = _emit()["Contact.py"]
    assert "balance: Decimal" in contact
    assert "balance: list" not in contact


def test_entity_inherits_fields_via_base_entity_subclass_emit() -> None:
    """``Contact extends acme::BaseEntity`` — the generated model subclasses the
    generated ``BaseEntity`` and (sanctioned own_fields subclass-emit) does NOT
    re-declare the inherited ``id`` / ``createdAt``; they come from the base class."""
    contact = _emit()["Contact.py"]
    # Subclass-emit: extends the generated base, imports it.
    assert "class Contact(BaseEntity):" in contact
    assert "from .BaseEntity import BaseEntity" in contact
    # Inherited PK/timestamp are NOT re-emitted on the MAIN subclass (own_fields only);
    # the flat FR-036 ContactPatch restates them, so scope the check to the create model.
    main = contact.split("class ContactPatch")[0]
    assert "\n    id:" not in main
    assert "createdAt" not in main
    # But the entity's own field IS present.
    assert "name:" in contact


def test_base_entity_model_carries_inherited_members() -> None:
    """The generated ``BaseEntity`` model declares id (uuid) + createdAt (timestamp)
    so the subclass inherits them."""
    base = _emit()["BaseEntity.py"]
    assert "id:" in base
    assert "createdAt:" in base
