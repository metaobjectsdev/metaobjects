"""FW-8 follow-up — M:N traversal whose TARGET is a TPH subtype.

Mirrors the TypeScript reference's ``targetDiscriminator`` (see ``renderM2mMount``
in ``codegen-ts/src/templates/routes-file.ts``): when a relationship's
``@objectRef`` resolves to a concrete TPH subtype, the target's rows physically
live in its discriminator base's shared table, so a correct traversal must
return only rows of that subtype — never a sibling's.

Python ships no runtime SQL layer (the repository ``Protocol`` is
consumer-implemented; codegen never touches a database — see the
router_generator module docstring). So unlike the SOURCE-side rule (c) fix,
which composes an ALREADY-REQUIRED seam method (``find_by_id``) to enforce the
gate independent of the consumer, there is no existing seam to reuse for the
TARGET side: the target's own discriminator lives in a DIFFERENT hierarchy's
generated router/Protocol (or, for a self-join, the SAME one, but keyed by a
different id than the one this route receives). The fix that stays honest about
that boundary is to WIDEN the seam: ``find_related_<relation>`` gains a REQUIRED
``target_subtype`` parameter carrying the resolved ``@discriminatorValue`` as a
build-time literal, so the consumer's join implementation is structurally
handed — not left to independently rediscover — which subtype to filter to.
This is codegen-derived (never hand-authored) and changes NOTHING for the
overwhelming common case where the target isn't TPH (no new parameter at all,
byte-identical output preserved — proven by the existing non-TPH-target M:N
tests in test_router_generator.py / test_router_generator_tph_m2m.py).
"""
import json
import shutil
import tempfile
from pathlib import Path

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _load_entities(meta: dict) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="router-m2m-target-tph-"))
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


# Sponsor (VANILLA, non-TPH) --bridgeAuths--> BridgeAuth (a TPH subtype of Auth).
# Sponsor is the simplest case: a plain entity's M:N whose only wrinkle is a
# TPH-subtype target, isolated from any source-side TPH concern (rule c).
_META = {
    "metadata.root": {
        "package": "acme::sponsor",
        "children": [
            {"object.entity": {
                "name": "Auth",
                "@discriminator": "type",
                "children": [
                    {"source.rdb": {"@table": "auths"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "type", "@values": ["Bridge", "Copay"]}},
                    {"field.string": {"name": "reference", "@required": True, "@maxLength": 80}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeAuth",
                "extends": "Auth",
                "@discriminatorValue": "Bridge",
                "children": [
                    {"field.int": {"name": "quantity", "@required": True}},
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
                "name": "Sponsor",
                "children": [
                    {"source.rdb": {"@table": "sponsors"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                    {"relationship.association": {
                        "name": "bridgeAuths", "@cardinality": "many",
                        "@objectRef": "BridgeAuth", "@through": "SponsorAuth",
                    }},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "SponsorAuth",
                "children": [
                    {"source.rdb": {"@table": "sponsor_auths"}},
                    {"field.long": {"name": "sponsorId", "@required": True}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["sponsorId", "authId"]}},
                    {"identity.reference": {"name": "fkSponsor", "@fields": "sponsorId", "@references": "Sponsor"}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "BridgeAuth"}},
                ],
            }},
        ],
    }
}


def _render() -> str:
    entities = _load_entities(_META)
    index = build_object_index(list(entities.values()))
    out = render_router(entities["Sponsor"], index)
    assert out is not None
    return out


def test_protocol_seam_gains_target_subtype_param_for_a_tph_target() -> None:
    out = _render()
    assert (
        "def find_related_bridgeAuths(self, id: int, target_subtype: str) -> list[Any]: ..."
    ) in out


def test_route_body_passes_the_resolved_discriminator_value_literal() -> None:
    out = _render()
    assert '@router.get("/{sponsor_id}/bridgeAuths")' in out
    assert (
        "def list_sponsor_bridgeAuths(\n"
        "    sponsor_id: int,\n"
        "    repo: Annotated[SponsorRepository, Depends(get_repository)],\n"
        ") -> list[Any]:\n"
        '    return repo.find_related_bridgeAuths(sponsor_id, "Bridge")'
    ) in out


def test_no_bare_two_arg_form_leaks_alongside_the_widened_one() -> None:
    # Sanity check on THIS fixture's emission: the widened 3-arg Protocol/call
    # shape is the ONLY one emitted for a TPH-target relation — never both.
    # The complementary regression guard (a genuinely non-TPH target, e.g.
    # Gadget --tags--> Tag, keeps the bare `find_related_tags(self, id: uuid.UUID)`
    # shape with NO target_subtype at all) already lives in
    # test_router_generator.py::test_uuid_pk_types_every_path_param_and_protocol_site_as_uuid
    # — byte-identical before and after this change, since Tag is never TPH.
    out = _render()
    assert "def find_related_bridgeAuths(self, id: int) -> list[Any]: ..." not in out
    assert "return repo.find_related_bridgeAuths(sponsor_id)\n" not in out
