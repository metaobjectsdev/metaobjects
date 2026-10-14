"""Deprecated import paths of modules that moved into ``metaobjects.codegen.runtime``.

``metaobjects eject`` hands the emitters a generator writes through to the adopter, and it
copies them from ``metaobjects/codegen/runtime/``, so that is where they live. A copy ejected
before they moved imports them from their old paths; each old path is a one-line module that
calls :func:`alias`, which makes the old name BE the new module (the same object, so private
names and monkeypatching behave as before) and warns once on import. Import from the new path.

The warning is a ``FutureWarning``, not a ``DeprecationWarning``: Python hides a
``DeprecationWarning`` raised inside an imported module by default, and the code importing an
old path here is an adopter's ejected copy, whose author is the one who has to see it.
"""
from __future__ import annotations

import importlib
import sys
import warnings


def alias(old: str, new: str) -> None:
    """Make module *old* the module *new*, warning that the old path is deprecated."""
    warnings.warn(
        f"{old} moved to {new}; import it from there. The old path will be removed in 2.0.",
        FutureWarning,
        stacklevel=3,
    )
    sys.modules[old] = importlib.import_module(new)
