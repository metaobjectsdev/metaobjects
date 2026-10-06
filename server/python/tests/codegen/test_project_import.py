"""``import_project_symbol`` — the one resolver for ``module:symbol`` a project owns.

Used by ``eject.build_owned`` (an owned generator) and by the config hooks
(``requirementTests.renderer`` / ``.filter``). Each test builds real project roots on disk, so
what is asserted is which COPY of a module the resolver hands back when several projects (or an
installed package) offer the same dotted name in one process.
"""
from __future__ import annotations

import importlib
import re
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


def test_a_standard_library_module_stays_loaded_when_a_project_package_shadows_its_name(tmp_path: Path) -> None:
    stdlib_json = sys.modules["json"]
    project = _shadowing_project(tmp_path / "project", "json")
    obj, err = import_project_symbol("json", "dumps", project)
    assert obj is None and err is not None and "shadows a standard-library module" in err
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
    _who(a)
    assert sys.path.count(str(a.resolve())) == 1  # inserted once, resolved, never duplicated


# ---------------------------------------------------------------------------
# An installed package (outside every project) named by several hooks is ONE module.
# ---------------------------------------------------------------------------


def _outside_package(tmp_path: Path, name: str = "outside_hooks") -> Path:
    site = tmp_path / "site"
    (site / name).mkdir(parents=True)
    (site / name / "__init__.py").write_text(
        "RUNS = globals().get('RUNS', 0) + 1\n\ndef a():\n    return 'a'\n\ndef b():\n    return 'b'\n"
    )
    return site


def test_two_symbols_of_the_same_outside_module_come_from_the_same_module_object(tmp_path: Path) -> None:
    site = _outside_package(tmp_path)
    sys.path.insert(0, str(site))
    project = tmp_path / "project"
    project.mkdir()
    a, err_a = import_project_symbol("outside_hooks", "a", project)
    b, err_b = import_project_symbol("outside_hooks", "b", project)
    assert (err_a, err_b) == (None, None)
    assert a.__module__ == b.__module__ == "outside_hooks"
    assert sys.modules["outside_hooks"].a is a and sys.modules["outside_hooks"].b is b


def test_a_module_imported_before_the_call_is_the_one_returned_when_the_project_does_not_offer_the_name(
    tmp_path: Path,
) -> None:
    site = _outside_package(tmp_path)
    sys.path.insert(0, str(site))
    before = importlib.import_module("outside_hooks")
    project = tmp_path / "project"
    project.mkdir()
    obj, err = import_project_symbol("outside_hooks", "a", project)
    assert err is None and obj is before.a  # type: ignore[attr-defined]
    assert sys.modules["outside_hooks"] is before


# ---------------------------------------------------------------------------
# A project package that shadows a standard-library module is refused, deterministically.
# ---------------------------------------------------------------------------


def _shadowing_project(root: Path, name: str) -> Path:
    (root / name).mkdir(parents=True)
    (root / name / "__init__.py").write_text("")
    return root


def _refusal(name: str, project: Path) -> str:
    obj, err = import_project_symbol(f"{name}.generators.thing", "WHO", project)
    assert obj is None and err is not None
    return err


@pytest.mark.parametrize("loaded", [True, False])
def test_a_project_package_named_like_a_standard_library_module_is_refused_whether_or_not_it_is_loaded(
    tmp_path: Path, loaded: bool
) -> None:
    if loaded:
        name = "types"
        assert name in sys.modules
    else:
        name = next(n for n in ("sched", "colorsys", "wave", "mailcap") if n not in sys.modules)
        assert name not in sys.modules  # a stdlib name NOT yet imported in this process
    project = _shadowing_project(tmp_path / "project", name)
    err = _refusal(name, project)
    assert f"the project package {name!r}" in err
    assert "shadows a standard-library module" in err and "rename it" in err
    assert err.startswith(f"cannot import '{name}.generators.thing': ")
    # Refused before importing anything: no project module was imported, the stdlib one is untouched.
    assert not any(k.startswith(f"{name}.generators") for k in sys.modules)


def test_the_same_refusal_text_is_given_for_a_loaded_and_an_unloaded_standard_library_name(
    tmp_path: Path,
) -> None:
    loaded = _refusal("types", _shadowing_project(tmp_path / "a", "types"))
    unloaded_name = next(n for n in ("sched", "colorsys", "wave", "mailcap") if n not in sys.modules)
    unloaded = _refusal(unloaded_name, _shadowing_project(tmp_path / "b", unloaded_name))
    def shape(text: str, name: str) -> str:  # the project path in the message differs per project
        return re.sub(r"\(.*?\)", "()", text).replace(name, "X")

    assert shape(loaded, "types") == shape(unloaded, unloaded_name)


def test_a_real_standard_library_symbol_with_no_such_directory_in_the_project_keeps_working(
    tmp_path: Path,
) -> None:
    (tmp_path / "project").mkdir()
    stdlib_json = sys.modules["json"]
    obj, err = import_project_symbol("json", "dumps", tmp_path / "project")
    assert err is None and obj is stdlib_json.dumps and sys.modules["json"] is stdlib_json


# ---------------------------------------------------------------------------
# Existing behaviour that this resolver does NOT change (see the module docstring).
# ---------------------------------------------------------------------------


def test_a_project_with_no_such_package_silently_gets_the_one_a_previous_project_left_on_sys_path(
    tmp_path: Path,
) -> None:
    """EXISTING behaviour, pinned and not endorsed: project A's directory stays on `sys.path`,
    so project B, which has no `codegen` at all, is answered with A's."""
    a = _project(tmp_path / "a", "A")
    (tmp_path / "b").mkdir()
    assert _who(a) == "A"
    assert _who(tmp_path / "b") == "A"


def test_a_namespace_layout_in_the_project_loses_to_a_regular_package_earlier_loaded_from_sys_path(
    tmp_path: Path,
) -> None:
    """EXISTING behaviour, pinned and not endorsed: B has `codegen/generators/thing.py` with no
    `__init__.py` anywhere, but a regular package later on `sys.path` beats a namespace portion."""
    a = _project(tmp_path / "a", "A")
    b = tmp_path / "b"
    (b / "codegen" / "generators").mkdir(parents=True)
    (b / "codegen" / "generators" / "thing.py").write_text("WHO = 'B'\n")
    assert _who(a) == "A"
    assert _who(b) == "A"
