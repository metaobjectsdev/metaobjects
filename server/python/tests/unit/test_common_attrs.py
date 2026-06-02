"""Unit tests for TypeRegistry.register_common_attrs and the documentation provider."""
from __future__ import annotations

import pytest

from metaobjects.core_types import core_provider
from metaobjects.documentation import (
    DOC_ATTR_ALIASES,
    DOC_ATTR_DESCRIPTION,
    DOC_ATTR_NAMES,
    DOC_ATTR_NOTES,
    DOC_ATTR_SEE_ALSO,
    DOC_ATTR_TITLE,
    common_doc_attrs,
    doc_provider,
)
from metaobjects.errors import ErrorCode
from metaobjects.loader.validation_passes import run_validations
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from metaobjects.meta.core.identity.identity_constants import IDENTITY_ATTR_FIELDS
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import AttrSchema, TypeRegistry
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_METADATA


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_registry_with_doc() -> TypeRegistry:
    return compose_registry([core_provider, doc_provider])


def _run(root: MetaData, registry: TypeRegistry | None = None) -> tuple[list, list[str]]:
    if registry is None:
        registry = _make_registry_with_doc()
    errors: list = []
    warnings: list[str] = []
    run_validations(root, registry, errors, warnings)
    return errors, warnings


def _root_with_child(child: MetaData) -> MetaData:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.add_child(child)
    return root


# ---------------------------------------------------------------------------
# Test 1: register_common_attrs makes attrs visible via get_common_attrs()
# ---------------------------------------------------------------------------


def test_register_common_attrs_visible() -> None:
    """register_common_attrs populates get_common_attrs()."""
    reg = TypeRegistry()
    attrs = [
        AttrSchema(name="description", value_type="string", required=False),
        AttrSchema(name="title",       value_type="string", required=False),
    ]
    reg.register_common_attrs(attrs)
    common = reg.get_common_attrs()
    names = {a.name for a in common}
    assert "description" in names
    assert "title" in names


def test_get_common_attrs_returns_defensive_copy() -> None:
    """Mutating the returned list must not affect the registry."""
    reg = TypeRegistry()
    reg.register_common_attrs([AttrSchema(name="description", value_type="string")])
    copy = reg.get_common_attrs()
    copy.clear()
    assert len(reg.get_common_attrs()) == 1


# ---------------------------------------------------------------------------
# Test 2: first-wins deduplication
# ---------------------------------------------------------------------------


def test_register_common_attrs_first_wins_dedupe() -> None:
    """Registering the same attr name twice keeps only the first."""
    reg = TypeRegistry()
    first  = AttrSchema(name="description", value_type="string",  required=False)
    second = AttrSchema(name="description", value_type="boolean", required=True)
    reg.register_common_attrs([first])
    reg.register_common_attrs([second])
    common = reg.get_common_attrs()
    descs = [a for a in common if a.name == "description"]
    assert len(descs) == 1
    assert descs[0].value_type == "string"   # first registration wins
    assert descs[0].required is False


# ---------------------------------------------------------------------------
# Test 3: attr_schema falls back to common attrs
# ---------------------------------------------------------------------------


def test_attr_schema_fallback_to_common() -> None:
    """attr_schema returns a common attr when not found in per-type attrs."""
    reg = TypeRegistry()
    common_attr = AttrSchema(name="description", value_type="string")
    reg.register_common_attrs([common_attr])
    # field.string is not registered; any unknown type/subtype should still return
    # the common attr via the fallback.
    result = reg.attr_schema("object", "entity", "description")
    assert result is not None
    assert result.name == "description"


def test_attr_schema_per_type_beats_common() -> None:
    """Per-type attr takes precedence over a common attr with the same name."""
    from metaobjects.registry import TypeDefinition

    reg = TypeRegistry()
    per_type = AttrSchema(name="description", value_type="int")
    reg.register(TypeDefinition(
        type="field", sub_type="string",
        factory=lambda t, s, n: None,
        attrs=[per_type],
    ))
    reg.register_common_attrs([AttrSchema(name="description", value_type="string")])
    result = reg.attr_schema("field", "string", "description")
    assert result is not None
    assert result.value_type == "int"   # per-type wins


# ---------------------------------------------------------------------------
# Test 4: conflict detection emits ERR_PROVIDER_ATTR_CONFLICT
# ---------------------------------------------------------------------------


def test_conflict_emits_err_provider_attr_conflict() -> None:
    """Per-type attr collision with a common attr emits ERR_PROVIDER_ATTR_CONFLICT."""
    from metaobjects.registry import TypeDefinition
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity
    from metaobjects.shared.base_types import TYPE_IDENTITY

    # Build a registry where identity.primary has a per-type "description" attr
    # that conflicts with the common "description" attr.
    conflict_provider_a = core_provider  # has identity.primary with @fields
    # We need a custom registry with the collision baked in.
    reg = TypeRegistry()
    reg.register(TypeDefinition(
        type=TYPE_IDENTITY, sub_type="primary",
        factory=lambda t, s, n: MetaIdentity(t, s, n),
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True),
            AttrSchema(name="description", value_type="string"),  # name collision!
        ],
    ))
    reg.register_common_attrs([AttrSchema(name="description", value_type="string")])

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    root = _root_with_child(ident)

    errors, _ = _run(root, registry=reg)
    codes = [e.code for e in errors]
    assert ErrorCode.ERR_PROVIDER_ATTR_CONFLICT in codes


def test_conflict_reported_once_per_type_subtype() -> None:
    """ERR_PROVIDER_ATTR_CONFLICT fires at most once per (type, sub_type)."""
    from metaobjects.registry import TypeDefinition
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity
    from metaobjects.shared.base_types import TYPE_IDENTITY

    reg = TypeRegistry()
    reg.register(TypeDefinition(
        type=TYPE_IDENTITY, sub_type="primary",
        factory=lambda t, s, n: MetaIdentity(t, s, n),
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True),
            AttrSchema(name="description", value_type="string"),
        ],
    ))
    reg.register_common_attrs([AttrSchema(name="description", value_type="string")])

    # Two nodes of the same type — conflict should be reported only once.
    ident_a = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident_a.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    ident_b = MetaIdentity(TYPE_IDENTITY, "primary", "pk2")
    ident_b.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.add_child(ident_a)
    root.add_child(ident_b)

    errors, _ = _run(root, registry=reg)
    conflict_count = sum(1 for e in errors if e.code == ErrorCode.ERR_PROVIDER_ATTR_CONFLICT)
    assert conflict_count == 1, f"Expected exactly 1 conflict error, got {conflict_count}"


# ---------------------------------------------------------------------------
# Test 5: doc provider constants match cross-language vocabulary
# ---------------------------------------------------------------------------


def test_doc_attr_names_tuple() -> None:
    """DOC_ATTR_NAMES contains the 7 expected cross-language constant values."""
    assert DOC_ATTR_DESCRIPTION == "description"
    assert DOC_ATTR_TITLE       == "title"
    assert DOC_ATTR_NOTES       == "notes"
    assert "deprecated"  in DOC_ATTR_NAMES
    assert "replacedBy"  in DOC_ATTR_NAMES
    assert "seeAlso"     in DOC_ATTR_NAMES
    assert "aliases"     in DOC_ATTR_NAMES
    assert len(DOC_ATTR_NAMES) == 7


def test_common_doc_attrs_schema() -> None:
    """common_doc_attrs has 7 entries; seeAlso and aliases are string arrays.

    Array attrs are now `string` + the orthogonal is_array flag (the retired
    `stringarray` subtype), matching Java's StringAttribute + @isArray.
    """
    assert len(common_doc_attrs) == 7
    by_name = {a.name: a for a in common_doc_attrs}
    assert by_name[DOC_ATTR_SEE_ALSO].value_type  == ATTR_SUBTYPE_STRING
    assert by_name[DOC_ATTR_SEE_ALSO].is_array is True
    assert by_name[DOC_ATTR_ALIASES].value_type   == ATTR_SUBTYPE_STRING
    assert by_name[DOC_ATTR_ALIASES].is_array is True
    assert by_name[DOC_ATTR_DESCRIPTION].value_type == ATTR_SUBTYPE_STRING
    for a in common_doc_attrs:
        assert a.required is False


# ---------------------------------------------------------------------------
# Test 6: doc provider composition — common attrs visible after compose_registry
# ---------------------------------------------------------------------------


def test_doc_provider_registers_common_attrs() -> None:
    """compose_registry([core_provider, doc_provider]) gives a registry with all 7 doc attrs."""
    reg = _make_registry_with_doc()
    names = {a.name for a in reg.get_common_attrs()}
    for name in DOC_ATTR_NAMES:
        assert name in names, f"Expected common attr '{name}' not registered"


# ---------------------------------------------------------------------------
# Test 7: stringArray desugar via common attrs (scalar -> list)
# ---------------------------------------------------------------------------


def test_stringarray_desugar_via_common_attr() -> None:
    """A string scalar for a stringArray common attr is desugared to a single-element list."""
    from metaobjects import MetaDataLoader
    import json
    import tempfile
    import os

    fixture = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Product",
                        "@aliases": "SingleAlias",   # scalar, should desugar to ["SingleAlias"]
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"identity.primary": {"@fields": ["id"]}},
                        ],
                    }
                }
            ],
        }
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "meta.acme.json")
        with open(path, "w") as f:
            json.dump(fixture, f)
        result = MetaDataLoader.from_directory(tmpdir, providers=[core_provider, doc_provider])

    assert not result.errors, f"Unexpected errors: {result.errors}"

    # Navigate to the entity and check the desugared @aliases value
    entity = next(
        (c for c in result.root.own_children() if c.name == "Product"),
        None,
    )
    assert entity is not None
    aliases = entity.attr(DOC_ATTR_ALIASES)
    assert aliases == ["SingleAlias"], f"Expected ['SingleAlias'], got {aliases!r}"


# ---------------------------------------------------------------------------
# Test 8: doc attrs accepted on every metatype without validation errors
# ---------------------------------------------------------------------------


def test_doc_attrs_accepted_on_identity_node() -> None:
    """A @description attr on identity.primary must not produce any validation errors."""
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity
    from metaobjects.shared.base_types import TYPE_IDENTITY

    reg = _make_registry_with_doc()
    ident = MetaIdentity(TYPE_IDENTITY, "primary", "pk")
    ident.set_attr(IDENTITY_ATTR_FIELDS, ["id"], ATTR_SUBTYPE_STRINGARRAY)
    ident.set_attr(DOC_ATTR_DESCRIPTION, "The primary key.", ATTR_SUBTYPE_STRING)
    root = _root_with_child(ident)

    errors, _ = _run(root, registry=reg)
    assert not errors, f"Unexpected errors: {errors}"
