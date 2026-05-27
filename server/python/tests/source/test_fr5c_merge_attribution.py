"""FR5c — multi-file overlay merge attribution.

Verifies the loader's overlay-merge phase tracks contributors, raises
``ERR_MERGE_CONFLICT`` on attribute-level conflicts, and emits
``WARN_DUPLICATE_DECLARATION`` when a second file re-declares a node
identically. See ADR-0009 and the FR5c spec.

Mirrors TS test pattern at
  server/typescript/packages/metadata/test/fr5c-merge-attribution.test.ts
"""
from __future__ import annotations

import json

from metaobjects import ErrorCode, InMemoryStringSource, MetaDataLoader
from metaobjects.source import MergedSource, JsonSource


def _src(content: object, id: str) -> InMemoryStringSource:
    return InMemoryStringSource(json.dumps(content), id=id)


_BASE_ENTITY = {
    "metadata.root": {
        "package": "acme",
        "children": [
            {
                "object.entity": {
                    "name": "Subscriber",
                    "children": [
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "email"}},
                        {"identity.primary": {"@fields": "id"}},
                    ],
                }
            }
        ],
    }
}


def _base_with_field_attrs(extra_attrs: dict[str, object]) -> dict:
    email_node: dict[str, object] = {"name": "email"}
    email_node.update(extra_attrs)
    return {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.string": email_node},
                            {"identity.primary": {"@fields": "id"}},
                        ],
                    }
                }
            ],
        }
    }


# ---------------------------------------------------------------------------
# Merge attribution: contributors[] + MergedSource upgrade
# ---------------------------------------------------------------------------


def test_single_file_load_keeps_json_envelope() -> None:
    """A single-source load leaves the node's source as the parse-time
    JsonSource — no MergedSource upgrade.
    """
    res = MetaDataLoader().load([_src(_BASE_ENTITY, "meta.a.json")])
    assert not res.errors
    sub = next(
        (c for c in res.root.own_children() if c.name == "Subscriber"), None
    )
    assert sub is not None
    assert isinstance(sub.source, JsonSource)


def test_two_files_with_semantic_change_upgrade_to_merged() -> None:
    """File B adds a new @attr that File A didn't have → MergedSource with both
    files, contributors alphabetically ordered.
    """
    file_b = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "@description": "A newsletter subscriber.",
                    }
                }
            ],
        }
    }
    res = MetaDataLoader().load(
        [_src(_BASE_ENTITY, "meta.a.json"), _src(file_b, "meta.b.json")]
    )
    assert not res.errors
    sub = next(
        (c for c in res.root.own_children() if c.name == "Subscriber"), None
    )
    assert sub is not None
    assert isinstance(sub.source, MergedSource)
    assert sub.source.files == ("meta.a.json", "meta.b.json")
    assert [c.role for c in sub.source.contributors] == [
        "overlay-base",
        "overlay-extension",
    ]
    assert [c.file for c in sub.source.contributors] == [
        "meta.a.json",
        "meta.b.json",
    ]


def test_three_files_contribute_lists_all_three_alphabetically() -> None:
    file_b = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "@description": "Subscriber to a newsletter.",
                    }
                }
            ],
        }
    }
    file_c = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "@title": "Subscriber",
                    }
                }
            ],
        }
    }
    res = MetaDataLoader().load(
        [
            _src(_BASE_ENTITY, "meta.a.json"),
            _src(file_b, "meta.b.json"),
            _src(file_c, "meta.c.json"),
        ]
    )
    assert not res.errors
    sub = next(
        (c for c in res.root.own_children() if c.name == "Subscriber"), None
    )
    assert sub is not None
    assert isinstance(sub.source, MergedSource)
    assert sub.source.files == ("meta.a.json", "meta.b.json", "meta.c.json")
    roles = [c.role for c in sub.source.contributors]
    assert roles == ["overlay-base", "overlay-extension", "overlay-extension"]


# ---------------------------------------------------------------------------
# ERR_MERGE_CONFLICT on conflicting attr values
# ---------------------------------------------------------------------------


def test_two_files_conflicting_attr_emits_err_merge_conflict() -> None:
    """Two files set the same @-attr to different non-empty values → ERR_MERGE_CONFLICT
    with a MergedSource envelope naming both contributors.
    """
    res = MetaDataLoader().load(
        [
            _src(_base_with_field_attrs({"@description": "Primary email."}), "meta.a.json"),
            _src(_base_with_field_attrs({"@description": "Backup email."}), "meta.b.json"),
        ]
    )
    conflicts = [e for e in res.errors if e.code == ErrorCode.ERR_MERGE_CONFLICT]
    assert len(conflicts) == 1
    env = conflicts[0].envelope
    assert isinstance(env, MergedSource)
    assert env.files == ("meta.a.json", "meta.b.json")
    assert [c.file for c in env.contributors] == ["meta.a.json", "meta.b.json"]
    assert [c.role for c in env.contributors] == [
        "overlay-base",
        "overlay-extension",
    ]
    assert "@description" in env.json_path


def test_same_attr_same_value_no_conflict() -> None:
    """Identical non-empty values across files is a no-op merge; no
    ERR_MERGE_CONFLICT.
    """
    res = MetaDataLoader().load(
        [
            _src(_base_with_field_attrs({"@description": "Email."}), "meta.a.json"),
            _src(_base_with_field_attrs({"@description": "Email."}), "meta.b.json"),
        ]
    )
    assert not [e for e in res.errors if e.code == ErrorCode.ERR_MERGE_CONFLICT]


def test_only_one_side_declares_attr_no_conflict() -> None:
    """Overlay semantics by design — one side adding an attr the other lacks
    is the normal case (not a conflict).
    """
    res = MetaDataLoader().load(
        [
            _src(_base_with_field_attrs({"@description": "Email."}), "meta.a.json"),
            _src(_base_with_field_attrs({}), "meta.b.json"),
        ]
    )
    assert not [e for e in res.errors if e.code == ErrorCode.ERR_MERGE_CONFLICT]


# ---------------------------------------------------------------------------
# WARN_DUPLICATE_DECLARATION via semantic_diff
# ---------------------------------------------------------------------------


def test_identical_redeclaration_emits_warn_duplicate_declaration() -> None:
    """Two files declare the same node identically → WARN_DUPLICATE_DECLARATION
    on the legacy string channel + envelope channel.
    """
    # Use an abstract entity (no identity.primary). Two identical declarations
    # produce no semantic change → the warning fires.
    file = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "abstract": True,
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.string": {"name": "email"}},
                        ],
                    }
                }
            ],
        }
    }
    res = MetaDataLoader().load(
        [_src(file, "meta.a.json"), _src(file, "meta.b.json")]
    )
    assert not res.errors
    # Legacy string channel — the conformance runner's expected-warnings.json
    # check reads from here.
    sub_warn = next(
        (w for w in res.warnings if "Subscriber" in w), None
    )
    assert sub_warn is not None
    assert "duplicate declaration of Subscriber" in sub_warn
    # Envelope channel — typed envelope with MergedSource.
    envelope_warns = res.get_envelope_warnings()
    assert envelope_warns, "expected at least one envelope warning"
    sub_env = next(
        (w for w in envelope_warns if "Subscriber" in w.message), None
    )
    assert sub_env is not None
    assert sub_env.code == "WARN_DUPLICATE_DECLARATION"
    assert isinstance(sub_env.source, MergedSource)
    assert sub_env.source.files == ("meta.a.json", "meta.b.json")
    assert [c.role for c in sub_env.source.contributors] == [
        "overlay-base",
        "overlay-extension",
    ]


def test_real_semantic_overlay_no_warning() -> None:
    """A genuine semantic addition (e.g. @description added by B) is a real
    merge, not a duplicate — no WARN_DUPLICATE_DECLARATION fires for that node.
    """
    file_b = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {
                    "object.entity": {
                        "name": "Subscriber",
                        "@description": "Differs from A.",
                    }
                }
            ],
        }
    }
    res = MetaDataLoader().load(
        [_src(_BASE_ENTITY, "meta.a.json"), _src(file_b, "meta.b.json")]
    )
    dups = [w for w in res.warnings if "duplicate declaration of Subscriber" in w]
    assert dups == []
