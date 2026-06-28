import pytest

from metaobjects.codegen.template_codegen.template_spec import (
    parse_template_spec,
    template_spec_to_generators,
)
from metaobjects.render.verify import InMemoryProvider

VALID = {
    "generators": [
        {"name": "svc", "template": "service/entity", "scope": "perEntity",
         "outputPattern": "{name}.service.py"},
        {"name": "reg", "template": "app/registry", "scope": "perModel",
         "outputPattern": "registry.py", "format": "text"},
    ]
}


def test_accepts_valid_spec() -> None:
    spec = parse_template_spec(VALID)
    assert len(spec["generators"]) == 2
    assert spec["generators"][0]["scope"] == "perEntity"
    assert spec["generators"][1]["format"] == "text"


def test_rejects_unknown_scope() -> None:
    with pytest.raises(ValueError, match="scope"):
        parse_template_spec({"generators": [
            {"name": "x", "template": "t", "scope": "perThing", "outputPattern": "x"}]})


def test_rejects_missing_required_field() -> None:
    with pytest.raises(ValueError, match="outputPattern"):
        parse_template_spec({"generators": [
            {"name": "x", "template": "t", "scope": "perModel"}]})


def test_rejects_bad_format() -> None:
    with pytest.raises(ValueError, match="format"):
        parse_template_spec({"generators": [
            {"name": "x", "template": "t", "scope": "perModel",
             "outputPattern": "x", "format": "xml-typo"}]})


def test_rejects_non_dict() -> None:
    with pytest.raises(ValueError):
        parse_template_spec(None)


def test_to_generators_names() -> None:
    provider = InMemoryProvider({"service/entity": "", "app/registry": ""})
    gens = template_spec_to_generators(parse_template_spec(VALID), provider)
    assert [g.name for g in gens] == ["svc", "reg"]
