"""Unit tests for the `verify` drift check — mirrors
typescript/packages/render/test/verify.test.ts and csharp VerifyTests.cs.
"""

from __future__ import annotations

from metaobjects.render import (
    ERR_OUTPUT_TAG_MISSING,
    ERR_PARTIAL_UNRESOLVED,
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_VAR_NOT_ON_PAYLOAD,
    InMemoryProvider,
    PayloadField,
    VerifyError,
    verify,
)

# The AuthorBrief field tree (mirrors the payload-codegen VO walk):
#   displayName: str; postCount: number;
#   posts: { title: str; tags: { name: str }[] }[]
AUTHOR_BRIEF: list[PayloadField] = [
    PayloadField("displayName"),
    PayloadField("postCount"),
    PayloadField(
        "posts",
        [PayloadField("title"), PayloadField("tags", [PayloadField("name")])],
    ),
]


def _codes(
    text: str,
    fields: list[PayloadField],
    *,
    provider: InMemoryProvider | None = None,
    required_slots: list[str] | None = None,
) -> list[str]:
    errs = verify(text, fields, provider=provider, required_slots=required_slots)
    return [e.code for e in errs]


# --- interpolations against the (flat) payload ---


def test_known_scalar_var_no_drift() -> None:
    assert verify("Hi {{displayName}}.", AUTHOR_BRIEF) == []


def test_unknown_var_is_drift_with_path() -> None:
    assert verify("Hi {{notARealField}}.", AUTHOR_BRIEF) == [
        VerifyError(ERR_VAR_NOT_ON_PAYLOAD, "notARealField")
    ]


def test_unescaped_and_triple_are_checked() -> None:
    assert _codes("{{&nope}} {{{alsoNope}}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD,
        ERR_VAR_NOT_ON_PAYLOAD,
    ]


def test_implicit_iterator_is_valid() -> None:
    assert verify("{{.}}", AUTHOR_BRIEF) == []


# --- sections push the contextual VO (the load-bearing case) ---


def test_section_element_field_resolves() -> None:
    assert verify("{{#posts}}{{title}}{{/posts}}", AUTHOR_BRIEF) == []


def test_section_non_field_of_element_is_scoped_drift() -> None:
    assert _codes("{{#posts}}{{title}}{{nope}}{{/posts}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


def test_nested_sections_push_deeper() -> None:
    assert verify("{{#posts}}{{#tags}}{{name}}{{/tags}}{{/posts}}", AUTHOR_BRIEF) == []


def test_deeply_nested_non_field_is_drift() -> None:
    assert _codes("{{#posts}}{{#tags}}{{bogus}}{{/tags}}{{/posts}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


def test_parent_context_fields_resolve_inside_section() -> None:
    assert (
        verify("{{#posts}}{{title}} by {{displayName}}{{/posts}}", AUTHOR_BRIEF) == []
    )


def test_section_over_non_field_is_drift() -> None:
    assert _codes("{{#ghosts}}{{x}}{{/ghosts}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


def test_section_over_scalar_is_conditional() -> None:
    assert verify("{{#postCount}}{{displayName}}{{/postCount}}", AUTHOR_BRIEF) == []
    assert _codes("{{#postCount}}{{nope}}{{/postCount}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


# --- inverted sections ---


def test_inverted_section_body_in_parent_context_is_clean() -> None:
    assert verify("{{^posts}}{{displayName}} has none{{/posts}}", AUTHOR_BRIEF) == []


def test_inverted_section_over_non_field_is_drift() -> None:
    assert _codes("{{^ghosts}}none{{/ghosts}}", AUTHOR_BRIEF) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


# --- dotted paths ---


def test_valid_dotted_path_resolves() -> None:
    assert verify("{{posts.title}}", AUTHOR_BRIEF) == []


def test_dotted_path_tail_not_field_full_path_reported() -> None:
    assert verify("{{posts.nope}}", AUTHOR_BRIEF) == [
        VerifyError(ERR_VAR_NOT_ON_PAYLOAD, "posts.nope")
    ]


def test_dotted_path_head_not_field_is_drift() -> None:
    assert verify("{{ghost.title}}", AUTHOR_BRIEF) == [
        VerifyError(ERR_VAR_NOT_ON_PAYLOAD, "ghost.title")
    ]


# --- partials via the provider ---


def test_unresolved_partial_with_ref() -> None:
    errs = verify("a {{> g/missing}} b", AUTHOR_BRIEF, provider=InMemoryProvider({}))
    assert errs == [VerifyError(ERR_PARTIAL_UNRESOLVED, "g/missing")]


def test_resolved_partial_body_checked_in_current_context() -> None:
    provider = InMemoryProvider({"g/frag": "{{displayName}}{{nope}}"})
    assert _codes("{{> g/frag}}", AUTHOR_BRIEF, provider=provider) == [
        ERR_VAR_NOT_ON_PAYLOAD
    ]


def test_partial_inside_section_checked_in_pushed_context() -> None:
    provider = InMemoryProvider({"g/row": "{{title}}{{nope}}"})
    assert _codes(
        "{{#posts}}{{> g/row}}{{/posts}}", AUTHOR_BRIEF, provider=provider
    ) == [ERR_VAR_NOT_ON_PAYLOAD]


def test_no_provider_partials_not_checked() -> None:
    assert verify("a {{> g/whatever}} b", AUTHOR_BRIEF) == []


# --- required slots ---


def test_required_slot_referenced_no_warning() -> None:
    assert verify("{{displayName}}", AUTHOR_BRIEF, required_slots=["displayName"]) == []


def test_required_slot_unused_warns() -> None:
    assert verify("{{displayName}}", AUTHOR_BRIEF, required_slots=["postCount"]) == [
        VerifyError(ERR_REQUIRED_SLOT_UNUSED, "postCount")
    ]


def test_required_slot_referenced_via_section_counts_as_used() -> None:
    assert (
        verify("{{#posts}}{{title}}{{/posts}}", AUTHOR_BRIEF, required_slots=["posts"])
        == []
    )


# --- required output tags (@requiredTags) ---

_CONTENT: list[PayloadField] = [PayloadField("content")]


def test_no_required_tags_no_check() -> None:
    assert verify("plain text, no tags", _CONTENT) == []


def test_empty_required_tags_checks_nothing() -> None:
    assert verify("plain text", _CONTENT, required_tags=[]) == []


def test_tag_present_as_open_and_close_no_drift() -> None:
    assert (
        verify("<answer>{{content}}</answer>", _CONTENT, required_tags=["answer"]) == []
    )


def test_opening_tag_may_carry_attributes() -> None:
    assert (
        verify(
            '<answer tone="warm">{{content}}</answer>',
            _CONTENT,
            required_tags=["answer"],
        )
        == []
    )


def test_missing_open_tag_is_drift() -> None:
    assert verify("{{content}}</answer>", _CONTENT, required_tags=["answer"]) == [
        VerifyError(ERR_OUTPUT_TAG_MISSING, "answer")
    ]


def test_missing_close_tag_is_drift() -> None:
    assert verify("<answer>{{content}}", _CONTENT, required_tags=["answer"]) == [
        VerifyError(ERR_OUTPUT_TAG_MISSING, "answer")
    ]


def test_self_closing_tag_does_not_satisfy() -> None:
    assert verify("<answer/>", _CONTENT, required_tags=["answer"]) == [
        VerifyError(ERR_OUTPUT_TAG_MISSING, "answer")
    ]


def test_open_tag_prefix_does_not_overmatch_longer_name() -> None:
    assert verify(
        "<answers>{{content}}</answers>", _CONTENT, required_tags=["answer"]
    ) == [VerifyError(ERR_OUTPUT_TAG_MISSING, "answer")]


def test_each_missing_tag_reported_independently() -> None:
    assert verify(
        "<answer>{{content}}</answer>",
        _CONTENT,
        required_tags=["answer", "reasoning"],
    ) == [VerifyError(ERR_OUTPUT_TAG_MISSING, "reasoning")]


def test_tag_supplied_by_resolved_partial_counts_as_present() -> None:
    provider = InMemoryProvider({"g/ans": "<answer>{{content}}</answer>"})
    assert (
        verify("{{> g/ans}}", _CONTENT, provider=provider, required_tags=["answer"])
        == []
    )


def test_tag_straddling_body_and_partial_boundary_is_satisfied() -> None:
    provider = InMemoryProvider({"g/close": "{{content}}</answer>"})
    assert (
        verify(
            "<answer>{{> g/close}}",
            _CONTENT,
            provider=provider,
            required_tags=["answer"],
        )
        == []
    )


def test_without_provider_tag_only_in_partial_is_missing() -> None:
    assert verify("{{> g/ans}}", _CONTENT, required_tags=["answer"]) == [
        VerifyError(ERR_OUTPUT_TAG_MISSING, "answer")
    ]
