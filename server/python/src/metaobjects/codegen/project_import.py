"""Import a ``module:symbol`` the project owns, relative to a project root.

ONE resolver for both places that name project code by ``module:symbol``: an owned generator
(:func:`metaobjects.codegen.eject.build_owned`) and a config hook (``requirementTests.renderer``
and ``requirementTests.filter``). It puts the project root on ``sys.path`` and drops a module
cached from ANOTHER project, so two projects in one process (a test run, a long-lived tool) cannot
read each other's copy.

What it never drops is a module that is not a project's: an installed package (``metaobjects``
itself, the standard library). A cached module is stale only when it lives under a project root
this resolver put on the path earlier and not under the current one.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any

#: Every project root this resolver has put on ``sys.path`` in this process.
_PROJECT_ROOTS: set[str] = set()


def _origins(module: object) -> list[str]:
    """The directories or files a cached module was loaded from (a namespace package has no ``__file__``)."""
    file = getattr(module, "__file__", None)
    if file is not None:
        return [str(Path(file).resolve())]
    return [str(Path(p).resolve()) for p in getattr(module, "__path__", [])]


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _is_stale(module: object, root: str) -> bool:
    origins = _origins(module)
    if any(_under(o, root) for o in origins):
        return False
    return any(_under(o, other) for o in origins for other in _PROJECT_ROOTS if other != root)


def import_project_symbol(module_name: str, symbol: str, root: Path) -> tuple[Any, str | None]:
    """``(object, None)``, or ``(None, message)`` naming the module (and the symbol) and the real
    cause: the message of whatever the import raised, or which attribute is missing."""
    root_str = str(root.resolve())
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    _PROJECT_ROOTS.add(root_str)
    top = module_name.split(".")[0]
    for key in [k for k in sys.modules if k == top or k.startswith(top + ".")]:
        if _is_stale(sys.modules[key], root_str):
            del sys.modules[key]
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # ImportError and anything raised at import time
        return None, f"cannot import {module_name!r}: {exc}"
    obj = getattr(module, symbol, None)
    if obj is None:
        return None, f"{module_name!r} has no attribute {symbol!r}"
    return obj, None
