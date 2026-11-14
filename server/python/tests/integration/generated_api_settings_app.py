"""Boot the GENERATED ``Item`` router of ``fixtures/api-contract-conformance/api-settings/``.

Peer of ``generated_secret_fields_app.py``. The settings under test (``api.pagination`` and
``api.unknownFields``) live in the sub-corpus's own ``.metaobjects/config.json``, and reach the
generator the way an adopter's reach it: through the config the project load reads.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

from .corpus_config import attach_corpus_wire
from .generated_router_app import InMemoryAuthorRepository


def load_entity(meta_json: Path, name: str) -> MetaObject:
    tmp = Path(tempfile.mkdtemp(prefix="apic-settings-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    attach_corpus_wire(result.root, meta_json)  # also attaches the corpus's `api` settings
    if result.errors:
        raise RuntimeError("; ".join(f"{e.code}: {e.message}" for e in result.errors))
    for c in result.root.children():
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject) and c.name.split("::")[-1] == name:
            return c
    raise RuntimeError(f"{name} entity not found")


def build_api_settings_app(corpus_root: Path) -> tuple[FastAPI, InMemoryAuthorRepository]:
    item = load_entity(corpus_root / "meta.json", "Item")
    router_src = render_router(item)
    allowlist_src = render_filter_allowlist(item)
    if router_src is None or allowlist_src is None:
        raise RuntimeError("router_generator / filter_allowlist_generator returned None for Item")

    pkg_name = f"genitems_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-settings-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "item_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / "Item.py").write_text(render_entity_model(item))
    (pkg_dir / "item_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(f"{pkg_name}.item_router", pkg_dir / "item_router.py")
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.item_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryAuthorRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo
