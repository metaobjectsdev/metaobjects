# Coverage for the Python template_generator() factory — mirrors
# server/typescript/packages/codegen-ts/test/generators/template-generator.test.ts.

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.render import escapers
from metaobjects.render.verify import InMemoryProvider
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.shared.base_types import TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD, SUBTYPE_ROOT
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY


def _build_root() -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    post = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Post")
    post.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_LONG, "id"))
    post.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "title"))
    root.add_child(post)
    return root


def _make_ctx(root: MetaRoot) -> GenContext:
    return GenContext(
        entities=[c for c in root.children() if isinstance(c, MetaObject)],
        loaded_root=root,
        matches=lambda e: True,
        config=GenConfig(out_dir="/tmp"),
        warn=lambda m: None,
    )


def test_per_entity_walk_emits_one_file_per_entity():
    provider = InMemoryProvider({"custom/hello": "Hello {{name}}!\n"})
    root = _build_root()
    gen = template_generator(
        name="hello",
        template="custom/hello",
        provider=provider,
        walk=lambda r: [
            {"data": {"name": e.name}, "output_path": f"{e.name}.txt"}
            for e in r.children()
            if isinstance(e, MetaObject)
        ],
    )
    files = gen.generate(_make_ctx(root))
    assert len(files) == 1
    assert files[0].path == "Post.txt"
    assert files[0].content == "Hello Post!\n"


def test_aggregator_walk_emits_single_file_from_all_entities():
    provider = InMemoryProvider({
        "custom/index": "Entities:\n{{#entities}}- {{name}}\n{{/entities}}",
    })
    root = _build_root()
    comment = MetaObject(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Comment")
    comment.add_child(MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_LONG, "id"))
    root.add_child(comment)

    gen = template_generator(
        name="index",
        template="custom/index",
        provider=provider,
        walk=lambda r: [{
            "data": {
                "entities": [
                    {"name": e.name}
                    for e in r.children()
                    if isinstance(e, MetaObject)
                ]
            },
            "output_path": "index.txt",
        }],
    )
    files = gen.generate(_make_ctx(root))
    assert len(files) == 1
    assert files[0].path == "index.txt"
    assert files[0].content == "Entities:\n- Post\n- Comment\n"


def test_format_text_does_not_escape_html():
    provider = InMemoryProvider({"custom/raw": "{{snippet}}\n"})
    root = _build_root()
    gen = template_generator(
        name="raw-text",
        template="custom/raw",
        provider=provider,
        format=escapers.FORMAT_TEXT,
        walk=lambda r: [{
            "data": {"snippet": "<p>hi</p>"},
            "output_path": "out.txt",
        }],
    )
    files = gen.generate(_make_ctx(root))
    assert files[0].content == "<p>hi</p>\n"


def test_format_html_escapes_html_in_payload():
    provider = InMemoryProvider({"custom/raw": "{{snippet}}\n"})
    root = _build_root()
    gen = template_generator(
        name="raw-html",
        template="custom/raw",
        provider=provider,
        format=escapers.FORMAT_HTML,
        walk=lambda r: [{
            "data": {"snippet": "<p>hi</p>"},
            "output_path": "out.html",
        }],
    )
    files = gen.generate(_make_ctx(root))
    assert files[0].content != "<p>hi</p>\n"
    assert "&lt;" in files[0].content or "&#60;" in files[0].content
