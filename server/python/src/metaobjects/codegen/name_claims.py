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
