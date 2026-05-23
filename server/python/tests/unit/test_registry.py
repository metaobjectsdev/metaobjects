from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry


def test_register_and_find() -> None:
    reg = TypeRegistry()
    base = TypeDefinition(
        type="field",
        sub_type="base",
        factory=lambda t, s, n: ("field", s, n),
        attrs=[AttrSchema(name="required", value_type="boolean")],
        child_rules=[ChildRule(child_type="attr", child_sub_type="*")],
    )
    reg.register(base)
    found = reg.find("field", "base")
    assert found is base
    assert reg.find("field", "missing") is None


def test_attrs_of_returns_declared_attrs() -> None:
    reg = TypeRegistry()
    reg.register(
        TypeDefinition(
            type="field",
            sub_type="string",
            factory=lambda t, s, n: None,
            attrs=[
                AttrSchema(name="required", value_type="boolean"),
                AttrSchema(name="maxLength", value_type="int"),
            ],
        )
    )
    names = {a.name for a in reg.attrs_of("field", "string")}
    assert names == {"required", "maxLength"}
    assert reg.attrs_of("field", "unregistered") == []
