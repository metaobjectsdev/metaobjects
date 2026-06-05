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
    # register() stores a per-registry COPY of the definition (so a later provider's
    # extend() mutates the registry's list, not the provider's shared singleton) — so
    # the stored def is an equal-but-distinct object, not the same instance.
    assert found is not None
    assert found.type == base.type and found.sub_type == base.sub_type
    assert found.factory is base.factory  # the factory is shared (type identity)
    assert [a.name for a in found.attrs] == [a.name for a in base.attrs]
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
