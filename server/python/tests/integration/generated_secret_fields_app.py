"""#484 — boot the GENERATED ``Account`` router (credential + ``@formExclude`` fields).

Peer of ``generated_router_app.py`` for ``fixtures/api-contract-conformance/secret-fields/``.
Runs the real generators, imports the emitted router unmodified and mounts it over an
in-memory repo behind the generated consumer seam. The repo stores whatever the router hands
it, so a column the router failed to strip lands in the row and a column it failed to hide
comes back out.
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

COLUMNS = ("id", "name", "tokenHash", "pinHash")


def load_account(meta_json: Path) -> MetaObject:
    tmp = Path(tempfile.mkdtemp(prefix="apic-secret-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    attach_corpus_wire(result.root, meta_json)
    if result.errors:
        raise RuntimeError("; ".join(f"{e.code}: {e.message}" for e in result.errors))
    for c in result.root.children():
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject) and c.name.split("::")[-1] == "Account":
            return c
    raise RuntimeError("Account entity not found")


class InMemoryAccountRepository(InMemoryAuthorRepository):
    """The Author repo, with every column present on a created row (a SQL INSERT leaves an
    unset column NULL, so a row that was never given ``tokenHash`` reads it back as null)."""

    def create(self, dto: Any) -> Any:
        return super().create({**dict.fromkeys(COLUMNS), **dict(dto)})


def build_secret_fields_app(corpus_root: Path) -> tuple[FastAPI, InMemoryAccountRepository]:
    account = load_account(corpus_root / "meta.json")
    router_src = render_router(account)
    allowlist_src = render_filter_allowlist(account)
    if router_src is None or allowlist_src is None:
        raise RuntimeError("router_generator / filter_allowlist_generator returned None for Account")

    pkg_name = f"gensecret_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-secret-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "account_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / "Account.py").write_text(render_entity_model(account))
    (pkg_dir / "account_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(f"{pkg_name}.account_router", pkg_dir / "account_router.py")
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.account_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryAccountRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo
