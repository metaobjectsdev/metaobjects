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

FW-8 follow-up (rule c enforcement + target-discriminator): a subtype-scoped mount
now COMPOSES the seam's own ``find_by_id(subtype, id)`` before ever calling
``find_related_<relation>`` — a miss returns ``[]`` without reaching the join at
all, so a consumer ``find_related_*`` that forgets to filter by subtype can no
longer leak a sibling's rows. Separately, when a relationship's ``@objectRef``
target itself resolves to a TPH subtype (``priorityTickets`` below, and the
self-join ``linkedAuths``), the seam gains a ``target_subtype`` parameter carrying
the resolved ``@discriminatorValue`` — mirrors the TS reference's
``targetDiscriminator``, widened rather than enforced (Python ships no runtime SQL
layer to enforce it independent of the consumer; see
test_router_generator_m2m_target_tph.py for the full rationale).
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
#   Auth (base) --priorityTickets--> PriorityTicket  [target-discriminator; base-declared
#     (Ticket is an UNRELATED TPH hierarchy — see below), so ungated, but target IS TPH]
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
                    # Also declared on the BASE, but the TARGET is a TPH subtype of an
                    # UNRELATED hierarchy (Ticket/PriorityTicket, below) — proves the
                    # source-side gate (rule c, keyed off THIS entity's subtype) and the
                    # target-discriminator param (keyed off the TARGET's fixed subtype)
                    # are independent: this mount stays UNGATED (rule a) while still
                    # carrying target_subtype="Priority". (A target from Auth's OWN
                    # hierarchy would make derive_m2m_fields read the per-subtype
                    # resolution as an ambiguous self-join whenever the iterating
                    # subtype equals the target subtype — a pre-existing limitation of
                    # the shared identity-based self-join heuristic, out of scope here.)
                    {"relationship.association": {
                        "name": "priorityTickets", "@cardinality": "many",
                        "@objectRef": "PriorityTicket", "@through": "AuthPriorityTicket",
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
            # An UNRELATED TPH hierarchy — Auth.priorityTickets' target. Separate from
            # Auth/BridgeAuth/CopayAuth/PriorAuthAuth entirely, so resolving the
            # relation via any Auth-hierarchy entity (base or subtype) never has
            # source is target (see the comment on priorityTickets above).
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
            {"object.entity": {
                "name": "AuthPriorityTicket",
                "children": [
                    {"source.rdb": {"@table": "auth_priority_tickets"}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"field.long": {"name": "ticketId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["authId", "ticketId"]}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "Auth"}},
                    {"identity.reference": {"name": "fkTicket", "@fields": "ticketId", "@references": "PriorityTicket"}},
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
    # Rule (a): every row of the shared table is a legitimate source at the base
    # path, so the handler body is a bare pass-through — no find_by_id gate.
    out = _render()
    assert '@router.get("/{auth_id}/tags")' in out
    assert (
        "def list_auth_tags(\n"
        "    auth_id: int,\n"
        "    repo: Annotated[AuthRepository, Depends(get_repository)],\n"
        ") -> list[Any]:\n"
        "    return repo.find_related_tags(None, auth_id)"
    ) in out
    # No gate anywhere near this handler — find_by_id is never called with None.
    assert 'repo.find_by_id(None, auth_id) is None' not in out


def _gated_body(
    subtype: str, relation: str, pk_param: str = "auth_id", *, target_subtype: str | None = None
) -> str:
    """The exact composed handler body a GATED (subtype-scoped) M:N route must
    have: verify the id via the seam's OWN find_by_id(subtype, id) — the same
    lookup the per-subtype GET route and the tph-cross-subtype-404 conformance
    scenario already gate — before ever calling find_related_<relation>. Rule (c)
    enforced in GENERATED code, not delegated to the consumer.

    *target_subtype*, when given, is the additional literal a TPH-target relation
    carries (FW-8 follow-up) — independent of the SOURCE-side gate above."""
    tail = f', "{target_subtype}"' if target_subtype is not None else ""
    return (
        f'    if repo.find_by_id("{subtype}", {pk_param}) is None:\n'
        "        return []\n"
        f'    return repo.find_related_{relation}("{subtype}", {pk_param}{tail})'
    )


def test_inherited_m2m_mounted_under_every_concrete_subtype_too() -> None:
    # `tags` is declared on Auth, so every subtype resolves it. The overlap with the
    # base mount is deliberate: /auths/bridge/{a Copay id}/tags must answer [] where
    # /auths/{that id}/tags does not, and only the subtype-scoped call can express that
    # — proven by the discriminator value actually being threaded through the GATE,
    # not just the join call.
    out = _render()
    for value in ("Bridge", "Copay", "PriorAuth"):
        segment = value.lower()
        assert f'@router.get("/{segment}/{{auth_id}}/tags")' in out, out
        assert _gated_body(value, "tags") in out, out


def test_subtype_only_m2m_mounted_solely_under_its_own_subtype() -> None:
    out = _render()
    assert '@router.get("/bridge/{auth_id}/linkedAuths")' in out
    # linkedAuths is a self-join onto BridgeAuth itself, so BOTH the source-side
    # gate (this row must be a Bridge) AND the target-discriminator literal (the
    # related rows must be Bridge too) happen to carry the SAME value here — two
    # independent mechanisms, not one collapsed into the other (see
    # test_priorauthlinks_target_discriminator_independent_of_source_gate below
    # for a case where the two values DIFFER).
    assert _gated_body("Bridge", "linkedAuths", target_subtype="Bridge") in out
    # Not a base route (Auth does not declare/resolve linkedAuths)...
    assert '@router.get("/{auth_id}/linkedAuths")' not in out
    # ...and not on the sibling subtypes either (own-only on BridgeAuth, not inherited).
    assert '@router.get("/copay/{auth_id}/linkedAuths")' not in out
    assert '@router.get("/priorauth/{auth_id}/linkedAuths")' not in out


def test_priority_tickets_target_discriminator_independent_of_source_gate() -> None:
    # priorityTickets is declared on the BASE (ungated, rule a) but targets a TPH
    # subtype of an UNRELATED hierarchy (PriorityTicket) — proving the source-side
    # gate (keyed to THIS row's subtype) and the target-discriminator literal
    # (keyed to the TARGET's fixed subtype) are genuinely independent mechanisms,
    # not the same value read twice.
    out = _render()
    assert '@router.get("/{auth_id}/priorityTickets")' in out
    assert (
        "def list_auth_priorityTickets(\n"
        "    auth_id: int,\n"
        "    repo: Annotated[AuthRepository, Depends(get_repository)],\n"
        ") -> list[Any]:\n"
        '    return repo.find_related_priorityTickets(None, auth_id, "Priority")'
    ) in out
    # Inherited by every subtype too (rule b) — each subtype's OWN gate applies,
    # while the target literal stays fixed at "Priority" regardless.
    for value in ("Bridge", "Copay", "PriorAuth"):
        assert _gated_body(value, "priorityTickets", target_subtype="Priority") in out, out


def test_abstract_mid_level_m2m_mounts_under_its_concrete_descendant_only() -> None:
    # `auditors` lives on ScopedAuth (abstract) — no path, no rows of its own. It is
    # not on Auth either, so PriorAuthAuth (the one concrete descendant) is the ONLY
    # place it can be served.
    out = _render()
    assert '@router.get("/priorauth/{auth_id}/auditors")' in out
    assert _gated_body("PriorAuth", "auditors") in out
    assert '@router.get("/{auth_id}/auditors")' not in out
    assert '@router.get("/bridge/{auth_id}/auditors")' not in out
    assert '@router.get("/copay/{auth_id}/auditors")' not in out


def test_subtype_gate_reuses_the_existing_find_by_id_seam_method() -> None:
    # The composition is a call to a Protocol method the consumer ALREADY has to
    # implement correctly for the per-subtype GET route (and which the
    # tph-cross-subtype-404 conformance scenario already gates) — no new method,
    # no new query strategy, just reuse.
    out = _render()
    assert out.count('def find_by_id(self, subtype: str | None, id: int) -> Any | None: ...') == 1


def test_repository_protocol_declares_one_seam_per_relation_name() -> None:
    out = _render()
    # Subtype-keyed like every other TPH seam method (`find_by_id(subtype, id)`, ...):
    # `subtype` is None from the base route, the @discriminatorValue from a subtype
    # route — the consumer's repo verifies the id is really that subtype's.
    assert out.count("def find_related_tags(self, subtype: str | None, id: int) -> list[Any]: ...") == 1
    # linkedAuths' and priorityTickets' targets are TPH subtypes — their seam
    # signatures gain target_subtype (FW-8 follow-up).
    assert out.count(
        "def find_related_linkedAuths(self, subtype: str | None, id: int, target_subtype: str) -> list[Any]: ..."
    ) == 1
    assert out.count("def find_related_auditors(self, subtype: str | None, id: int) -> list[Any]: ...") == 1
    assert out.count(
        "def find_related_priorityTickets(self, subtype: str | None, id: int, target_subtype: str) -> list[Any]: ..."
    ) == 1


def test_polymorphic_and_per_subtype_crud_mounts_still_present() -> None:
    # The fix must not regress the pre-existing TPH CRUD mounts (FR-017).
    out = _render()
    assert 'path="/api/auths"' in out or 'prefix="/api/auths"' in out
    assert '@router.get("/bridge/{auth_id}")' in out
    assert '@router.get("/copay/{auth_id}")' in out
    assert '@router.get("/priorauth/{auth_id}")' in out
    assert '@router.get("/{auth_id}")' in out
