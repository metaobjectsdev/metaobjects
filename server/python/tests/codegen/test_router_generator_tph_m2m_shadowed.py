"""A subtype SHADOWS a base-declared M:N with a differently-TPH target.

Own children shadow super children on ``(type, name)`` (``meta_data.py``
``_effective_children_inner``), and the loader accepts the shadow cleanly — so
``BridgeAuth`` may redeclare ``helpers`` onto a TPH subtype target while ``Auth``
declares the same name onto a vanilla target. That is legal metadata, and the
generated TPH router must emit an internally CONSISTENT module for it: the
``find_related_<relation>`` Protocol seam and EVERY mount's call site have to
agree on the ``target_subtype`` parameter's arity.

The TPH router mounts one relation NAME several times (base path + every
subtype segment), so the seam is keyed by name — and the name's mounts here
disagree on target TPH-ness (``Auth.helpers`` → Tag, non-TPH;
``BridgeAuth.helpers`` → PriorityTicket, TPH). The decision is therefore made
per relation NAME across the WHOLE union of mounts: when ANY mount of a name
needs ``target_subtype``, it threads UNIFORMLY for that name as
``str | None``, with an explicit ``None`` literal at the non-TPH mounts. A
consumer implementing the declared Protocol then serves every mount — the
pre-fix emission (a 2-parameter seam beside a 3-argument call) made the module
impossible to implement, surfacing as a TypeError → HTTP 500 with no
build-time signal.

The executable counterpart (a strict-signature repo driven over HTTP by every
mount) lives in ``tests/integration/test_tph_m2m_shadowed_generated.py``.
"""
import json
import shutil
import tempfile
from pathlib import Path

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _load_entities(meta: dict) -> dict[str, MetaObject]:
    """Author *meta* as a temp ``meta.json`` and load it through the real loader
    (identity/relationship/extends resolution included)."""
    tmp = Path(tempfile.mkdtemp(prefix="router-tph-m2m-shadow-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(meta))
        result = MetaDataLoader.from_directory(str(tmp))
        assert not result.errors, "; ".join(
            f"{e.code}: {e.message}" for e in result.errors
        )
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# Auth (base, @discriminator "type") --helpers--> Tag              [non-TPH target]
# BridgeAuth (subtype)      --helpers--> PriorityTicket  [SHADOWS the name; TPH
#   target of the unrelated Ticket hierarchy, so the source-side gate and the
#   target-discriminator threading stay independent mechanisms]
# CopayAuth (subtype)                                             [inherits, unshadowed]
_META = {
    "metadata.root": {
        "package": "acme::auth",
        "children": [
            {"object.entity": {
                "name": "Tag",
                "children": [
                    {"source.rdb": {"@table": "tags"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "Auth",
                "@discriminator": "type",
                "children": [
                    {"source.rdb": {"@table": "auths"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "type", "@values": ["Bridge", "Copay"]}},
                    {"field.string": {"name": "reference", "@required": True, "@maxLength": 80}},
                    {"relationship.association": {
                        "name": "helpers", "@cardinality": "many",
                        "@objectRef": "Tag", "@through": "AuthHelper",
                    }},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeAuth",
                "extends": "Auth",
                "@discriminatorValue": "Bridge",
                "children": [
                    {"field.int": {"name": "quantity", "@required": True}},
                    {"relationship.association": {
                        "name": "helpers", "@cardinality": "many",
                        "@objectRef": "PriorityTicket", "@through": "BridgeHelper",
                    }},
                ],
            }},
            {"object.entity": {
                "name": "CopayAuth",
                "extends": "Auth",
                "@discriminatorValue": "Copay",
                "children": [
                    {"field.string": {"name": "payer", "@maxLength": 80}},
                ],
            }},
            {"object.entity": {
                "name": "AuthHelper",
                "children": [
                    {"source.rdb": {"@table": "auth_helpers"}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"field.long": {"name": "helperId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["authId", "helperId"]}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "Auth"}},
                    {"identity.reference": {"name": "fkHelper", "@fields": "helperId", "@references": "Tag"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeHelper",
                "children": [
                    {"source.rdb": {"@table": "bridge_helpers"}},
                    {"field.long": {"name": "bridgeAuthId", "@required": True}},
                    {"field.long": {"name": "ticketId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["bridgeAuthId", "ticketId"]}},
                    {"identity.reference": {"name": "fkBridgeAuth", "@fields": "bridgeAuthId", "@references": "BridgeAuth"}},
                    {"identity.reference": {"name": "fkTicket", "@fields": "ticketId", "@references": "PriorityTicket"}},
                ],
            }},
            {"object.entity": {
                "name": "Ticket",
                "@discriminator": "kind",
                "children": [
                    {"source.rdb": {"@table": "tickets"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "kind", "@values": ["Priority", "Standard"]}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "PriorityTicket",
                "extends": "Ticket",
                "@discriminatorValue": "Priority",
                "children": [
                    {"field.string": {"name": "escalation", "@maxLength": 40}},
                ],
            }},
        ],
    }
}


def _render() -> str:
    entities = _load_entities(_META)
    index = build_object_index(list(entities.values()))
    out = render_router(entities["Auth"], index)
    assert out is not None
    return out


def test_shadowed_name_seam_threads_target_subtype_for_the_whole_name() -> None:
    # ONE seam for the name, widened to str | None because its mounts disagree
    # on target TPH-ness — never the first descriptor's narrower shape.
    out = _render()
    assert out.count(
        "def find_related_helpers(self, subtype: str | None, id: int"
        ", target_subtype: str | None) -> list[Any]: ..."
    ) == 1
    assert (
        "def find_related_helpers(self, subtype: str | None, id: int) -> list[Any]: ..."
    ) not in out
    assert (
        "def find_related_helpers(self, subtype: str | None, id: int, target_subtype: str)"
        " -> list[Any]: ..."
    ) not in out


def test_every_mount_of_the_shadowed_name_passes_the_threaded_parameter() -> None:
    # Base mount (rule a — ungated): explicit None literal, not a dropped argument.
    out = _render()
    assert "    return repo.find_related_helpers(None, auth_id, None)" in out
    # Non-shadowing subtype (inherits the base's vanilla target): gated, None literal.
    assert (
        '    if repo.find_by_id("Copay", auth_id) is None:\n'
        "        return []\n"
        '    return repo.find_related_helpers("Copay", auth_id, None)'
    ) in out
    # Shadowing subtype: its OWN target's discriminator literal.
    assert (
        '    if repo.find_by_id("Bridge", auth_id) is None:\n'
        "        return []\n"
        '    return repo.find_related_helpers("Bridge", auth_id, "Priority")'
    ) in out


def test_no_two_argument_call_of_the_shadowed_name_remains() -> None:
    # The arity-agreement contract stated from the other side: no mount of the
    # name may call the seam without the parameter every other mount passes.
    out = _render()
    assert "repo.find_related_helpers(None, auth_id)\n" not in out
    assert 'repo.find_related_helpers("Copay", auth_id)\n' not in out
    assert 'repo.find_related_helpers("Bridge", auth_id)\n' not in out
