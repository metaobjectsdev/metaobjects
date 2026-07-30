"""Tests for the cross-port payload-VO generator (FR-006 Python).

Mirrors the Kotlin ``KotlinPayloadGenerator`` test contract — one Pydantic
``BaseModel`` per declared ``template.*`` (prompt / output / toolcall),
origin-aware field-type resolution, in-file nested-payload emission for
``origin.collection`` (with per-run dedupe across templates referencing the
same target).
"""
from __future__ import annotations

import pytest

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.payload_vo_generator import (
    ERR_PAYLOAD_NAME_COLLISION,
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


def _object_field(name: str, object_ref: str, *, is_array: bool = False) -> MetaField:
    """A plain ``field.object`` carrying an ``@objectRef`` (no origin child). The
    ref is passed in the FQN form the loader produces post-ADR-0041 (e.g.
    ``acme::ai::Note``) so the generator's package-stripping is exercised."""
    f = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_OBJECT, name)
    f.set_attr(fc.FIELD_ATTR_OBJECT_REF, object_ref)
    f.is_array = is_array
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
# Plain field.object @objectRef (no origin) — the FQN must be stripped to the
# bare name for BOTH the emitted field annotation AND the nested class
# declaration. Cross-port regression guard: the TS payload generator once
# emitted the raw ``@objectRef`` FQN verbatim (``notes: acme::ai::Note[]`` and
# ``interface acme::ai::Note``). Python resolves the ref to the target
# MetaObject and names off ``target.name`` (always bare), so this must stay
# clean — this test locks that in.
# ---------------------------------------------------------------------------


def test_plain_object_field_strips_fqn_to_bare_nested_payload() -> None:
    """A ``field.object`` whose ``@objectRef`` is a package-qualified FQN
    (``acme::ai::Note`` — the form the loader emits post-ADR-0041) must type as
    ``list[NotePayload]`` and emit ``class NotePayload(BaseModel):`` — the BARE
    name — never the raw FQN. Guards the cross-port payload FQN leak that was
    TS-only (``notes: acme::ai::Note[]`` / ``interface acme::ai::Note``)."""
    note = _value_object(
        "Note", [_field("text", fc.FIELD_SUBTYPE_STRING)], package="acme::ai"
    )
    report = _value_object(
        "Report",
        [_object_field("notes", "acme::ai::Note", is_array=True)],
        package="acme::ai",
    )
    tmpl = _template("ReportOutput", "Report")
    root = _root([note, report, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    # Field annotation types to the BARE nested-payload class, wrapped as a list.
    assert "notes: list[NotePayload]" in out
    # Nested payload class declared under its BARE name, before the primary class.
    assert "class NotePayload(BaseModel):" in out
    assert out.find("class NotePayload(BaseModel):") < out.find(
        "class ReportOutputPayload(BaseModel):"
    )
    assert "text: str" in out
    # __all__ carries both BARE class names.
    assert '__all__ = ["ReportOutputPayload", "NotePayload"]' in out
    # The referenced VO's FQN must NOT leak anywhere in the emitted source.
    assert "acme::ai::Note" not in out
    # No package separator in the emitted CODE. (The generated header comment
    # legitimately carries the module's OWN FQN — ``acme::ai::ReportOutput`` —
    # so the ``::``-free check is scoped to non-comment lines.)
    code = "\n".join(ln for ln in out.splitlines() if not ln.lstrip().startswith("#"))
    assert "::" not in code


def test_cross_package_short_name_collision_qualifies_both_nested_classes() -> None:
    """ADR-0044 — two ``object.value`` ``Note``s in different packages, both reachable
    from one payload by FQN ``@objectRef``, emit as TWO distinct package-qualified
    classes (``AcmeAlphaNotePayload`` / ``AcmeBetaNotePayload``) — never one shadowed
    ``NotePayload`` that drops the second shape. The un-colliding ``Digest`` primary
    stays bare (template-named)."""
    alpha = _value_object("Note", [_field("alphaText", fc.FIELD_SUBTYPE_STRING)], package="acme::alpha")
    beta = _value_object("Note", [_field("betaText", fc.FIELD_SUBTYPE_STRING)], package="acme::beta")
    digest = _value_object(
        "Digest",
        [
            _object_field("fromAlpha", "acme::alpha::Note"),
            _object_field("fromBeta", "acme::beta::Note"),
        ],
        package="acme::app",
    )
    # #228 fix round 2: @payloadRef authored FQN — `Digest` is explicitly
    # package="acme::app" while `tmpl` (added at root, default package
    # "acme::ai") is NOT in that package; ADR-0042 package-local resolution
    # requires an FQN ref here (matches how this would actually be authored).
    tmpl = _template("DigestOut", "acme::app::Digest")
    root = _root([alpha, beta, digest, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "class AcmeAlphaNotePayload(BaseModel):" in out
    assert "class AcmeBetaNotePayload(BaseModel):" in out
    assert "class NotePayload(BaseModel):" not in out
    assert "fromAlpha: AcmeAlphaNotePayload | None = None" in out
    assert "fromBeta: AcmeBetaNotePayload | None = None" in out
    assert '__all__ = ["DigestOutPayload", "AcmeAlphaNotePayload", "AcmeBetaNotePayload"]' in out


def test_nested_of_nested_collision_qualifies_across_depths() -> None:
    """ADR-0044 — the collision domain is the WHOLE transitive closure, not one
    depth. A ``Note`` reached at depth 2 (via ``Outer.inner``) collides with a
    ``Note`` reached at depth 1; both qualify (``AcmeBetaNotePayload`` /
    ``AcmeGammaNotePayload``) while the un-colliding intermediate ``Outer`` stays
    bare. Guards the recursive `_collect_nested_closure` walk."""
    beta_note = _value_object("Note", [_field("betaText", fc.FIELD_SUBTYPE_STRING)], package="acme::beta")
    gamma_note = _value_object("Note", [_field("gammaText", fc.FIELD_SUBTYPE_STRING)], package="acme::gamma")
    outer = _value_object(
        "Outer", [_object_field("inner", "acme::beta::Note")], package="acme::alpha"
    )
    digest = _value_object(
        "Digest",
        [
            _object_field("fromOuter", "acme::alpha::Outer"),
            _object_field("fromGamma", "acme::gamma::Note"),
        ],
        package="acme::app",
    )
    # #228 fix round 2: @payloadRef authored FQN — `Digest` is explicitly
    # package="acme::app" while `tmpl` (added at root, default package
    # "acme::ai") is NOT in that package; ADR-0042 package-local resolution
    # requires an FQN ref here (matches how this would actually be authored).
    tmpl = _template("DigestOut", "acme::app::Digest")
    root = _root([beta_note, gamma_note, outer, digest, tmpl])
    out = render_payload_vo(tmpl, root)
    assert out is not None
    assert "class OuterPayload(BaseModel):" in out  # unique → bare
    assert "class AcmeBetaNotePayload(BaseModel):" in out  # depth-2 collision member
    assert "class AcmeGammaNotePayload(BaseModel):" in out  # depth-1 collision member
    assert "class NotePayload(BaseModel):" not in out
    assert "inner: AcmeBetaNotePayload | None = None" in out
    assert "fromGamma: AcmeGammaNotePayload | None = None" in out


def test_derived_name_still_colliding_fails_loud() -> None:
    """ADR-0044 §4 backstop — two DISTINCT package FQNs whose package-qualified derived
    names still collide (``acme::alpha`` and ``acmeAlpha`` both PascalCase-fold to
    ``AcmeAlpha``) must fail loud with ``ERR_PAYLOAD_NAME_COLLISION``, never silently
    emit one class twice."""
    a = _value_object("Note", [_field("a", fc.FIELD_SUBTYPE_STRING)], package="acme::alpha")
    b = _value_object("Note", [_field("b", fc.FIELD_SUBTYPE_STRING)], package="acmeAlpha")
    digest = _value_object(
        "Digest",
        [
            _object_field("fromA", "acme::alpha::Note"),
            _object_field("fromB", "acmeAlpha::Note"),
        ],
        package="acme::app",
    )
    # #228 fix round 2: @payloadRef authored FQN — `Digest` is explicitly
    # package="acme::app" while `tmpl` (added at root, default package
    # "acme::ai") is NOT in that package; ADR-0042 package-local resolution
    # requires an FQN ref here (matches how this would actually be authored).
    tmpl = _template("DigestOut", "acme::app::Digest")
    root = _root([a, b, digest, tmpl])
    with pytest.raises(ValueError) as ei:
        render_payload_vo(tmpl, root)
    msg = str(ei.value)
    assert ERR_PAYLOAD_NAME_COLLISION in msg
    assert "AcmeAlphaNotePayload" in msg
    # Both source FQNs are named so the author can find and rename one.
    assert "acme::alpha::Note" in msg
    assert "acmeAlpha::Note" in msg


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


def test_template_prompt_payload_forbids_extra_fields() -> None:
    """A template.prompt payload is the render INPUT, so it forbids unknown fields —
    a mistyped slot fails at construction instead of silently rendering blank. A
    template.output payload is a parse target and stays tolerant (extra="ignore")."""
    payload = _value_object("Q", [_field("query", fc.FIELD_SUBTYPE_STRING)])
    prompt = _template("AskPrompt", "Q", subtype=tc.TEMPLATE_SUBTYPE_PROMPT)
    output = _template("AskOut", "Q", subtype=tc.TEMPLATE_SUBTYPE_OUTPUT)
    root = _root([payload, prompt, output])

    prompt_src = render_payload_vo(prompt, root)
    output_src = render_payload_vo(output, root)

    assert 'model_config = ConfigDict(extra="forbid")' in prompt_src
    assert "from pydantic import BaseModel, ConfigDict" in prompt_src
    assert "ConfigDict" not in output_src  # output payload tolerates extra fields

    # Runtime: the emitted prompt payload actually rejects an unknown field.
    ns: dict = {}
    exec(prompt_src, ns)  # noqa: S102 — exercising generated source
    cls = ns["AskPromptPayload"]
    cls(query="ok")  # valid construct
    raised = False
    try:
        cls(unknown_field="x")
    except Exception:
        raised = True
    assert raised, "template.prompt payload must reject unknown fields"
