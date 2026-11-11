"""Boot the GENERATED ``Ticket`` router (an enum field carrying ``@default``).

Peer of ``generated_router_app.py`` for ``fixtures/api-contract-conformance/enum-default/``.
Runs the real generators, imports the emitted router unmodified and mounts it over an
in-memory repo behind the generated consumer seam. The repo stores whatever the router hands
it, so a default the router failed to apply is a column that stays null, as a SQL INSERT would leave it.
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
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

from .corpus_config import attach_corpus_wire
from .generated_router_app import InMemoryAuthorRepository

# The column defaults a SQL INSERT applies to an omitted column: `priority` carries the DEFAULT that
# `meta migrate` emits for `@default`, every other omitted column is NULL. The generated router leaves
# an omitted field out of the row it hands the repository, as the other ports' generated inserts do.
COLUMN_DEFAULTS: dict[str, Any] = {"id": None, "title": None, "priority": "NORMAL"}


def load_ticket(meta_json: Path) -> MetaObject:
    tmp = Path(tempfile.mkdtemp(prefix="apic-enumdefault-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    attach_corpus_wire(result.root, meta_json)
    if result.errors:
        raise RuntimeError("; ".join(f"{e.code}: {e.message}" for e in result.errors))
    for c in result.root.children():
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject) and c.name.split("::")[-1] == "Ticket":
            return c
    raise RuntimeError("Ticket entity not found")


class InMemoryTicketRepository(InMemoryAuthorRepository):
    """The Author repo, with an omitted column filled as a SQL INSERT would (see ``COLUMN_DEFAULTS``)."""

    def create(self, dto: Any) -> Any:
        return super().create({**COLUMN_DEFAULTS, **dict(dto)})


def build_enum_default_app(corpus_root: Path) -> tuple[FastAPI, InMemoryTicketRepository]:
    ticket = load_ticket(corpus_root / "meta.json")
    router_src = render_router(ticket)
    allowlist_src = render_filter_allowlist(ticket)
    if router_src is None or allowlist_src is None:
        raise RuntimeError("router_generator / filter_allowlist_generator returned None for Ticket")

    pkg_name = f"genenumdefault_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-enumdefault-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "ticket_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / "Ticket.py").write_text(render_entity_model(ticket))
    (pkg_dir / "ticket_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(f"{pkg_name}.ticket_router", pkg_dir / "ticket_router.py")
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.ticket_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryTicketRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo
