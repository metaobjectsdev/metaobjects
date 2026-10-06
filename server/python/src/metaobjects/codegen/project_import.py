"""Import a ``module:symbol`` the project owns, relative to a project root.

ONE resolver for both places that name project code by ``module:symbol``: an owned generator
(:func:`metaobjects.codegen.eject.build_owned`) and a config hook (``requirementTests.renderer``
and ``requirementTests.filter``). It puts the project root on ``sys.path`` and imports.

THE RULE, in one sentence: a cached module of the spec's top-level package that does not live
under this project's root is dropped before the import, so the project's own copy is the one
imported, except the running ``metaobjects`` package and the standard library, which are never
dropped.

Why dropped, whoever cached it: two projects in one process (a test run, a long-lived tool) can
offer the same dotted name, and a config provider is imported with plain ``importlib`` and never
registers anything here. The test is therefore "not under the current root", not "under some
other root we know of", so a route added later that puts a project on ``sys.path`` cannot defeat
it. What it does NOT do, as before: a module cached from THIS root is kept (an edit made after
the first import is not seen), and asking for root A again after root B loaded B's copy loads
B's copy again.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any

#: The package this module belongs to: running code the resolver must never unload, however a
#: project shadows it.
_RUNNING_PACKAGE = __name__.partition(".")[0]


def _must_stay_loaded(top: str) -> bool:
    return top == _RUNNING_PACKAGE or top in sys.stdlib_module_names


def _is_under(module: object, root: Path) -> bool:
    """Whether the module was loaded from a file under *root*. A module with no file (a
    namespace package, a built-in) is not."""
    file = getattr(module, "__file__", None)
    if file is None:
        return False
    return Path(file).resolve().is_relative_to(root)


def import_project_symbol(module_name: str, symbol: str, root: Path) -> tuple[Any, str | None]:
    """``(object, None)``, or ``(None, message)`` naming the module (and the symbol) and the real
    cause: the message of whatever the import raised, or which attribute is missing."""
    resolved = root.resolve()
    if str(resolved) not in sys.path:
        sys.path.insert(0, str(resolved))
    top = module_name.split(".")[0]
    if not _must_stay_loaded(top):
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
