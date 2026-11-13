"""Package-driven output placement — the ONE place Python codegen decides where a generated
module lives and how another generated module imports it.

Mirrors ``codegen-ts``'s ``import-path.ts`` (``entityOutputPath`` / ``crossEntitySpecifier``).
In the ``flat`` layout every function returns exactly the value the generators always wrote,
so flat output is byte-identical. In the ``package`` layout a per-object module lands in a
directory keyed by the object's METADATA package (``acme::alpha`` -> ``acme/alpha/``; a
root-level object stays at the out dir root) and every import between generated modules is
the matching relative import. Shared once-per-run modules (``enums``, the duration wire
module, the ``_runtime`` subpackage, the report export writer) stay at the out dir root.

No generator builds a generated-module path or a relative import by hand; each asks here.
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.codegen.value_objects import local_name, pkg_of
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

OUTPUT_LAYOUT_FLAT = "flat"
OUTPUT_LAYOUT_PACKAGE = "package"
OUTPUT_LAYOUTS: tuple[str, ...] = (OUTPUT_LAYOUT_FLAT, OUTPUT_LAYOUT_PACKAGE)


def package_segments(pkg: str, layout: str) -> list[str]:
    """The directory segments of a metadata package under *layout* (none when flat)."""
    if layout != OUTPUT_LAYOUT_PACKAGE or not pkg:
        return []
    return [s for s in pkg.split(PACKAGE_SEP) if s]


def package_to_path(pkg: str) -> str:
    """``acme::alpha`` -> ``acme/alpha``; the root package -> ``""``."""
    return "/".join(s for s in pkg.split(PACKAGE_SEP) if s) if pkg else ""


def output_path(layout: str, pkg: str, filename: str) -> str:
    """Output path (relative to the out dir) of a per-object generated file."""
    segments = package_segments(pkg, layout)
    return "/".join([*segments, filename])


def module_specifier(layout: str, from_pkg: str, to_pkg: str, module: str) -> str:
    """The relative module specifier (``.Note``, ``..beta.Note``) a module in *from_pkg*
    imports the per-object module *module* of *to_pkg* by."""
    src = package_segments(from_pkg, layout)
    dst = package_segments(to_pkg, layout)
    common = 0
    while common < len(src) and common < len(dst) and src[common] == dst[common]:
        common += 1
    dots = "." * (len(src) - common + 1)
    return dots + ".".join([*dst[common:], module])


def root_module_specifier(layout: str, from_pkg: str, module: str) -> str:
    """The relative specifier a module in *from_pkg* imports a shared out-dir-root module
    (``enums``, ``_duration_wire``, ``_runtime.x``) by."""
    return "." * (len(package_segments(from_pkg, layout)) + 1) + module


def import_line(spec: str, *names: str) -> str:
    return f"from {spec} import {', '.join(names)}"


@dataclass(frozen=True)
class ModuleScope:
    """Where the file being rendered lives: its metadata package *pkg* under *layout*. The
    default is the flat layout at the root, which reproduces today's output byte for byte."""

    layout: str = OUTPUT_LAYOUT_FLAT
    pkg: str = ""

    def sibling(self, to_pkg: str, module: str) -> str:
        """The relative specifier of the per-object module *module* of package *to_pkg*."""
        return module_specifier(self.layout, self.pkg, to_pkg, module)

    def root(self, module: str) -> str:
        """The relative specifier of a shared out-dir-root module."""
        return root_module_specifier(self.layout, self.pkg, module)

    def import_named(self, to_pkg: str, name: str, local: str, suffix: str = "") -> str:
        """``from <spec> import <name><suffix> [as <local><suffix>]``: the model *name* of
        package *to_pkg*, bound under *local* when that differs."""
        spec = self.sibling(to_pkg, name)
        bound, bound_as = f"{name}{suffix}", f"{local}{suffix}"
        return import_line(spec, bound if bound == bound_as else f"{bound} as {bound_as}")

    def import_object(self, obj: MetaData, suffix: str = "") -> str:
        """``from <spec> import <Name><suffix>`` for the object *obj*'s model module, bound
        under its package-qualified alias (``... as AcmeAlphaNote``) when another object
        shares its short name (:func:`~metaobjects.codegen.value_objects.local_name`)."""
        return self.import_named(pkg_of(obj), obj.name, local_name(obj), suffix)
