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


def test_identity_primary_declares_fields_as_stringarray_required() -> None:
    reg = compose_registry([core_provider])
    schema = reg.attr_schema("identity", "primary", "fields")
    assert schema is not None
    assert schema.value_type == "stringArray"
    assert schema.required is True
