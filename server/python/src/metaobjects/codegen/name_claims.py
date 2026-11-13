"""The run's one claim registry (amending ADR-0044 and ADR-0056).

Every module a generator emits into a shared scope is claimed here, at the point it is
emitted: the scope is the generated package directory, the name is the emitted module (and
so class) name, the claimant is the metadata node's ``resolution_key()``. The first claimant
owns a name; a second claimant of the same name in the same scope is refused with
``ERR_NAME_COLLISION``, naming both metadata nodes and the remedy. The same claimant claiming
again is not a collision, and one name in two scopes is two names.

A generator that emits nothing for an object claims nothing, so the check follows the wiring
by construction. A name is never rewritten to avoid a collision: a value object's type is its
own name. Mirrors ``codegen-ts``'s ``GenContext.claim`` / ``naming/name-claims.ts``.

``ERR_NAME_COLLISION`` is a codegen-time, port-local code (C# and TypeScript declare the same
value); it is not in the loader's shared error-code ledger.
"""
from __future__ import annotations

import keyword

from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.import_path import OUTPUT_LAYOUT_PACKAGE, output_path, package_to_path

ERR_NAME_COLLISION = "ERR_NAME_COLLISION"

#: What the author can do about a clash in the flat layout, where every module shares one directory.
FLAT_REMEDY = (
    'rename one, or set output_layout: "package" to place each object in the directory of its '
    "metadata package"
)
#: Under the package layout two packages never clash, so a clash is two nodes in ONE package.
PACKAGE_REMEDY = "rename one"


class NameClaims:
    """The names one run's generators have emitted, by scope. One per ``run_gen``."""

    def __init__(self) -> None:
        self._owners: dict[tuple[str, str], str] = {}

    def claim(self, scope: str, name: str, claimant: str, remedy: str) -> None:
        key = (scope, name)
        existing = self._owners.get(key)
        if existing is None:
            self._owners[key] = claimant
            return
        if existing == claimant:
            return
        raise ValueError(
            f'{ERR_NAME_COLLISION}: "{existing}" and "{claimant}" both generate "{name}" '
            f"in {scope} — {remedy}."
        )


def module_scope_label(config: GenConfig, pkg: str) -> str:
    """The claim scope of a module's directory: the generated package directory it lands in."""
    directory = package_to_path(pkg) if config.output_layout == OUTPUT_LAYOUT_PACKAGE else ""
    return f'the generated package directory "{directory or "."}"'


def claim_module(claims: NameClaims, config: GenConfig, pkg: str, module: str, claimant: str) -> None:
    """Claim *module* (a generated module's stem) in the directory *pkg* maps to."""
    remedy = PACKAGE_REMEDY if config.output_layout == OUTPUT_LAYOUT_PACKAGE else FLAT_REMEDY
    claims.claim(module_scope_label(config, pkg), module, claimant, remedy)


def claimed_module_path(
    claims: NameClaims, config: GenConfig, pkg: str, module: str, claimant: str
) -> str:
    """Claim the generated module *module* in the directory of *pkg* and return its output
    path (``<dir>/<module>.py``): the one call a generator makes to place a per-object file."""
    claim_module(claims, config, pkg, module, claimant)
    return output_path(config.output_layout, pkg, f"{module}.py")


def assert_importable_package_tree(paths: list[str]) -> None:
    """Refuse a generated tree Python cannot import as written (out-dir-relative *paths*).

    Under the package layout each metadata package segment is a directory and a component of a
    relative import, so it must be a Python identifier and not a keyword (``my-co`` would emit
    ``from ..my-co.Note import Note``). And a directory beside a module of the same stem shadows
    it: a top-level package ``enums`` makes ``enums/`` win over the shared ``enums.py``, so every
    ``from ..enums import X`` reads the wrong module. Both are refused here, before any write.
    """
    modules = {p[: -len(".py")] for p in paths if p.endswith(".py")}
    directories: set[str] = set()
    for p in paths:
        if not p.endswith(".py"):
            continue
        d = p.rsplit("/", 1)[0] if "/" in p else ""
        while d:
            directories.add(d)
            d = d.rsplit("/", 1)[0] if "/" in d else ""
    for d in sorted(directories):
        segment = d.rsplit("/", 1)[-1]
        if not segment.isidentifier() or keyword.iskeyword(segment):
            raise ValueError(
                f'the generated package directory "{d}" is not importable: "{segment}" is not a '
                "Python identifier, so a relative import through it cannot be written — rename "
                "the metadata package segment, or use the flat layout."
            )
        if d in modules:
            raise ValueError(
                f'{ERR_NAME_COLLISION}: the generated package directory "{d}/" and the module '
                f'"{d}.py" have one import name, and the directory shadows the module — '
                f"{PACKAGE_REMEDY} (the metadata package or the object)."
            )

