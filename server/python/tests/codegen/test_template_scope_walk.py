from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.render.verify import InMemoryProvider

CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "template-codegen-conformance"


def _ctx() -> GenContext:
    root = MetaDataLoader.from_directory(str(CORPUS / "metadata")).root
    objs = [c for c in root.children() if isinstance(c, MetaObject)]
    return GenContext(
        entities=objs, loaded_root=root, matches=lambda e: True,
        config=None, warn=lambda m: None,
    )


def test_scope_per_entity_emits_one_per_concrete_entity() -> None:
    provider = InMemoryProvider({"t": "name={{name}} pkg={{package}}\n"})
    gen = template_generator(
        name="ent", template="t", scope="perEntity",
        output_pattern="{name}.txt", provider=provider,
    )
    files = gen.generate(_ctx())
    assert {f.path for f in files} == {"Product.txt", "Order.txt"}
    assert files[0].content.startswith("name=")


def test_both_walk_and_scope_raises() -> None:
    provider = InMemoryProvider({"t": ""})
    with pytest.raises(ValueError, match="exactly one"):
        template_generator(
            name="bad", template="t", scope="perEntity",
            output_pattern="{name}.txt", walk=lambda r: [], provider=provider,
        )


def test_neither_walk_nor_scope_raises() -> None:
    provider = InMemoryProvider({"t": ""})
    with pytest.raises(ValueError, match="exactly one"):
        template_generator(name="bad2", template="t", provider=provider)


def test_scope_without_output_pattern_raises() -> None:
    provider = InMemoryProvider({"t": ""})
    with pytest.raises(ValueError, match="output_pattern"):
        template_generator(name="bad3", template="t", scope="perModel", provider=provider)
