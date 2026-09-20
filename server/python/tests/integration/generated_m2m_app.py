"""FR-018 Unit 14 — boot the GENERATED M:N traversal routers over HTTP.

Peer to ``generated_router_app.py`` (the single-entity Author lane) but for the
multi-entity M:N corpus. It runs the REAL ``router_generator`` (+ the filter
allowlist generator it imports) for the M:N SOURCE entities — the two vanilla
ones (Post, Person) AND the TPH discriminator base (Account, FW-8: FR-018 x
FR-017) — writes the emitted modules to a temp package, imports the generated
routers UNMODIFIED, mounts them on a FastAPI app, and fills each generated
``find_related_<relation>`` consumer seam with an in-memory join over the seed.

The generated router is the artifact under test: its M:N route declarations
(``GET /<source-plural>/{id}/<relationName>``, plus, for the TPH base, the
per-subtype-scoped ``GET /<source-plural>/<segment>/{id}/<relationName>``),
path-param binding, and the ``find_related_*`` seam shape are all exercised.
The in-memory repos (the only hand-written piece) sit behind the generated
seams and replay the cross-port join semantics (hetero / directed self-join /
symmetric union-on-read / TPH source-subtype-scoped / TPH target-subtype-narrowed).

Two repo shapes back the two seam shapes the generator emits:
  * ``InMemoryM2mRepository`` — vanilla (non-TPH-source) entities. A relation
    whose TARGET is a TPH subtype (``Post.reviewers`` → ``MemberAccount``) still
    uses this shape; the widening is an extra ``target_subtype`` call argument,
    not a different Protocol.
  * ``InMemoryTphM2mRepository`` — the TPH discriminator base. Every seam method
    is subtype-keyed (``subtype`` first, mirroring ``find_by_id``); rule (c) is
    enforced BOTH by the generated route's own composed ``find_by_id`` gate and,
    redundantly, by this repo's own join (belt-and-braces, matches the compliant
    shape in ``test_tph_m2m_generated.py``).

Both repo shapes resolve target-subtype narrowing the same way: the physical
target table → discriminator FIELD name is precomputed once (``tph_subtype_binding``)
and the per-descriptor discriminator VALUE (``target_discriminator``) is threaded
through as the ``target_subtype`` argument — this is the harness (consumer) doing
the filtering, per the generator's documented, deliberate design (Python ships no
runtime SQL layer to enforce it independently; see
``test_router_generator_m2m_target_tph.py``).

No Testcontainers — the router is the artifact, not the DB (real DB join behavior
is owned by persistence-conformance + the hand-rolled api-contract lane).
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.m2m_codegen import (
    M2mDescriptor,
    build_object_index,
    pk_field_name,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.tph_plan import tph_plan_for, tph_subtype_binding
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT
from metaobjects.source_resolution import resolve_table_name


# Physical junction tables → the seed.json key, so the in-memory repos can
# replay the join from the raw seed rows.
_JUNCTION_SEED_KEY: dict[str, str] = {
    "post_tags": "post_tags",
    "follows": "follows",
    "friendships": "friendships",
    "account_tags": "account_tags",
    "scoped_account_tags": "scoped_account_tags",
    "member_account_tags": "member_account_tags",
    "post_reviewers": "post_reviewers",
}
# Physical target table → seed.json key (the related rows source). "accounts" is
# both a TARGET (Post.reviewers → MemberAccount) and the TPH base's OWN table.
_TARGET_SEED_KEY: dict[str, str] = {
    "tags": "tags",
    "people": "people",
    "accounts": "accounts",
}


def _load_entities(meta_json: Path) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="m2m-gen-meta-"))
    try:
        shutil.copy(meta_json, tmp / "meta.json")
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"m2m meta.json failed to load: {msgs}")
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _snake(name: str) -> str:
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def _target_discriminator_fields(
    entities: dict[str, MetaObject], descriptors: list[M2mDescriptor]
) -> dict[str, str]:
    """Physical target table → discriminator FIELD name, for every descriptor
    whose ``@objectRef`` resolved to a concrete TPH subtype. The descriptor
    already carries the discriminator VALUE (``target_discriminator``); this is
    the FIELD it is compared against, resolved once via ``tph_subtype_binding``
    (the same helper the entity-model generator uses to pin a subtype's own
    discriminator literal)."""
    out: dict[str, str] = {}
    for d in descriptors:
        if d.target_discriminator is None:
            continue
        binding = tph_subtype_binding(entities[d.target_entity])
        if binding is not None:
            field, _value = binding
            out[d.target_table] = field
    return out


def build_generated_m2m_app(m2m_dir: Path) -> tuple[FastAPI, "_CombinedM2mRepo"]:
    """Generate the Post + Person + Account (TPH base) routers, import them,
    mount them, and wire each generated M:N consumer seam to an in-memory repo.
    Returns ``(app, repo)`` — ``repo`` fans ``.reset()``/``.seed()`` out to both
    backing repos, so callers keep the single-handle-per-scenario shape."""
    entities = _load_entities(m2m_dir / "meta.json")
    index = build_object_index(list(entities.values()))

    # Vanilla (non-TPH-source) M:N descriptors, across both source entities.
    vanilla_descriptors: list[M2mDescriptor] = []
    for src_name in ("Post", "Person"):
        vanilla_descriptors.extend(resolve_m2m_descriptors(entities[src_name], index))

    # The TPH discriminator base (Account). Every M:N reachable ANYWHERE in the
    # hierarchy — base-declared (badges), abstract-mid-declared (scopes, via
    # ScopedAccount), subtype-declared (interests, on MemberAccount only) — folds
    # into ONE `find_related_<relation>` seam per relation NAME, mirroring the
    # router generator's own `m2m_union` (see `_render_tph_router`).
    account = entities["Account"]
    plan = tph_plan_for(account, index)
    if plan is None:
        raise RuntimeError("Account is expected to be a TPH discriminator base")
    tph_union: dict[str, M2mDescriptor] = {
        d.relation_name: d for d in resolve_m2m_descriptors(account, index)
    }
    for st in plan.subtypes:
        for d in resolve_m2m_descriptors(st.entity, index):
            tph_union.setdefault(d.relation_name, d)
    tph_descriptors = list(tph_union.values())

    target_discriminator_field = _target_discriminator_fields(
        entities, vanilla_descriptors + tph_descriptors
    )

    vanilla_repo = InMemoryM2mRepository(vanilla_descriptors, target_discriminator_field)
    account_table = resolve_table_name(account)
    assert account_table is not None
    tph_repo = InMemoryTphM2mRepository(
        tph_descriptors,
        discriminator_field=plan.discriminator_field,
        own_table=account_table,
        pk_field=pk_field_name(account),
        target_discriminator_field=target_discriminator_field,
    )
    repo = _CombinedM2mRepo(vanilla_repo, tph_repo)

    pkg_name = f"genm2m_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-m2m-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")

    app = FastAPI()
    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    assert pkg_spec is not None and pkg_spec.loader is not None
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)

    # FR-036: each generated router imports its entity + PATCH models, and an M:N
    # entity model also imports its target-entity models (nested collections). Emit
    # every entity model module (base + TPH subtypes included) so those relative
    # imports resolve.
    for ent in entities.values():
        (pkg_dir / f"{ent.name}.py").write_text(render_entity_model(ent, index))

    for src_name in ("Post", "Person"):
        entity = entities[src_name]
        snake = _snake(src_name)
        allowlist_src = render_filter_allowlist(entity, index)
        router_src = render_router(entity, index)
        if allowlist_src is None or router_src is None:
            raise RuntimeError(f"generators returned None for {src_name}")
        (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
        (pkg_dir / f"{snake}_router.py").write_text(router_src)

        spec = importlib.util.spec_from_file_location(
            f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
        )
        assert spec is not None and spec.loader is not None
        router_mod = importlib.util.module_from_spec(spec)
        sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
        spec.loader.exec_module(router_mod)

        app.include_router(router_mod.router)
        app.dependency_overrides[router_mod.get_repository] = lambda r=vanilla_repo: r

    # The TPH discriminator base router (Account) — folds the base's polymorphic
    # collection PLUS every concrete subtype's CRUD + M:N traversal under one module.
    snake = _snake(account.name)
    allowlist_src = render_filter_allowlist(account, index)
    router_src = render_router(account, index)
    if allowlist_src is None or router_src is None:
        raise RuntimeError("generators returned None for Account")
    (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / f"{snake}_router.py").write_text(router_src)

    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
    )
    assert spec is not None and spec.loader is not None
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
    spec.loader.exec_module(router_mod)

    app.include_router(router_mod.router)
    # No-arg closure (NOT `lambda r=tph_repo: r`): FastAPI introspects an
    # override's signature, and a parameter-bearing override gets mis-bound on
    # body requests (POST/PATCH) — mirrors `generated_tph_app.py`'s own gotcha
    # note. The M:N scenarios here are GET-only, but this keeps the TPH router's
    # wiring consistent with its established-correct precedent.
    app.dependency_overrides[router_mod.get_repository] = lambda: tph_repo

    return app, repo


# ---------------------------------------------------------------------------
# Shared join helper — both repo shapes below resolve a M:N navigation the same
# way: junction rows for the source id → related target rows, optionally
# narrowed to a target TPH subtype.
# ---------------------------------------------------------------------------


def _related_ids(
    junction: list[dict[str, Any]], source_id: Any, d: M2mDescriptor
) -> list[Any]:
    source_key = str(source_id)
    seen: dict[str, Any] = {}
    for row in junction:
        a = row.get(d.source_column)
        b = row.get(d.target_column)
        if d.symmetric:
            a_is_source = a is not None and str(a) == source_key
            other = b if a_is_source else a
            if a_is_source or (b is not None and str(b) == source_key):
                if other is not None:
                    seen.setdefault(str(other), other)
        else:
            if a is not None and str(a) == source_key and b is not None:
                seen.setdefault(str(b), b)
    return list(seen.values())


def _lookup_related_rows(
    seed: dict[str, list[dict[str, Any]]],
    source_id: Any,
    d: M2mDescriptor,
    target_subtype: str | None,
    target_discriminator_field: dict[str, str],
) -> list[dict[str, Any]]:
    junction = seed.get(_JUNCTION_SEED_KEY[d.junction_table], [])
    related_ids = _related_ids(junction, source_id, d)
    if not related_ids:
        return []
    target_rows = seed.get(_TARGET_SEED_KEY[d.target_table], [])
    want = {str(i) for i in related_ids}
    rows = [r for r in target_rows if str(r.get(d.target_pk_column)) in want]
    disc_field = target_discriminator_field.get(d.target_table)
    # Prefer the call-site literal the generated route actually threads through;
    # fall back to the descriptor's own resolved value (they agree by construction).
    effective_subtype = target_subtype if target_subtype is not None else d.target_discriminator
    if disc_field is not None and effective_subtype is not None:
        rows = [r for r in rows if r.get(disc_field) == effective_subtype]
    return rows


# ---------------------------------------------------------------------------
# In-memory repo behind the GENERATED vanilla (non-TPH-source) seam. Implements
# the CRUD Protocol verbs (unused by the M:N scenarios but part of the generated
# Protocol) AND the generated ``find_related_<relation>`` finders via reflection
# over the descriptor join plan.
# ---------------------------------------------------------------------------


class InMemoryM2mRepository:
    """Replays the cross-port M:N join semantics from the raw seed rows."""

    def __init__(
        self,
        descriptors: list[M2mDescriptor],
        target_discriminator_field: dict[str, str] | None = None,
    ) -> None:
        # relation_name → descriptor (the generated route calls
        # find_related_<relation_name>; we dispatch by attribute name below).
        self._by_relation = {d.relation_name: d for d in descriptors}
        self._target_discriminator_field = target_discriminator_field or {}
        self._seed: dict[str, list[dict[str, Any]]] = {}

    # --- test harness (not part of the generated Protocol) ---
    def reset(self) -> None:
        self._seed = {}

    def seed(self, seed: dict[str, list[dict[str, Any]]]) -> None:
        self._seed = {k: [dict(r) for r in v] for k, v in seed.items()}

    # --- CRUD Protocol surface (unused by M:N scenarios, present for parity) ---
    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        return []

    def count(self, filters: list[Any]) -> int:
        return 0

    def find_by_id(self, id: int) -> Any | None:
        return None

    def create(self, dto: Any) -> Any:
        return dto

    def update(self, id: int, dto: Any) -> Any | None:
        return None

    def delete(self, id: int) -> bool:
        return False

    # --- M:N finders: resolved dynamically so any find_related_<rel> the
    #     generated router declares dispatches to the descriptor join. A
    #     TPH-target relation (e.g. Post.reviewers) calls with one extra
    #     positional `target_subtype` argument — captured via *rest. ---
    def __getattr__(self, name: str) -> Any:
        prefix = "find_related_"
        if name.startswith(prefix):
            relation = name[len(prefix):]
            descriptor = self._by_relation.get(relation)
            if descriptor is not None:
                return lambda source_id, *rest, _d=descriptor: self._join(
                    source_id, _d, rest[0] if rest else None
                )
        raise AttributeError(name)

    def _join(
        self, source_id: Any, d: M2mDescriptor, target_subtype: str | None = None
    ) -> list[dict[str, Any]]:
        return _lookup_related_rows(
            self._seed, source_id, d, target_subtype, self._target_discriminator_field
        )


# ---------------------------------------------------------------------------
# In-memory repo behind the GENERATED TPH (subtype-keyed) seam — FW-8. Every
# method takes `subtype` first (``None`` for the polymorphic base route, the
# ``@discriminatorValue`` for a per-subtype route), mirroring every other
# TPH Protocol method (``find_by_id``, ``list``, ...).
# ---------------------------------------------------------------------------


class InMemoryTphM2mRepository:
    """Replays the cross-port M:N join semantics for a TPH discriminator base's
    navigations, scoped to the requested subtype.

    Rule (c) — a subtype-scoped mount answers ``[]`` for an id that does not
    name a row of that subtype — is enforced TWICE here: once by the generated
    route itself (it composes ``repo.find_by_id(subtype, id)`` before ever
    calling ``find_related_*``, per ``router_generator``'s ``_emit_tph_m2m_route``),
    and again by this repo's own ``find_related_*`` doing the same check —
    matching the compliant shape in ``test_tph_m2m_generated.py``'s ``_Repo``.
    """

    def __init__(
        self,
        descriptors: list[M2mDescriptor],
        *,
        discriminator_field: str,
        own_table: str,
        pk_field: str,
        target_discriminator_field: dict[str, str],
    ) -> None:
        self._by_relation = {d.relation_name: d for d in descriptors}
        self._disc = discriminator_field
        self._own_table = own_table
        self._pk_field = pk_field
        self._target_discriminator_field = target_discriminator_field
        self._seed: dict[str, list[dict[str, Any]]] = {}

    # --- test harness (not part of the generated Protocol) ---
    def reset(self) -> None:
        self._seed = {}

    def seed(self, seed: dict[str, list[dict[str, Any]]]) -> None:
        self._seed = {k: [dict(r) for r in v] for k, v in seed.items()}

    def _rows(self) -> list[dict[str, Any]]:
        return self._seed.get(_TARGET_SEED_KEY[self._own_table], [])

    def _scoped(self, subtype: str | None) -> list[dict[str, Any]]:
        rows = self._rows()
        if subtype is None:
            return rows
        return [r for r in rows if r.get(self._disc) == subtype]

    # --- subtype-keyed CRUD Protocol surface (unused by M:N scenarios, present
    #     for parity with the generated TPH Protocol) ---
    def list(self, subtype: str | None, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        return self._scoped(subtype)[offset: offset + limit]

    def count(self, subtype: str | None, filters: list[Any]) -> int:
        return len(self._scoped(subtype))

    def find_by_id(self, subtype: str | None, id: Any) -> dict[str, Any] | None:
        for r in self._scoped(subtype):
            if str(r.get(self._pk_field)) == str(id):
                return r
        return None

    def create(self, subtype: str | None, dto: Any) -> Any:  # pragma: no cover — not exercised here
        raise NotImplementedError

    def update(self, subtype: str | None, id: Any, dto: Any) -> Any | None:  # pragma: no cover
        raise NotImplementedError

    def delete(self, subtype: str | None, id: Any) -> bool:  # pragma: no cover — not exercised here
        raise NotImplementedError

    # --- FW-8 generated M:N seam: subtype-keyed, optionally target-subtype-widened ---
    def __getattr__(self, name: str) -> Any:
        prefix = "find_related_"
        if name.startswith(prefix):
            relation = name[len(prefix):]
            descriptor = self._by_relation.get(relation)
            if descriptor is not None:
                return lambda subtype, source_id, *rest, _d=descriptor: self._join(
                    subtype, source_id, _d, rest[0] if rest else None
                )
        raise AttributeError(name)

    def _join(
        self,
        subtype: str | None,
        source_id: Any,
        d: M2mDescriptor,
        target_subtype: str | None,
    ) -> list[dict[str, Any]]:
        # Rule (c), belt-and-braces: the generated route already refuses to reach
        # here for a mismatched id (its own composed find_by_id gate), but this
        # repo enforces it independently too — matching the documented compliant
        # consumer shape.
        if self.find_by_id(subtype, source_id) is None:
            return []
        return _lookup_related_rows(
            self._seed, source_id, d, target_subtype, self._target_discriminator_field
        )


class _CombinedM2mRepo:
    """Fans ``.reset()``/``.seed()`` out to the vanilla + TPH in-memory repos
    this harness wires to their respective generated routers, so a caller only
    ever holds one repo handle to reset/seed per scenario."""

    def __init__(self, vanilla: InMemoryM2mRepository, tph: InMemoryTphM2mRepository) -> None:
        self._vanilla = vanilla
        self._tph = tph

    def reset(self) -> None:
        self._vanilla.reset()
        self._tph.reset()

    def seed(self, seed: dict[str, list[dict[str, Any]]]) -> None:
        self._vanilla.seed(seed)
        self._tph.seed(seed)
