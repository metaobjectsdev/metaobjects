"""FW-8 — M:N traversal routes inside a TPH hierarchy (FR-018 x FR-017).

Mirrors the TS reference regression (``codegen-ts/test/tph-m2m-routes.test.ts``):
before this fix, ``_render_tph_router`` never consulted the relation map at all, so
EVERY many-to-many navigation in a TPH hierarchy vanished from the generated API —
the one declared on the base as much as one declared on a subtype. Nothing failed:
a route that is never mounted is an ABSENCE, not a compile error.

The contract (see the router_generator module docstring / FW-8 brief):
  a. Every relationship the BASE resolves mounts at ``GET /<base>/{id}/<relation>``
     — same shape as a vanilla entity's traversal, no discriminator gate.
  b. Every relationship each CONCRETE SUBTYPE resolves — including ones inherited
     from the base or an abstract intermediate level — mounts at
     ``GET /<base>/<segment>/{id}/<relation>``. The overlap with (a) for an
     inherited relationship is deliberate: a subtype resource carries the same
     sub-resources as any other resource.
  c. The subtype route threads the ``@discriminatorValue`` into the repository seam
     (``find_related_<relation>(subtype, id)``) so the CONSUMER's repo can verify
     the source id names a row of that subtype and answer ``[]`` on a sibling's id
     — the junction FK can only address the shared base table, so the id alone
     cannot tell subtypes apart.
  d. An abstract intermediate level's relationship has no path of its own — it is
     served under each CONCRETE subtype beneath it (rule b), never at the base.
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
    tmp = Path(tempfile.mkdtemp(prefix="router-tph-m2m-"))
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


# Mirrors the TS fixture (tph-m2m-routes.test.ts) at a scale that still exercises
# every rule:
#   Auth (base, @discriminator "type") --tags--> Tag                  [rule a]
#   BridgeAuth (subtype)               --linkedAuths--> BridgeAuth    [rule b/c, self-join]
#   CopayAuth  (subtype)                                              [no own M:N]
#   ScopedAuth (ABSTRACT, extends Auth) --auditors--> Tag             [rule d]
#   PriorAuthAuth (subtype, extends ScopedAuth)
_TPH_M2M_META = {
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
                    {"field.enum": {"name": "type", "@values": ["Bridge", "Copay", "PriorAuth"]}},
                    {"field.string": {"name": "reference", "@required": True, "@maxLength": 80}},
                    # Declared on the BASE: legitimate for every row of the shared table.
                    {"relationship.association": {
                        "name": "tags", "@cardinality": "many",
                        "@objectRef": "Tag", "@through": "AuthTag",
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
                    # Declared on a SUBTYPE: a directed self-join onto that same subtype.
                    {"relationship.association": {
                        "name": "linkedAuths", "@cardinality": "many",
                        "@objectRef": "BridgeAuth", "@through": "AuthLink",
                        "@sourceRefField": "fromAuthId",
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
            # An ABSTRACT intermediate level that declares an M:N. Not the base, not a
            # concrete subtype — the level an own-only filter loses entirely.
            {"object.entity": {
                "name": "ScopedAuth",
                "extends": "Auth",
                "abstract": True,
                "children": [
                    {"relationship.association": {
                        "name": "auditors", "@cardinality": "many",
                        "@objectRef": "Tag", "@through": "AuthAudit",
                    }},
                ],
            }},
            {"object.entity": {
                "name": "PriorAuthAuth",
                "extends": "ScopedAuth",
                "@discriminatorValue": "PriorAuth",
                "children": [
                    {"field.string": {"name": "approver", "@maxLength": 80}},
                ],
            }},
            {"object.entity": {
                "name": "AuthTag",
                "children": [
                    {"source.rdb": {"@table": "auth_tags"}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"field.long": {"name": "tagId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["authId", "tagId"]}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "Auth"}},
                    {"identity.reference": {"name": "fkTag", "@fields": "tagId", "@references": "Tag"}},
                ],
            }},
            {"object.entity": {
                "name": "AuthLink",
                "children": [
                    {"source.rdb": {"@table": "auth_links"}},
                    {"field.long": {"name": "fromAuthId", "@required": True}},
                    {"field.long": {"name": "toAuthId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["fromAuthId", "toAuthId"]}},
                    {"identity.reference": {"name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth"}},
                    {"identity.reference": {"name": "fkTo", "@fields": "toAuthId", "@references": "BridgeAuth"}},
                ],
            }},
            # The junction references the CONCRETE subtype, not the abstract declaring
            # level — the supported authoring (derive_m2m_fields's subject set is
            # {declaring entity, navigating entity}; the physical FK is the same either
            # way, since a subtype stores into the base's table).
            {"object.entity": {
                "name": "AuthAudit",
                "children": [
                    {"source.rdb": {"@table": "auth_audits"}},
                    {"field.long": {"name": "auditAuthId", "@required": True}},
                    {"field.long": {"name": "auditTagId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["auditAuthId", "auditTagId"]}},
                    {"identity.reference": {"name": "fkAuditAuth", "@fields": "auditAuthId", "@references": "PriorAuthAuth"}},
                    {"identity.reference": {"name": "fkAuditTag", "@fields": "auditTagId", "@references": "Tag"}},
                ],
            }},
        ],
    }
}


def _render() -> str:
    entities = _load_entities(_TPH_M2M_META)
    index = build_object_index(list(entities.values()))
    out = render_router(entities["Auth"], index)
    assert out is not None
    return out


def test_base_declared_m2m_mounted_at_base_path_with_no_subtype_gate() -> None:
    out = _render()
    assert '@router.get("/{auth_id}/tags")' in out
    assert "def list_auth_tags(" in out
    assert "    return repo.find_related_tags(None, auth_id)" in out


def test_inherited_m2m_mounted_under_every_concrete_subtype_too() -> None:
    # `tags` is declared on Auth, so every subtype resolves it. The overlap with the
    # base mount is deliberate: /auths/bridge/{a Copay id}/tags must answer [] where
    # /auths/{that id}/tags does not, and only the subtype-scoped call can express that
    # — proven by the discriminator value actually being threaded through.
    out = _render()
    for value in ("Bridge", "Copay", "PriorAuth"):
        segment = value.lower()
        assert f'@router.get("/{segment}/{{auth_id}}/tags")' in out, out
        assert f'    return repo.find_related_tags("{value}", auth_id)' in out, out


def test_subtype_only_m2m_mounted_solely_under_its_own_subtype() -> None:
    out = _render()
    assert '@router.get("/bridge/{auth_id}/linkedAuths")' in out
    assert '    return repo.find_related_linkedAuths("Bridge", auth_id)' in out
    # Not a base route (Auth does not declare/resolve linkedAuths)...
    assert '@router.get("/{auth_id}/linkedAuths")' not in out
    # ...and not on the sibling subtypes either (own-only on BridgeAuth, not inherited).
    assert '@router.get("/copay/{auth_id}/linkedAuths")' not in out
    assert '@router.get("/priorauth/{auth_id}/linkedAuths")' not in out


def test_abstract_mid_level_m2m_mounts_under_its_concrete_descendant_only() -> None:
    # `auditors` lives on ScopedAuth (abstract) — no path, no rows of its own. It is
    # not on Auth either, so PriorAuthAuth (the one concrete descendant) is the ONLY
    # place it can be served.
    out = _render()
    assert '@router.get("/priorauth/{auth_id}/auditors")' in out
    assert '    return repo.find_related_auditors("PriorAuth", auth_id)' in out
    assert '@router.get("/{auth_id}/auditors")' not in out
    assert '@router.get("/bridge/{auth_id}/auditors")' not in out
    assert '@router.get("/copay/{auth_id}/auditors")' not in out


def test_repository_protocol_declares_one_seam_per_relation_name() -> None:
    out = _render()
    # Subtype-keyed like every other TPH seam method (`find_by_id(subtype, id)`, ...):
    # `subtype` is None from the base route, the @discriminatorValue from a subtype
    # route — the consumer's repo verifies the id is really that subtype's.
    assert out.count("def find_related_tags(self, subtype: str | None, id: int) -> list[Any]: ...") == 1
    assert out.count("def find_related_linkedAuths(self, subtype: str | None, id: int) -> list[Any]: ...") == 1
    assert out.count("def find_related_auditors(self, subtype: str | None, id: int) -> list[Any]: ...") == 1


def test_polymorphic_and_per_subtype_crud_mounts_still_present() -> None:
    # The fix must not regress the pre-existing TPH CRUD mounts (FR-017).
    out = _render()
    assert 'path="/api/auths"' in out or 'prefix="/api/auths"' in out
    assert '@router.get("/bridge/{auth_id}")' in out
    assert '@router.get("/copay/{auth_id}")' in out
    assert '@router.get("/priorauth/{auth_id}")' in out
    assert '@router.get("/{auth_id}")' in out
