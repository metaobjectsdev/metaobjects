"""FR5d — reference-resolution errors emit format=resolved with referrer + target.

Covers the five reference sites listed in
  docs/superpowers/specs/2026-05-25-fr5d-reference-resolution-errors.md:
  1. extends:                  ERR_UNRESOLVED_SUPER
  2. @payloadRef on template.* ERR_INVALID_TEMPLATE
  3. @requiredSlots field-on-payload ref  (template.*)
  4. @via path on origin       ERR_INVALID_ORIGIN
  5. @of / @from path on origin ERR_INVALID_ORIGIN

Per the FR5d cross-port-safety stance, Python now emits the new format=resolved
envelope but the cross-port fixtures stay on the FR5a format=json envelope until
all four ports ship FR5d. These unit tests assert the in-process Python shape
directly.

Mirrors TS test pattern at
  server/typescript/packages/metadata/test/fr5d-reference-resolution-errors.test.ts
"""
from __future__ import annotations

import json
from typing import Optional

from metaobjects import (
    ErrorCode,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataLoader,
    MetaError,
)
from metaobjects.source import ResolvedSource


def _expect_resolved(
    err: MetaError,
    *,
    code: ErrorCode,
    referrer: str,
    target: str,
    files: Optional[tuple[str, ...]] = None,
) -> None:
    """Assert a MetaError carries the FR5d resolved envelope with referrer+target."""
    assert err.code == code, f"code mismatch: {err.code} != {code}"
    assert isinstance(err.envelope, ResolvedSource), (
        f"envelope is {type(err.envelope).__name__}, expected ResolvedSource"
    )
    env = err.envelope
    assert env.referrer == referrer, f"referrer: {env.referrer!r} != {referrer!r}"
    assert env.target == target, f"target: {env.target!r} != {target!r}"
    if files is not None:
        assert env.files == files, f"files: {env.files!r} != {files!r}"


# ---------------------------------------------------------------------------
# 1. extends: emits format=resolved
# ---------------------------------------------------------------------------


def test_deferred_extends_resolution_emits_resolved_envelope() -> None:
    """Cross-file extends resolution: referrer = entity FQN, target = missing super."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Premium",
                                "extends": "DoesNotExist",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="meta.bad.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (e for e in result.errors if e.code == ErrorCode.ERR_UNRESOLVED_SUPER),
        None,
    )
    assert err is not None, f"expected ERR_UNRESOLVED_SUPER in {result.errors}"
    # Cross-port note: Python `obj.fqn()` returns the bare name "Premium"
    # because objects at the root do not inherit the root's package (only
    # field-in-non-object and qualified validators inherit) — aligned with TS.
    # Java/C# may emit the package-qualified form; reconciliation deferred to
    # FR5d-finalize.
    _expect_resolved(
        err,
        code=ErrorCode.ERR_UNRESOLVED_SUPER,
        referrer="Premium",
        target="DoesNotExist",
        files=("meta.bad.json",),
    )


# ---------------------------------------------------------------------------
# 2-3. @payloadRef / @requiredSlots emit format=resolved
# ---------------------------------------------------------------------------


def test_template_payload_ref_unresolved_emits_resolved_envelope() -> None:
    """template @payloadRef unresolved: referrer = template FQN, target = bad payloadRef."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::ai",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Npc",
                                "children": [
                                    {"field.string": {"name": "name"}},
                                    {"identity.primary": {"@fields": "name"}},
                                ],
                            },
                        },
                        {
                            "template.prompt": {
                                "name": "npcTurn",
                                "@payloadRef": "NpcPromptPayload",
                                "@textRef": "npc/turn",
                                "@format": "xml",
                            },
                        },
                    ],
                },
            }),
            id="meta.ai.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (e for e in result.errors if e.code == ErrorCode.ERR_INVALID_TEMPLATE),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_TEMPLATE in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_TEMPLATE,
        referrer="npcTurn",
        target="NpcPromptPayload",
        files=("meta.ai.json",),
    )


def test_template_required_slot_missing_field_on_payload_emits_resolved() -> None:
    """@requiredSlots missing field on payload: target = `payloadRef.slot`."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::ai",
                    "children": [
                        {
                            "object.value": {
                                "name": "PromptPayload",
                                "children": [
                                    {"field.string": {"name": "name"}},
                                ],
                            },
                        },
                        {
                            "template.prompt": {
                                "name": "tmpl",
                                "@payloadRef": "PromptPayload",
                                "@textRef": "tmpl/x",
                                "@format": "xml",
                                "@requiredSlots": ["name", "doesNotExist"],
                            },
                        },
                    ],
                },
            }),
            id="meta.ai.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (
            e for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_TEMPLATE and "doesNotExist" in e.message
        ),
        None,
    )
    assert err is not None, f"expected requiredSlot ERR_INVALID_TEMPLATE in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_TEMPLATE,
        referrer="tmpl",
        target="PromptPayload.doesNotExist",
        files=("meta.ai.json",),
    )


# ---------------------------------------------------------------------------
# 4. @via emits format=resolved (single-hop and multi-hop deepest-valid-prefix)
# ---------------------------------------------------------------------------


def test_via_to_nonexistent_relationship_emits_resolved_with_deepest_prefix() -> None:
    """@via to non-existent relationship: target = full ref, message names deepest-valid-prefix."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::commerce",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Program",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"field.string": {"name": "title"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "ProgramSummary",
                                "extends": "Program",
                                "children": [
                                    {"source.rdb": {"@kind": "view", "@table": "v_program_summary"}},
                                    {
                                        "field.int": {
                                            "name": "weekCount",
                                            "children": [
                                                {
                                                    "origin.aggregate": {
                                                        "@agg": "count",
                                                        "@of": "Program.id",
                                                        "@via": "Program.notARealRelationship",
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="meta.commerce.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (
            e for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_ORIGIN
            and "notARealRelationship" in e.message
        ),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_ORIGIN in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_ORIGIN,
        referrer="ProgramSummary::weekCount",
        target="Program.notARealRelationship",
        files=("meta.commerce.json",),
    )
    # Deepest-valid-prefix is "Program" (the entity resolved before the rel hop failed).
    assert 'Deepest valid prefix was "Program"' in err.message


def test_multi_hop_via_deepest_valid_prefix_names_last_resolved_hop() -> None:
    """Multi-hop @via: deepest-valid-prefix names the hop that did resolve."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::commerce",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Week",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "Program",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {
                                        "relationship.association": {
                                            "name": "weeks",
                                            "@objectRef": "Week",
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "ProgramSummary",
                                "extends": "Program",
                                "children": [
                                    {"source.rdb": {"@kind": "view", "@table": "v"}},
                                    {
                                        "field.int": {
                                            "name": "deepCount",
                                            "children": [
                                                {
                                                    "origin.aggregate": {
                                                        "@agg": "count",
                                                        "@of": "Week.id",
                                                        "@via": "Program.weeks.notReal",
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="meta.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (
            e for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_ORIGIN and "notReal" in e.message
        ),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_ORIGIN in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_ORIGIN,
        referrer="ProgramSummary::deepCount",
        target="Program.weeks.notReal",
    )
    # The walk got past Program.weeks (resolved to Week) and failed on `.notReal`.
    assert 'Deepest valid prefix was "Program.weeks"' in err.message


# ---------------------------------------------------------------------------
# 5. @of / @from emits format=resolved
# ---------------------------------------------------------------------------


def test_aggregate_of_to_nonexistent_entity_emits_resolved() -> None:
    """@of to non-existent entity: referrer = projection-FQN::field, target = full ref."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::commerce",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Program",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {
                                        "relationship.association": {
                                            "name": "weeks",
                                            "@objectRef": "Week",
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "Week",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "ProgramSummary",
                                "extends": "Program",
                                "children": [
                                    {"source.rdb": {"@kind": "view", "@table": "v"}},
                                    {
                                        "field.int": {
                                            "name": "weekCount",
                                            "children": [
                                                {
                                                    "origin.aggregate": {
                                                        "@agg": "count",
                                                        "@of": "GhostEntity.id",
                                                        "@via": "Program.weeks",
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="meta.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (
            e for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_ORIGIN and "GhostEntity" in e.message
        ),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_ORIGIN for GhostEntity in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_ORIGIN,
        referrer="ProgramSummary::weekCount",
        target="GhostEntity.id",
    )


def test_aggregate_of_to_existing_entity_missing_field_emits_resolved() -> None:
    """@of to existing entity but missing field: target = full ref."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::commerce",
                    "children": [
                        {
                            "object.entity": {
                                "name": "Program",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {
                                        "relationship.association": {
                                            "name": "weeks",
                                            "@objectRef": "Week",
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "Week",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                        {
                            "object.entity": {
                                "name": "ProgramSummary",
                                "extends": "Program",
                                "children": [
                                    {"source.rdb": {"@kind": "view", "@table": "v"}},
                                    {
                                        "field.int": {
                                            "name": "weekCount",
                                            "children": [
                                                {
                                                    "origin.aggregate": {
                                                        "@agg": "count",
                                                        "@of": "Week.ghostField",
                                                        "@via": "Program.weeks",
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="meta.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (
            e for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_ORIGIN and "ghostField" in e.message
        ),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_ORIGIN for ghostField in {result.errors}"
    _expect_resolved(
        err,
        code=ErrorCode.ERR_INVALID_ORIGIN,
        referrer="ProgramSummary::weekCount",
        target="Week.ghostField",
    )


# ---------------------------------------------------------------------------
# Resolved envelope shape contracts
# ---------------------------------------------------------------------------


def test_resolved_source_carries_referrer_files_and_jsonpath() -> None:
    """resolved source carries the referrer's files (so editors can jump to it).

    The json_path is populated by the parser so the IDE/editor can pinpoint
    the `extends:` declaration on disk.
    """
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "p",
                    "children": [
                        {
                            "object.entity": {
                                "name": "A",
                                "extends": "Ghost",
                                "children": [
                                    {"field.long": {"name": "id"}},
                                    {"identity.primary": {"@fields": "id"}},
                                ],
                            },
                        },
                    ],
                },
            }),
            id="input/A.json",
            format=MetaDataFormat.JSON,
        ),
    ])
    err = next(
        (e for e in result.errors if e.code == ErrorCode.ERR_UNRESOLVED_SUPER),
        None,
    )
    assert err is not None
    assert isinstance(err.envelope, ResolvedSource)
    env = err.envelope
    assert env.files == ("input/A.json",)
    # json_path populated by parser so editors can pinpoint the broken extends.
    assert env.json_path is not None
    assert "$" in env.json_path
