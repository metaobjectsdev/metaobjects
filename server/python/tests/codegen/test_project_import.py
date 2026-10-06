"""``import_project_symbol`` — the one resolver for ``module:symbol`` a project owns.

Used by ``eject.build_owned`` (an owned generator) and by the config hooks
(``requirementTests.renderer`` / ``.filter``). Each test builds real project roots on disk, so
what is asserted is which COPY of a module the resolver hands back when several projects (or an
installed package) offer the same dotted name in one process.
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Iterator

import pytest

import metaobjects
import metaobjects.codegen.requirement_walk  # noqa: F401 — loaded, so the tests can hold it
from metaobjects.codegen.project_import import import_project_symbol


_PROJECT_NAMES = ("codegen", "outer_pkg")


def _is_project_name(name: str) -> bool:
    return any(name == top or name.startswith(top + ".") for top in _PROJECT_NAMES)


@pytest.fixture(autouse=True)
def _restore_import_state() -> Iterator[None]:
    """Each test starts as a fresh process would (no project package cached by an earlier test)
    and leaves the import state it found."""
    path = list(sys.path)
    held = {k: v for k, v in sys.modules.items() if _is_project_name(k)}
    before = set(sys.modules) - set(held)
    for name in held:
        del sys.modules[name]
    try:
        yield
    finally:
        sys.path[:] = path
        for name in set(sys.modules) - before:
            del sys.modules[name]
        sys.modules.update(held)
        importlib.invalidate_caches()


def _project(root: Path, who: str, top: str = "codegen") -> Path:
    """A project root holding ``<top>/generators/thing.py`` with ``WHO = <who>``."""
    package = root / top / "generators"
    package.mkdir(parents=True)
    (root / top / "__init__.py").write_text("")
    (package / "__init__.py").write_text("")
    (package / "thing.py").write_text(f"WHO = {who!r}\n")
    return root


def _who(root: Path, top: str = "codegen") -> object:
    obj, err = import_project_symbol(f"{top}.generators.thing", "WHO", root)
    assert err is None, err
    return obj


def test_the_same_dotted_name_under_two_roots_resolves_in_the_root_asked_for(tmp_path: Path) -> None:  # (a)
    a, b = _project(tmp_path / "a", "A"), _project(tmp_path / "b", "B")
    assert _who(a) == "A"
    assert _who(b) == "B"


def test_a_module_another_route_cached_from_root_a_is_not_served_for_root_b(tmp_path: Path) -> None:  # (b)
    """`_config_providers` puts a config dir on `sys.path` and imports with plain importlib,
    never through this resolver; the next project must still get ITS copy."""
    a, b = _project(tmp_path / "a", "A"), _project(tmp_path / "b", "B")
    sys.path.insert(0, str(a))
    assert importlib.import_module("codegen.generators.thing").WHO == "A"  # type: ignore[attr-defined]
    assert _who(b) == "B"


def test_a_top_level_name_already_imported_from_outside_any_project_is_replaced_by_the_projects(
    tmp_path: Path,
) -> None:  # (d), first half: what the old rule did for an owned generator
    site = tmp_path / "site"
    (site / "outer_pkg").mkdir(parents=True)
    (site / "outer_pkg" / "__init__.py").write_text("WHO = 'outside'\n")
    sys.path.insert(0, str(site))
    assert importlib.import_module("outer_pkg").WHO == "outside"  # type: ignore[attr-defined]

    project = tmp_path / "project"
    (project / "outer_pkg").mkdir(parents=True)
    (project / "outer_pkg" / "__init__.py").write_text("WHO = 'project'\n")
    obj, err = import_project_symbol("outer_pkg", "WHO", project)
    assert (obj, err) == ("project", None)


def test_the_running_metaobjects_package_is_never_unloaded_even_when_a_project_shadows_it(
    tmp_path: Path,
) -> None:  # (d), second half
    package = sys.modules["metaobjects"]
    walk = sys.modules["metaobjects.codegen.requirement_walk"]
    shadow = tmp_path / "project"
    (shadow / "metaobjects").mkdir(parents=True)
    (shadow / "metaobjects" / "__init__.py").write_text("WHO = 'shadow'\n")
    obj, err = import_project_symbol(
        "metaobjects.codegen.requirement_walk", "default_requirement_test_filter", shadow
    )
    assert err is None and callable(obj)
    assert sys.modules["metaobjects"] is package and package is metaobjects
    assert sys.modules["metaobjects.codegen.requirement_walk"] is walk


def test_a_symbol_inside_the_running_package_resolves_from_a_project_with_no_such_directory(
    tmp_path: Path,
) -> None:
    (tmp_path / "project").mkdir()
    walk = sys.modules["metaobjects.codegen.requirement_walk"]
    obj, err = import_project_symbol(
        "metaobjects.codegen.requirement_walk", "default_requirement_test_filter", tmp_path / "project"
    )
    assert err is None and obj is walk.default_requirement_test_filter
    assert sys.modules["metaobjects"] is metaobjects


def test_a_standard_library_module_is_never_unloaded(tmp_path: Path) -> None:
    stdlib_json = sys.modules["json"]
    project = tmp_path / "project"
    (project / "json").mkdir(parents=True)
    (project / "json" / "__init__.py").write_text("dumps = 'shadow'\n")
    obj, err = import_project_symbol("json", "dumps", project)
    assert err is None and obj is stdlib_json.dumps
    assert sys.modules["json"] is stdlib_json


def test_root_a_again_after_its_file_changed_still_serves_the_cached_module(tmp_path: Path) -> None:  # (c)
    """EXISTING behaviour, pinned and not endorsed: a module cached from the SAME root is not
    reloaded, so an edit made after the first import is not seen in this process."""
    a = _project(tmp_path / "a", "A1")
    assert _who(a) == "A1"
    (a / "codegen" / "generators" / "thing.py").write_text("WHO = 'A2'\n")
    assert _who(a) == "A1"


def test_a_missing_symbol_and_a_module_that_raises_name_the_module_and_the_real_cause(tmp_path: Path) -> None:
    a = _project(tmp_path / "a", "A")
    obj, err = import_project_symbol("codegen.generators.thing", "NOPE", a)
    assert obj is None and err == "'codegen.generators.thing' has no attribute 'NOPE'"
    (a / "codegen" / "generators" / "boom.py").write_text("raise RuntimeError('it blew up')\n")
    obj, err = import_project_symbol("codegen.generators.boom", "x", a)
    assert obj is None and err == "cannot import 'codegen.generators.boom': it blew up"


def test_a_path_that_merely_starts_with_the_root_is_not_under_it(tmp_path: Path) -> None:
    """`/tmp/x/a2` is not inside `/tmp/x/a`: a string-prefix test would keep A2's cached copy."""
    a, a2 = _project(tmp_path / "a", "A"), _project(tmp_path / "a2", "A2")
    assert _who(a2) == "A2"
    assert _who(a) == "A"


def test_the_sys_path_entry_is_the_resolved_root(tmp_path: Path) -> None:
    a = _project(tmp_path / "a", "A")
    _who(a)
    assert str(a.resolve()) in sys.path
    json.dumps(sys.path)  # a plain list of str
