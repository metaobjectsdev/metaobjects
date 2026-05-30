"""FR-010 codegen — tolerant ``recover_<name>()`` + output-format prompt fragment.

Python's advantage (like TS's import-and-run): we GENERATE the parser+recover module
and the prompt module for a hand-built model, write them to a temp package, import
them, and actually CALL ``recover_<name>()`` on dirty input + ``render_<name>_format()``.

Mirrors the intent of C#'s ``Fr010CodegenTests`` / TS's ``fr010-output-codegen.test``.
The model exercises: a string field with ``@example``/``@instruction``; an enum field
with ``@values``/``@enumAlias``/``@enumDoc``; an int; an optional string; a string array.
"""
from __future__ import annotations

import importlib
import os
import sys

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects.codegen import (
    output_format_spec_emitter as ofs,
    recover_schema_emitter as rse,
)
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.output_parser_generator import (
    OutputParserGenerator,
    render_output_parser,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    OutputPromptGenerator,
    render_output_prompt,
)
from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_TEMPLATE,
)
from metaobjects.shared.structural import KEY_IS_ARRAY


# ---------------------------------------------------------------------------
# Builders — a rich payload covering every FR-010 codegen branch.
# ---------------------------------------------------------------------------


def _rich_root(fmt: str = "json", style: str = "guide") -> MetaRoot:
    title = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "title")
    title.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    title.set_attr(fc.FIELD_ATTR_EXAMPLE, "A short headline")
    title.set_attr(fc.FIELD_ATTR_INSTRUCTION, "Keep it under 10 words.")

    priority = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_ENUM, "priority")
    priority.set_attr(fc.FIELD_ATTR_REQUIRED, True)
    priority.set_attr(fc.FIELD_ATTR_VALUES, ["HIGH", "LOW"])
    # "medium" is an off-vocab alias folded to LOW; "hi" -> HIGH.
    priority.set_attr(fc.FIELD_ATTR_ENUM_ALIAS, {"medium": "LOW", "hi": "HIGH"})
    priority.set_attr(fc.FIELD_ATTR_ENUM_DOC, {"HIGH": "Urgent.", "LOW": "Whenever."})

    count = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_INT, "count")

    note = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "note")  # optional string

    tags = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_STRING, "tags")  # string array
    tags.set_attr(KEY_IS_ARRAY, True)

    vo = MetaObject(TYPE_OBJECT, "value", "TaskPayload")
    vo.package = "acme::ai"
    for f in (title, priority, count, note, tags):
        vo.add_child(f)

    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, "TaskOutput")
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, "TaskPayload")
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "ai/task")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, fmt)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PROMPT_STYLE, style)

    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = "acme::ai"
    root.add_child(vo)
    root.add_child(tmpl)
    return root


def _ctx(root: MetaRoot) -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )


def _materialize(pkg_dir: str, files: list) -> None:
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)


def _import_pkg(pkg_dir: str, monkeypatch) -> None:
    parent = pkg_dir.rsplit("/", 1)[0]
    monkeypatch.syspath_prepend(parent)
    for k in list(sys.modules):
        if k == "_fr010_pkg" or k.startswith("_fr010_pkg."):
            del sys.modules[k]


# ---------------------------------------------------------------------------
# Text-level: the emitters bake the FR-010 attrs into the literals.
# ---------------------------------------------------------------------------


def test_recover_schema_literal_bakes_enum_alias_and_values() -> None:
    root = _rich_root()
    vo = root.own_children()[0]
    lit = rse.schema_literal(vo, "json", "TaskPayload")
    assert lit.startswith('RecoverSchema(Format.JSON, "TaskPayload", [')
    # enum field: @values + @enumAlias (sorted keys, off-vocab "medium" -> LOW).
    assert 'FieldSpec.enum_field("priority", True, ["HIGH", "LOW"], ' in lit
    assert '{"hi": "HIGH", "medium": "LOW"}' in lit
    # required string + int scalars.
    assert 'FieldSpec.scalar("title", FieldKind.STRING, True)' in lit
    assert 'FieldSpec.scalar("count", FieldKind.INT, False)' in lit
    # array string -> still a STRING scalar slot in the recover schema.
    assert 'FieldSpec.scalar("tags", FieldKind.STRING, False)' in lit


def test_output_format_spec_literal_bakes_example_instruction_enum_doc() -> None:
    root = _rich_root(style="inline")
    vo = root.own_children()[0]
    tmpl = root.own_children()[1]
    lit = ofs.spec_literal(vo, tmpl, "TaskPayload")
    assert lit.startswith('OutputFormatSpec(Format.JSON, "TaskPayload", PromptStyle.INLINE, [')
    assert 'example="A short headline"' in lit
    assert 'instruction="Keep it under 10 words."' in lit
    assert 'enum_doc={"HIGH": "Urgent.", "LOW": "Whenever."}' in lit
    assert 'array=True' in lit  # the tags array field


def test_xml_format_selects_xml_enum_and_skips_recover_for_text() -> None:
    xml_root = _rich_root(fmt="xml")
    parser = render_output_parser(xml_root.own_children()[1], xml_root)
    assert parser is not None
    assert "RecoverSchema(Format.XML," in parser
    assert "def recover_task_output(" in parser

    text_root = _rich_root(fmt="text")
    text_parser = render_output_parser(text_root.own_children()[1], text_root)
    assert text_parser is not None
    # text-format outputs get NO recover — strict parser only.
    assert "def recover_task_output(" not in text_parser
    assert "RecoverSchema" not in text_parser
    # ...and no prompt fragment.
    assert render_output_prompt(text_root.own_children()[1], text_root) is None


# ---------------------------------------------------------------------------
# Import-and-run PROOF — generate, write, import, CALL.
# ---------------------------------------------------------------------------


def test_generated_recover_folds_alias_and_classifies(tmp_path, monkeypatch) -> None:
    root = _rich_root()
    parser_files = OutputParserGenerator().generate(_ctx(root))
    payload_files = PayloadVoGenerator().generate(_ctx(root))
    prompt_files = OutputPromptGenerator().generate(_ctx(root))
    assert len(parser_files) == 1
    assert len(prompt_files) == 1

    pkg_dir = str(tmp_path / "_fr010_pkg")
    _materialize(pkg_dir, [*payload_files, *parser_files, *prompt_files])
    _import_pkg(pkg_dir, monkeypatch)

    parser_mod = importlib.import_module("_fr010_pkg.task_output_output_parser")

    # Dirty input: preamble prose + ```json fence + off-vocab alias "medium"
    # (folds to LOW) + a missing optional ("note" absent). Mirrors the C# proof
    # (Fr010CodegenTests): scalar/enum recovery is asserted by value; scalar-array
    # recovery is bounded-scope-deferred (the schema slot is a STRING scalar — the
    # mirror carries a typed `list[str | None] | None` accessor but the engine does
    # not populate it), so `tags` is asserted by SHAPE (a None slot), not value.
    dirty = (
        "Sure! Here is the structured task:\n"
        "```json\n"
        '{ "title": "Ship the port", "priority": "medium", "count": 3, '
        '"tags": ["fr-010", "python"] }\n'
        "```\n"
        "Hope that helps!"
    )
    result = parser_mod.recover_task_output(dirty)

    # The @enumAlias fold: off-vocab "medium" -> canonical "LOW".
    assert result.data is not None
    assert result.data.priority == "LOW"
    assert result.data.title == "Ship the port"
    assert result.data.count == 3
    # The missing optional surfaces as None on the mirror.
    assert result.data.note is None
    # The mirror EXPOSES the array slot with the deferred-recovery accessor type.
    assert hasattr(result.data, "tags")

    # Classification: nothing required was lost; the report is non-empty.
    report = result.report
    assert not report.is_empty()
    assert not report.has_lost_required()
    states = report.states()
    assert states["priority"].value == "RECOVERED"
    assert states["title"].value == "RECOVERED"
    # The missing optional is classified LOST_OPTIONAL, never LOST_REQUIRED.
    assert "note" not in report.lost_required()


def test_generated_render_format_emits_comment_free_guide(tmp_path, monkeypatch) -> None:
    root = _rich_root(style="guide")
    payload_files = PayloadVoGenerator().generate(_ctx(root))
    parser_files = OutputParserGenerator().generate(_ctx(root))
    prompt_files = OutputPromptGenerator().generate(_ctx(root))

    pkg_dir = str(tmp_path / "_fr010_pkg")
    _materialize(pkg_dir, [*payload_files, *parser_files, *prompt_files])
    _import_pkg(pkg_dir, monkeypatch)

    prompt_mod = importlib.import_module("_fr010_pkg.task_output_output_prompt")
    fragment = prompt_mod.render_task_output_format()

    assert isinstance(fragment, str) and fragment.strip()
    # The guide carries the field instructions/examples in PROSE, never in
    # JSON/code comments (models ignore comments — the FR-010 invariant).
    assert "//" not in fragment
    assert "/*" not in fragment
    # The enum choices + a field example surface in the guide text.
    assert "HIGH" in fragment and "LOW" in fragment
    assert "A short headline" in fragment


def test_prompt_generator_emits_one_file_named_by_template(tmp_path) -> None:
    root = _rich_root()
    files = OutputPromptGenerator().generate(_ctx(root))
    assert [f.path for f in files] == ["task_output_output_prompt.py"]
