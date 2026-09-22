"""A child wrapper's BODY must be an object, and a bad key is judged before the body.

The conformance corpus proves this through ``fixtures/conformance/error-child-not-object``
and ``.../error-unknown-bare-child-type``. This file adds what the corpus cannot say: that
the refused child is ABSENT from the tree and its valid siblings are not, and that the
registered-type arm is covered at all.

Until 1.0.5 this port coerced a non-object body to ``{}`` and built the node from it, so a
registered type with a string body (``{"field.string": "label"}``) was dropped in total
silence — no error, no warning, on the port whose ``_build`` had the check nowhere. Only an
UNKNOWN type was caught, and by the type check rather than by any rule about bodies, which is
why the gap read as covered.
"""
from __future__ import annotations

import json

import pytest

from metaobjects import load_string
from metaobjects.errors import ErrorCode


def _load(child: object):
    return load_string(json.dumps({"metadata.root": {"package": "acme", "children": [
        {"object.entity": {"name": "Account", "children": [
            {"field.long": {"name": "id"}},
            child,
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ]}},
    ]}}))


# --- the body ---

@pytest.mark.parametrize("body", ["label", ["label"], None, 7, True])
def test_a_registered_type_with_a_non_object_body_is_refused(body: object) -> None:
    result = _load({"field.string": body})
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_CHILD_NOT_OBJECT in codes, codes


def test_a_bodyless_child_fails_the_load_rather_than_thinning_the_tree() -> None:
    """The load FAILS — it does not succeed with the declared field quietly missing.

    This port discards the tree on any load error (an unknown type behaves identically,
    and has since long before this rule), so there is no "sibling survived" property to
    assert here as there is in TypeScript and C#. What matters is the difference from the
    old behaviour: a caller used to get a clean result whose ``Account`` was real and
    whose ``label`` was not, and codegen would emit the table without the column.
    """
    result = _load({"field.string": "label"})
    assert [e.code for e in result.errors] == [ErrorCode.ERR_CHILD_NOT_OBJECT]
    assert result.root.children() == []

    valid = _load({"field.string": {"name": "label"}})
    assert valid.errors == []
    entity = next(c for c in valid.root.children() if c.name == "Account")
    assert "label" in [c.name for c in entity.children()]


def test_the_error_names_the_json_kind_the_author_wrote() -> None:
    # Named in the JSON vocabulary the author is reading, not Python's: a metadata file
    # holds `null`, never `None`.
    result = _load({"field.string": None})
    message = next(e.message for e in result.errors
                   if e.code is ErrorCode.ERR_CHILD_NOT_OBJECT)
    assert "null" in message
    assert "None" not in message


def test_an_attr_child_with_a_non_object_body_is_refused() -> None:
    """The attr door is a separate FUNCTION here, not just a separate branch.

    Fixing only ``_build`` left ``_parse_attr_child`` coercing the body to ``{}`` and then
    reporting the missing ``name`` that produced — ERR_MISSING_REQUIRED_ATTR, a consequence
    rather than the cause, and a fresh disagreement with the other three ports.
    """
    result = _load({"field.string": {"name": "s", "children": [{"attr.string": "a note"}]}})
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_CHILD_NOT_OBJECT in codes, codes
    assert ErrorCode.ERR_MISSING_REQUIRED_ATTR not in codes, codes


# --- the key, which is judged first ---

def test_an_unknown_key_with_a_non_object_body_is_an_unknown_type() -> None:
    # `$comment` is not a node, so telling the author to give it a node body would send
    # them to wrap prose that was never a node in the first place.
    result = _load({"$comment": "prose"})
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_UNKNOWN_TYPE in codes, codes
    assert ErrorCode.ERR_CHILD_NOT_OBJECT not in codes, codes


def test_an_unregistered_bare_child_key_is_an_unknown_type() -> None:
    result = _load({"madeup": {"name": "label"}})
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_UNKNOWN_TYPE in codes, codes
    assert ErrorCode.ERR_MISSING_SUBTYPE not in codes, codes


def test_a_registered_type_with_no_declared_default_still_reports_missing_subtype() -> None:
    # The control the registration-first guard must not swallow: `identity` IS registered
    # and declares no default subType, so that advice is correct for it.
    result = _load({"identity": {"name": "alt"}})
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_MISSING_SUBTYPE in codes, codes
    assert ErrorCode.ERR_UNKNOWN_TYPE not in codes, codes


# --- the root door runs the same rule under its own code ---

def test_a_non_object_root_body_is_a_top_level_error() -> None:
    result = load_string(json.dumps({"metadata.root": "acme"}))
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT in codes, codes
