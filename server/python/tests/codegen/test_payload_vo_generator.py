"""Tests for the cross-port payload-VO generator (FR-006 Python).

Mirrors the Kotlin ``KotlinPayloadGenerator`` test contract — one Pydantic
``BaseModel`` per declared ``template.*`` (prompt / output / toolcall),
origin-aware field-type resolution, in-file nested-payload emission for
``origin.collection`` (with per-run dedupe across templates referencing the
same target).
"""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.payload_vo_generator import (
    PayloadVoGenerator,
    payload_class_name,
    payload_module_name,
    payload_vo_generator,
    render_payload_vo,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.relationship.meta_relationship import MetaRelationship
from metaobjects.meta.core.relationship.relationship_constants import (
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_SUBTYPE_COMPOSITION,
)
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.persistence.origin.meta_origin import MetaOrigin
from metaobjects.meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_AGG,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_COLLECTION,
    ORIGIN_SUBTYPE_PASSTHROUGH,
)
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
    TYPE_TEMPLATE,
)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _field(name: str, sub: str) -> MetaField:
    return MetaField(TYPE_FIELD, sub, name)


def _field_with_origin(name: str, sub: str, origin: MetaOrigin) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    f.add_child(origin)
    return f


def _passthrough(from_ref: str) -> MetaOrigin:
    o = MetaOrigin(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH, "from")
    o.set_attr(ORIGIN_ATTR_FROM, from_ref)
    return o


def _aggregate(agg: str, *, of: str | None = None, via: str = "Parent.rel") -> MetaOrigin:
    o = MetaOrigin(TYPE_ORIGIN, ORIGIN_SUBTYPE_AGGREGATE, agg)
    o.set_attr(ORIGIN_ATTR_AGG, agg)
    if of is not None:
        o.set_attr(ORIGIN_ATTR_OF, of)
    o.set_attr(ORIGIN_ATTR_VIA, via)
    return o


def _collection(via: str) -> MetaOrigin:
    o = MetaOrigin(TYPE_ORIGIN, ORIGIN_SUBTYPE_COLLECTION, "via")
    o.set_attr(ORIGIN_ATTR_VIA, via)
    return o


def _value_object(name: str, fields: list[MetaField], *, package: str | None = None) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    obj.package = package
    for f in fields:
        obj.add_child(f)
    return obj


def _entity(name: str, fields: list[MetaField], *, relationships: list[MetaRelationship] | None = None) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "entity", name)
    for f in fields:
        obj.add_child(f)
    for r in relationships or []:
        obj.add_child(r)
    return obj


def _relationship(name: str, object_ref: str) -> MetaRelationship:
    r = MetaRelationship(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_COMPOSITION, name)
    r.set_attr(RELATIONSHIP_ATTR_OBJECT_REF, object_ref)
    return r


def _template(name: str, payload_ref: str, *, subtype: str = tc.TEMPLATE_SUBTYPE_OUTPUT) -> MetaTemplate:
    t = MetaTemplate(TYPE_TEMPLATE, subtype, name)
    t.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    if subtype != tc.TEMPLATE_SUBTYPE_TOOLCALL:
        t.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "tpl/x")
        t.set_attr(tc.TEMPLATE_ATTR_FORMAT, "json")
    return t


def _root(children: list, *, package: str = "acme::ai") -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = package
    for c in children:
        root.add_child(c)
    return root


def _ctx(root: MetaRoot, *, out_dir: str = "/tmp/out") -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir=out_dir),
        warn=lambda _m: None,
    )


# ---------------------------------------------------------------------------
# Subtype coverage — payload-VO emitted for prompt + output + toolcall.
# ---------------------------------------------------------------------------


def test_emits_payload_for_template_prompt() -> None:
    """The headline bug-fix — TS / C# / Kotlin all emit a payload for
    ``template.prompt``; Python now matches."""
    payload = _value_object("Welcome", [_field("name", fc.FIELD_SUBTYPE_STRING)])
    tmpl = _template("WelcomePrompt", "Welcome", subtype=tc.TEMPLATE_SUBTYPE_PROMPT)
    root = _root([payload, tmpl])
    files = PayloadVoGenerator().generate(_ctx(root))
    assert len(files) == 1
    assert files[0].path == "welcome_prompt_payload.py"
    assert "class WelcomePromptPayload(BaseModel):" in files[0].content
    assert "name: str" in files[0].content


def test_emits_payload_for_template_output() -> None:
    payload = _value_object("Outcome", [_field("age", fc.FIELD_SUBTYPE_INT)])
    tmpl = _template("OutcomeOutput", "Outcome", subtype=tc.TEMPLATE_SUBTYPE_OUTPUT)
    root = _root([payload, tmpl])
    files = PayloadVoGenerator().generate(_ctx(root))
    assert len(files) == 1
    assert files[0].path == "outcome_output_payload.py"
    assert "class OutcomeOutputPayload(BaseModel):" in files[0].content
    assert "age: int" in files[0].content


def test_emits_payload_for_template_toolcall() -> None:
    """``template.toolcall`` carries ``@payloadRef`` (per ADR-0011); the
    payload-VO codegen treats it uniformly with prompt + output."""
    payload = _value_object("ToolArgs", [_field("query", fc.FIELD_SUBTYPE_STRING)])
    tmpl = _template("SearchTool", "ToolArgs", subtype=tc.TEMPLATE_SUBTYPE_TOOLCALL)
    root = _root([payload, tmpl])
    files = PayloadVoGenerator().generate(_ctx(root))
    assert len(files) == 1
    assert files[0].path == "search_tool_payload.py"
    assert "class SearchToolPayload(BaseModel):" in files[0].content
    assert "query: str" in files[0].content


# ---------------------------------------------------------------------------
# Type-map fallback (no origin children).
# ---------------------------------------------------------------------------


def test_simple_field_projection_uses_type_map() -> None:
    payload = _value_object(
        "FullShape",
        [
            _field("s", fc.FIELD_SUBTYPE_STRING),
            _field("i", fc.FIELD_SUBTYPE_INT),
            _field("l", fc.FIELD_SUBTYPE_LONG),
            _field("d", fc.FIELD_SUBTYPE_DOUBLE),
            _field("b", fc.FIELD_SUBTYPE_BOOLEAN),
            _field("c", fc.FIELD_SUBTYPE_CURRENCY),
            _field("t", fc.FIELD_SUBTYPE_TIMESTAMP),
        ],
    )
    tmpl = _template("FullShapeOutput", "FullShape")
    root = _root([payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "s: str" in out
    assert "i: int" in out
    assert "l: int" in out
    assert "d: float" in out
    assert "b: bool" in out
    assert "c: int" in out  # currency is integer minor units (wire contract)
    assert "t: datetime.datetime" in out
    assert "import datetime" in out


# ---------------------------------------------------------------------------
# Origin-aware resolution.
# ---------------------------------------------------------------------------


def test_origin_passthrough_resolves_to_source_field_type() -> None:
    """``origin.passthrough @from "Entity.field"`` — payload field type
    should mirror the source field's type, not the payload field's own subtype."""
    src_entity = _entity("Source", [_field("displayName", fc.FIELD_SUBTYPE_STRING)])
    # Payload field declared as ``int`` but with a passthrough to a string source
    # field — the passthrough wins.
    payload = _value_object(
        "Aliased",
        [_field_with_origin("alias", fc.FIELD_SUBTYPE_INT, _passthrough("Source.displayName"))],
    )
    tmpl = _template("AliasedOutput", "Aliased")
    root = _root([src_entity, payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "alias: str" in out


def test_origin_aggregate_count_resolves_to_int() -> None:
    src = _entity("Source", [_field("id", fc.FIELD_SUBTYPE_LONG)])
    payload = _value_object(
        "Counted",
        [_field_with_origin("total", fc.FIELD_SUBTYPE_STRING, _aggregate("count", of="Source.id"))],
    )
    tmpl = _template("CountedOutput", "Counted")
    root = _root([src, payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "total: int" in out


def test_origin_aggregate_avg_resolves_to_float() -> None:
    src = _entity("Source", [_field("score", fc.FIELD_SUBTYPE_INT)])
    payload = _value_object(
        "Averaged",
        [_field_with_origin("avgScore", fc.FIELD_SUBTYPE_STRING, _aggregate("avg", of="Source.score"))],
    )
    tmpl = _template("AveragedOutput", "Averaged")
    root = _root([src, payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "avgScore: float" in out


def test_origin_aggregate_sum_resolves_to_of_field_type() -> None:
    """``@agg sum`` (and min/max) — type comes from the ``@of`` field, not from
    the payload field's declared subtype."""
    src = _entity("Source", [_field("priceCents", fc.FIELD_SUBTYPE_CURRENCY)])
    payload = _value_object(
        "Summed",
        [_field_with_origin("totalCents", fc.FIELD_SUBTYPE_STRING, _aggregate("sum", of="Source.priceCents"))],
    )
    tmpl = _template("SummedOutput", "Summed")
    root = _root([src, payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "totalCents: int" in out  # currency is int


def test_origin_collection_emits_nested_payload_and_list_type() -> None:
    """``origin.collection @via "Parent.rel"`` walks the relationship to a target
    value-object, emits a ``<TargetShortName>Payload`` IN-FILE, and types the
    payload field as ``list[<TargetShortName>Payload]``."""
    post = _value_object(
        "Post",
        [_field("title", fc.FIELD_SUBTYPE_STRING), _field("body", fc.FIELD_SUBTYPE_STRING)],
    )
    author = _entity(
        "Author",
        [_field("id", fc.FIELD_SUBTYPE_LONG)],
        relationships=[_relationship("posts", "Post")],
    )
    payload = _value_object(
        "AuthorSummary",
        [_field_with_origin("posts", fc.FIELD_SUBTYPE_STRING, _collection("Author.posts"))],
    )
    tmpl = _template("AuthorSummaryOutput", "AuthorSummary")
    root = _root([post, author, payload, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    # Nested payload emitted in the same file, BEFORE the primary class.
    assert out.find("class PostPayload(BaseModel):") < out.find("class AuthorSummaryOutputPayload(BaseModel):")
    assert "title: str" in out
    assert "posts: list[PostPayload]" in out
    # __all__ includes both class names.
    assert '__all__ = ["AuthorSummaryOutputPayload", "PostPayload"]' in out


def test_origin_collection_nested_payload_self_contained_per_file() -> None:
    """Each emitted payload module is self-contained: when two templates
    reference the same collection target, BOTH files declare the nested
    ``PostPayload`` class. Cross-template dedupe would leave the second file
    with a dangling forward-reference (Pydantic v2 raises
    ``PydanticUserError: ... not fully defined`` at model-build time)."""
    post = _value_object(
        "Post", [_field("title", fc.FIELD_SUBTYPE_STRING)]
    )
    author = _entity(
        "Author",
        [_field("id", fc.FIELD_SUBTYPE_LONG)],
        relationships=[_relationship("posts", "Post")],
    )
    summary_a = _value_object(
        "SummaryA",
        [_field_with_origin("posts", fc.FIELD_SUBTYPE_STRING, _collection("Author.posts"))],
    )
    summary_b = _value_object(
        "SummaryB",
        [_field_with_origin("posts", fc.FIELD_SUBTYPE_STRING, _collection("Author.posts"))],
    )
    tmpl_a = _template("SummaryAOutput", "SummaryA")
    tmpl_b = _template("SummaryBOutput", "SummaryB")
    root = _root([post, author, summary_a, summary_b, tmpl_a, tmpl_b])

    files = PayloadVoGenerator().generate(_ctx(root))
    paths = sorted(f.path for f in files)
    assert paths == ["summary_a_output_payload.py", "summary_b_output_payload.py"]

    by_path = {f.path: f.content for f in files}
    a_content = by_path["summary_a_output_payload.py"]
    b_content = by_path["summary_b_output_payload.py"]
    # Both files MUST declare PostPayload AND reference it — otherwise the
    # second file's SummaryBOutputPayload is unbuildable by Pydantic.
    assert "class PostPayload(BaseModel):" in a_content
    assert "class PostPayload(BaseModel):" in b_content
    assert "posts: list[PostPayload]" in a_content
    assert "posts: list[PostPayload]" in b_content


def test_origin_collection_nested_payload_deduped_within_file() -> None:
    """Within a single payload module, the same collection target is only
    emitted ONCE even if multiple fields reference it (no duplicate class)."""
    post = _value_object("Post", [_field("title", fc.FIELD_SUBTYPE_STRING)])
    author = _entity(
        "Author",
        [_field("id", fc.FIELD_SUBTYPE_LONG)],
        relationships=[_relationship("posts", "Post"), _relationship("drafts", "Post")],
    )
    summary = _value_object(
        "Combined",
        [
            _field_with_origin("posts", fc.FIELD_SUBTYPE_STRING, _collection("Author.posts")),
            _field_with_origin("drafts", fc.FIELD_SUBTYPE_STRING, _collection("Author.drafts")),
        ],
    )
    tmpl = _template("CombinedOutput", "Combined")
    root = _root([post, author, summary, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    # PostPayload class declared exactly once.
    assert out.count("class PostPayload(BaseModel):") == 1
    # Both fields type to it.
    assert "posts: list[PostPayload]" in out
    assert "drafts: list[PostPayload]" in out


# ---------------------------------------------------------------------------
# Resolution edge cases.
# ---------------------------------------------------------------------------


def test_returns_none_when_payload_ref_missing() -> None:
    naked = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, "Naked")
    root = _root([naked])
    assert render_payload_vo(naked, root) is None


def test_returns_none_when_payload_ref_unresolved() -> None:
    tmpl = _template("StrayOutput", "DoesNotExist")
    root = _root([tmpl])
    assert render_payload_vo(tmpl, root) is None


def test_returns_none_when_payload_ref_targets_entity_not_value() -> None:
    """Rejects entities — payloads must be ``object.value`` (Kotlin parity)."""
    impostor = _entity("Imposter", [_field("name", fc.FIELD_SUBTYPE_STRING)])
    tmpl = _template("ImposterOutput", "Imposter")
    root = _root([impostor, tmpl])
    assert render_payload_vo(tmpl, root) is None


def test_generator_skips_unresolved_and_warns() -> None:
    tmpl = _template("StrayOutput", "DoesNotExist")
    root = _root([tmpl])
    warnings: list[str] = []
    ctx = GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=warnings.append,
    )
    files = PayloadVoGenerator().generate(ctx)
    assert files == []
    assert any("StrayOutput" in w for w in warnings)


def test_generator_emits_payload_for_every_template_subtype_in_one_run() -> None:
    """A single root with prompt + output + toolcall templates yields three
    files in stable (name-sorted) order."""
    p1 = _value_object("PayloadA", [_field("a", fc.FIELD_SUBTYPE_STRING)])
    p2 = _value_object("PayloadB", [_field("b", fc.FIELD_SUBTYPE_INT)])
    p3 = _value_object("PayloadC", [_field("c", fc.FIELD_SUBTYPE_BOOLEAN)])
    t1 = _template("AlphaOutput", "PayloadA", subtype=tc.TEMPLATE_SUBTYPE_OUTPUT)
    t2 = _template("BravoPrompt", "PayloadB", subtype=tc.TEMPLATE_SUBTYPE_PROMPT)
    t3 = _template("CharlieTool", "PayloadC", subtype=tc.TEMPLATE_SUBTYPE_TOOLCALL)
    root = _root([p1, p2, p3, t1, t2, t3])
    files = PayloadVoGenerator().generate(_ctx(root))
    assert [f.path for f in files] == [
        "alpha_output_payload.py",
        "bravo_prompt_payload.py",
        "charlie_tool_payload.py",
    ]


def test_factory_returns_generator_with_expected_name() -> None:
    gen = payload_vo_generator()
    assert gen.name == "payload-vo-generator"


# ---------------------------------------------------------------------------
# Naming-helper unit tests (used by the parser generator's import).
# ---------------------------------------------------------------------------


def test_payload_class_name_appends_payload_suffix() -> None:
    assert payload_class_name("NpcResponseOutput") == "NpcResponseOutputPayload"


def test_payload_module_name_is_snake_case_with_suffix() -> None:
    assert payload_module_name("NpcResponseOutput") == "npc_response_output_payload"
