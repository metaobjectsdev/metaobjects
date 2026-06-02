from metaobjects.core_types import core_provider
from metaobjects.provider import compose_registry


def test_core_provider_registers_phase1_types() -> None:
    reg = compose_registry([core_provider])
    for type_, sub in [
        ("metadata", "root"),
        ("object", "entity"),
        ("field", "long"),
        ("field", "string"),
        ("field", "int"),
        ("field", "boolean"),
        ("identity", "primary"),
    ]:
        assert reg.find(type_, sub) is not None, f"missing {type_}.{sub}"


def test_core_provider_designates_default_sub_types_for_bare_keys() -> None:
    # The default-subType designations that let a bare ``metadata:`` / ``object:``
    # YAML key desugar to ``metadata.root`` / ``object.entity``. Regression guard
    # for the bootstrap path that, when broken, leaves these unset and makes a
    # bare ``metadata:`` root fail with "type 'metadata' has no default subType".
    reg = compose_registry([core_provider])
    assert reg.default_sub_type_of("metadata") == "root"
    assert reg.default_sub_type_of("object") == "entity"
    # A type with no designated default returns None (not an arbitrary subType).
    assert reg.default_sub_type_of("field") is None


def test_identity_primary_declares_fields_as_stringarray_required() -> None:
    reg = compose_registry([core_provider])
    schema = reg.attr_schema("identity", "primary", "fields")
    assert schema is not None
    assert schema.value_type == "stringarray"
    assert schema.required is True
