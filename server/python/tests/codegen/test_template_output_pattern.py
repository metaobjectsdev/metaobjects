import pytest

from metaobjects.codegen.template_codegen.output_pattern import expand_output_pattern


def test_name_and_package() -> None:
    assert (
        expand_output_pattern("{package}/{name}Service.py", "order", "acme::sales")
        == "acme/sales/orderService.py"
    )


def test_pascal_name() -> None:
    assert expand_output_pattern("{Name}.py", "order_line", None) == "OrderLine.py"


def test_literal_passthrough() -> None:
    assert expand_output_pattern("registry.py", None, None) == "registry.py"


def test_empty_package_collapses() -> None:
    assert expand_output_pattern("{package}/{name}.py", "x", "") == "x.py"


def test_unknown_placeholder_raises() -> None:
    with pytest.raises(ValueError, match="unknown placeholder"):
        expand_output_pattern("{bogus}.py", "x", "p")


def test_name_without_name_var_raises() -> None:
    with pytest.raises(ValueError, match="name"):
        expand_output_pattern("{name}.py", None, "p")
