"""Import a ``module:symbol`` the project owns, relative to a project root.

ONE resolver for both places that name project code by ``module:symbol``: an owned generator
(:func:`metaobjects.codegen.eject.build_owned`) and a config hook (``requirementTests.renderer``
and ``requirementTests.filter``). It puts the project root on ``sys.path`` and imports.

THE RULE, in one sentence: a cached module of the spec's top-level name is dropped before the
import only when it does not live under this project's root AND this root offers that top-level
name (``<root>/<name>/`` or ``<root>/<name>.py``), and then the project's copy is the one
imported, except that the running ``metaobjects`` package is never dropped, and a project name
that is also a standard-library module name is refused outright.

Why: two projects in one process (a test run, a long-lived tool) can offer the same dotted name,
and a config provider is imported with plain ``importlib`` and never registers anything here, so
"under the current root" is the test, not "under some other root we know of". Why only when the
root offers the name: a package the project does NOT provide (an installed hook package) is one
module for every hook that names it, and is never unloaded or re-imported.

A project package named like a standard-library module (``types/``, ``json/``, ``queue/``) is
refused with an error naming it, before anything is imported, whether or not the standard-library
module is already loaded: the import system would otherwise answer by load order.

What it does NOT do, all as before:
* A module cached from THIS root is kept: an edit made after the first import is not seen.
* Returning to root A after root B loaded B's copy loads B's copy again.
* Project B that has no such package at all is silently answered with project A's, because A's
  module is still cached in ``sys.modules`` (it is served even after A's directory has left
  ``sys.path``).
* Project B that has the package only as a namespace layout (no ``__init__.py``) still gets A's
  regular package, because a regular package later on ``sys.path`` beats a namespace portion.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any

#: The package this module belongs to: running code the resolver must never unload, however a
#: project shadows it.
_RUNNING_PACKAGE = __name__.partition(".")[0]


def _offered_at(root: Path, top: str) -> Path | None:
    """Where the project provides the top-level name: its package directory, else its module
    file, else ``None`` when it offers no such name."""
    if (root / top).is_dir():
        return root / top
    if (root / f"{top}.py").is_file():
        return root / f"{top}.py"
    return None


def _is_under(module: object, root: Path) -> bool:
    """Whether the module was loaded from a file under *root*. A module with no file (a
    namespace package, a built-in) is not."""
    file = getattr(module, "__file__", None)
    if file is None:
        return False
    return Path(file).resolve().is_relative_to(root)


def import_project_symbol(module_name: str, symbol: str, root: Path) -> tuple[Any, str | None]:
    """``(object, None)``, or ``(None, message)`` naming the module (and the symbol) and the real
    cause: the message of whatever the import raised, which attribute is missing, or that the
    project package or module shadows a standard-library module."""
    resolved = root.resolve()
    top = module_name.split(".")[0]
    offered_at = _offered_at(resolved, top)
    offered = offered_at is not None
    if offered_at is not None and top in sys.stdlib_module_names:
        kind = "package" if offered_at.is_dir() else "module"
        return None, (
            f"cannot import {module_name!r}: the project {kind} {top!r} ({offered_at}) shadows a "
            f"standard-library module of the same name; rename it"
        )
    if str(resolved) not in sys.path:
        sys.path.insert(0, str(resolved))
    if offered and top != _RUNNING_PACKAGE:
        for key in [k for k in sys.modules if k == top or k.startswith(top + ".")]:
            if not _is_under(sys.modules[key], resolved):
                del sys.modules[key]
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # ImportError and anything raised at import time
        return None, f"cannot import {module_name!r}: {exc}"
    obj = getattr(module, symbol, None)
    if obj is None:
        return None, f"{module_name!r} has no attribute {symbol!r}"
    return obj, None
