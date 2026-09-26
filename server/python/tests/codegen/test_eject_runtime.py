"""`metaobjects eject routes` hands over the helper runtime its output imports.

ADR-0034 Amendment 3: a generator is a helper the adopter owns, and owning it means owning
every helper line its generated code depends on — otherwise a bug in ``filter_parser``
still waits on an upstream release. So ejecting ``routes`` also copies
``metaobjects.codegen.runtime``'s ``filter_parser`` and ``constraint_errors`` into
``codegen/runtime/``, and the owned generator emits that source into the generated
package (``_runtime/``) and imports it package-relatively. A project that has not ejected
is untouched: the packaged generator still imports the installed runtime.

These tests EXECUTE the owned output: import the whole generated package (the compile
gate's two halves: import + ruff F821), serve a generated router with the installed
runtime made unimportable, and prove an edit to the owned runtime reaches the wire.
"""
from __future__ import annotations

import importlib
import subprocess
import sys
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from metaobjects.cli import main
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY

REPO = Path(__file__).parents[4]
FITNESS = REPO / "fixtures" / "persistence-conformance" / "canonical" / "meta.fitness.json"
API_CONTRACT = REPO / "fixtures" / "api-contract-conformance" / "meta.json"
RUNTIME_MODULES = ("constraint_errors", "filter_parser")
INSTALLED_RUNTIME = "metaobjects.codegen.runtime"


def _project(root: Path, meta: Path, generators: str) -> str:
    """A project whose single target writes into a uniquely-named, importable package."""
    (root / "metaobjects").mkdir(parents=True)
    (root / "metaobjects" / meta.name).write_text(meta.read_text(encoding="utf-8"))
    pkg = f"gen_{uuid.uuid4().hex[:8]}"
    (root / "metaobjects.config.yaml").write_text(
        f"targets:\n  api:\n    outDir: {pkg}\n    generators: [{generators}]\n"
    )
    return pkg


def _owned_routes_project(root: Path, meta: Path, monkeypatch) -> str:
    pkg = _project(root, meta, "entity, filter-allowlist, codegen.generators.routes:router_generator")
    monkeypatch.chdir(root)
    assert main(["eject", "routes"]) == 0
    assert main(["gen"]) == 0
    return pkg


def _import_all(root: Path, pkg: str) -> list[str]:
    """Import every emitted module; return the failures."""
    failures: list[str] = []
    for path in sorted((root / pkg).rglob("*.py")):
        dotted = ".".join(path.relative_to(root).with_suffix("").parts)
        if dotted.endswith(".__init__"):
            dotted = dotted[: -len(".__init__")]
        try:
            importlib.import_module(dotted)
        except Exception as exc:  # noqa: BLE001 — every failure mode is a finding
            failures.append(f"{dotted}: {type(exc).__name__}: {exc}")
    return failures


def _forget(pkg: str) -> None:
    for name in [m for m in sys.modules if m.split(".")[0] == pkg]:
        del sys.modules[name]


def _block_installed_runtime(monkeypatch) -> None:
    """Make the INSTALLED helper runtime unimportable for the rest of the test, so
    generated code that still reaches for it fails loudly instead of quietly working.
    Called after eject, which reads the installed runtime to copy it."""
    for name in [INSTALLED_RUNTIME] + [f"{INSTALLED_RUNTIME}.{m}" for m in RUNTIME_MODULES]:
        monkeypatch.setitem(sys.modules, name, None)


# --- what eject writes ------------------------------------------------------------------


def test_routes_entry_lists_its_runtime_and_nothing_else_does() -> None:
    assert GENERATOR_REGISTRY["routes"].runtime == RUNTIME_MODULES
    others = {n: e.runtime for n, e in GENERATOR_REGISTRY.items() if n != "routes" and e.runtime}
    assert others == {}


def test_every_runtime_module_is_self_contained() -> None:
    """A copied module must run outside the package: stdlib imports only."""
    import ast

    for m in RUNTIME_MODULES:
        tree = ast.parse(owned.packaged_runtime_path(m).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert node.level == 0 and node.module is not None, (m, node.module)
                roots = [node.module.split(".")[0]]
            elif isinstance(node, ast.Import):
                roots = [a.name.split(".")[0] for a in node.names]
            else:
                continue
            for root in roots:
                assert root == "__future__" or root in sys.stdlib_module_names, (m, root)


def test_eject_routes_copies_runtime_verbatim_and_flips_only_the_switch(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "routes"]) == 0
    out = capsys.readouterr().out
    for m in RUNTIME_MODULES:
        copy = tmp_path / "codegen" / "runtime" / f"{m}.py"
        assert copy.read_bytes() == owned.packaged_runtime_path(m).read_bytes()
        assert f"codegen/runtime/{m}.py: copied" in out

    entry = GENERATOR_REGISTRY["routes"]
    copy = (tmp_path / "codegen" / "generators" / "routes.py").read_text(encoding="utf-8")
    packaged = owned.packaged_source(entry)
    assert copy != packaged
    assert copy == packaged.replace("OWNED_RUNTIME = False", "OWNED_RUNTIME = True")

    assert main(["gen", "--list"]) == 0
    listing = capsys.readouterr().out
    assert "[owned — identical]" in next(ln for ln in listing.splitlines() if ln.startswith("routes — "))
    for m in RUNTIME_MODULES:
        assert f"runtime codegen/runtime/{m}.py [owned — identical]" in listing


def test_eject_never_overwrites_an_owned_runtime_copy(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "routes"]) == 0
    mine = tmp_path / "codegen" / "runtime" / "filter_parser.py"
    mine.write_text(mine.read_text(encoding="utf-8") + "\n# my fix\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["eject", "routes", "--force"]) == 0
    assert mine.read_text(encoding="utf-8").endswith("# my fix\n")
    assert "filter_parser.py: kept your copy" in capsys.readouterr().out
    assert main(["gen", "--list"]) == 0
    assert ("runtime codegen/runtime/filter_parser.py [owned — DIFFERS: 0 behind, 1 of your own]"
            in capsys.readouterr().out)


def test_eject_of_a_generator_without_runtime_writes_no_runtime(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["eject", "entity", "filter-allowlist", "names"]) == 0
    assert not (tmp_path / "codegen" / "runtime").exists()


# --- a project that has not ejected -----------------------------------------------------


def test_packaged_routes_still_import_the_installed_runtime(tmp_path, monkeypatch) -> None:
    pkg = _project(tmp_path, FITNESS, "entity, filter-allowlist, routes")
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    routers = sorted((tmp_path / pkg).glob("*_router.py"))
    assert routers
    for r in routers:
        assert f"from {INSTALLED_RUNTIME}.filter_parser import" in r.read_text(encoding="utf-8")
    assert not (tmp_path / pkg / "_runtime").exists()


def test_owned_output_differs_from_packaged_only_in_the_runtime_imports(tmp_path, monkeypatch) -> None:
    packaged = tmp_path / "packaged"
    pkg_a = _project(packaged, FITNESS, "entity, filter-allowlist, routes")
    monkeypatch.chdir(packaged)
    assert main(["gen"]) == 0
    pkg_b = _owned_routes_project(tmp_path / "owned", FITNESS, monkeypatch)

    a = {p.relative_to(packaged / pkg_a): p.read_text(encoding="utf-8")
         for p in (packaged / pkg_a).rglob("*.py")}
    b_root = tmp_path / "owned" / pkg_b
    b = {p.relative_to(b_root): p.read_text(encoding="utf-8") for p in b_root.rglob("*.py")}
    runtime = {Path("_runtime") / f"{m}.py" for m in RUNTIME_MODULES} | {Path("_runtime/__init__.py")}
    assert set(b) - set(a) == runtime
    # Import sorting moves the now-relative imports below the third-party block, so the
    # comparison is over lines, not positions.
    def lines(text: str) -> Counter[str]:
        return Counter(ln for ln in text.splitlines() if ln.strip())

    for rel, text in a.items():
        assert lines(b[rel]) == lines(text.replace(f"from {INSTALLED_RUNTIME}.", "from ._runtime.")), rel


# --- the owned output, executed ---------------------------------------------------------


def test_owned_output_has_no_installed_runtime_import_and_compiles(
    tmp_path, monkeypatch,
) -> None:
    pytest.importorskip("fastapi")
    pkg = _owned_routes_project(tmp_path, FITNESS, monkeypatch)
    _block_installed_runtime(monkeypatch)
    emitted = sorted((tmp_path / pkg).rglob("*.py"))
    routers = [p for p in emitted if p.name.endswith("_router.py")]
    assert len(routers) >= 10
    offenders = [p.name for p in emitted if INSTALLED_RUNTIME in p.read_text(encoding="utf-8")]
    assert offenders == []

    sys.path.insert(0, str(tmp_path))
    try:
        assert _import_all(tmp_path, pkg) == []
    finally:
        sys.path.remove(str(tmp_path))
        _forget(pkg)

    proc = subprocess.run(
        [sys.executable, "-m", "ruff", "check", "--no-cache", "--isolated",
         "--select", "F821,F822,F811,E9", "--output-format", "concise", str(tmp_path / pkg)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


class _Repo:
    """In-memory stand-in behind the generated ``AuthorRepository`` seam."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def _match(self, filters: list[Any]) -> list[dict[str, Any]]:
        out = self.rows
        for p in filters:
            assert p.op == "eq", p
            out = [r for r in out if str(r.get(p.field)) == str(p.value)]
        return out

    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[dict[str, Any]]:
        return [dict(r) for r in self._match(filters)[offset: offset + limit]]

    def count(self, filters: list[Any]) -> int:
        return len(self._match(filters))

    def find_by_id(self, id: int) -> Any:
        return next((dict(r) for r in self.rows if r["id"] == id), None)

    def create(self, dto: Any) -> Any:
        err = RuntimeError("duplicate key value violates unique constraint")
        err.sqlstate = "23505"  # type: ignore[attr-defined]
        raise err

    def update(self, id: int, dto: Any) -> Any:
        return None

    def delete(self, id: int) -> bool:
        return False


def _serve(root: Path, pkg: str):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    _forget(pkg)
    router_mod = importlib.import_module(f"{pkg}.author_router")
    repo = _Repo([
        {"id": 1, "name": "Ada", "bio": None, "createdAt": "2026-01-01T00:00:00Z"},
        {"id": 2, "name": "Grace", "bio": None, "createdAt": "2026-01-02T00:00:00Z"},
    ])
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return router_mod, TestClient(app)


def test_owned_router_serves_through_the_local_runtime_and_an_edit_takes_effect(
    tmp_path, monkeypatch,
) -> None:
    pytest.importorskip("fastapi")
    pkg = _owned_routes_project(tmp_path, API_CONTRACT, monkeypatch)
    _block_installed_runtime(monkeypatch)
    sys.path.insert(0, str(tmp_path))
    try:
        router_mod, client = _serve(tmp_path, pkg)
        # The names the router calls come from the generated package's own copy.
        assert router_mod.parse_filter.__module__ == f"{pkg}._runtime.filter_parser"
        assert router_mod.classify_constraint_error.__module__ == f"{pkg}._runtime.constraint_errors"

        ok = client.get("/api/authors?filter[name][eq]=Grace")
        assert ok.status_code == 200, ok.text
        assert [r["name"] for r in ok.json()] == ["Grace"]

        bad = client.get("/api/authors?filter[unknown][eq]=x")
        assert bad.status_code == 400
        assert bad.json() == {"error": "invalid_filter_field", "field": "unknown"}

        dup = client.post("/api/authors", json={"name": "Ada", "createdAt": "2026-01-01T00:00:00Z"})
        assert dup.status_code == 409, dup.text
        assert dup.json() == {"error": "constraint_violation", "constraint": "unique"}

        # Fix "a helper bug" in the owned copy, without any upstream release.
        owned_fp = tmp_path / "codegen" / "runtime" / "filter_parser.py"
        text = owned_fp.read_text(encoding="utf-8")
        assert text.count('_ERR_FIELD = "invalid_filter_field"') == 1
        owned_fp.write_text(
            text.replace('_ERR_FIELD = "invalid_filter_field"', '_ERR_FIELD = "owned_filter_field"'),
            encoding="utf-8",
        )

        # verify stays honest: the owned runtime is never drift, but the generated package
        # still carries the old copy until gen runs, and verify says so.
        assert main(["verify", "--codegen"]) == 1
        assert main(["gen"]) == 0
        assert main(["verify", "--codegen"]) == 0

        _, client = _serve(tmp_path, pkg)
        bad = client.get("/api/authors?filter[unknown][eq]=x")
        assert bad.status_code == 400
        assert bad.json() == {"error": "owned_filter_field", "field": "unknown"}
    finally:
        sys.path.remove(str(tmp_path))
        _forget(pkg)


def test_verify_never_counts_the_owned_runtime_as_drift(tmp_path, monkeypatch, capsys) -> None:
    _owned_routes_project(tmp_path, API_CONTRACT, monkeypatch)
    (tmp_path / "codegen" / "runtime" / "notes.py").write_text("# adopter-owned helper\n")
    capsys.readouterr()
    assert main(["verify", "--codegen"]) == 0
    assert "codegen/runtime" not in capsys.readouterr().err


def test_missing_owned_runtime_is_a_clear_error(tmp_path, monkeypatch, capsys) -> None:
    _owned_routes_project(tmp_path, API_CONTRACT, monkeypatch)
    (tmp_path / "codegen" / "runtime" / "filter_parser.py").unlink()
    capsys.readouterr()
    with pytest.raises(FileNotFoundError, match="filter_parser"):
        main(["gen"])
