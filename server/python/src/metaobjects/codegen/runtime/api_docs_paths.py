"""Doc-page path math for the Python native SDK-docs surface (``api/python``).

Byte-parity with the Java ``DocsPaths`` (server/java/.../apidocs/DocsPaths.java),
the C# ``DocsPaths`` (server/csharp/.../ApiDocs/DocsPaths.cs), and the TS
``docs-paths.ts`` contract: the same layout + relative-href math, so the shared
``fixtures/conformance/api-docs-cross-port/expected-paths.json`` resolves
identically across all ports. Nothing here is Python-specific — it is pure path
math. The api-docs renderer + the ``docs`` command call these helpers; they never
re-derive a path.
"""
from __future__ import annotations

from enum import Enum


class Layout(str, Enum):
    """Doc-page layout: one file per unit (:attr:`FLAT`) or foldered by package
    (:attr:`PACKAGE`)."""

    #: One file per unit at the surface root (``<name>.md``).
    FLAT = "flat"
    #: Foldered by package (``<pkg-folded>/<name>.md``).
    PACKAGE = "package"


def package_to_path(pkg: str | None) -> str:
    """``"acme::shop"`` or ``"acme.shop"`` → ``"acme/shop"``; ``None``/"" → "".`"""
    if not pkg:
        return ""
    return pkg.replace("::", "/").replace(".", "/")


def doc_page_output_path(layout: Layout, pkg: str | None, name: str) -> str:
    """Flat → ``"<name>.md"``; Package → ``"<pkg-folded>/<name>.md"``."""
    file = f"{name}.md"
    if layout == Layout.FLAT:
        return file
    folder = package_to_path(pkg)
    return file if not folder else f"{folder}/{file}"


def surface_cross_href(from_output_path: str, to_output_path: str) -> str:
    """Relative posix href from *from_output_path*'s directory to *to_output_path*
    (mirrors the TS ``surfaceCrossHref``)."""
    slash = from_output_path.rfind("/")
    from_dir = from_output_path[:slash] if slash >= 0 else ""
    rel = _posix_relative(from_dir, to_output_path)
    return rel if rel.startswith(".") else f"./{rel}"


def model_cross_href(
    api_page_path: str, model_page_path: str, model_base_url: str | None = None
) -> str:
    """From an api page to its model page: relative by default, absolute when
    *model_base_url* is set (federated docs)."""
    if model_base_url:
        return f"{model_base_url.rstrip('/')}/{model_page_path}"
    return surface_cross_href(api_page_path, model_page_path)


def _posix_relative(from_dir: str, to_path: str) -> str:
    """``posixpath.relative(from_dir, to_path)``: drop the common prefix, ``..``
    per remaining *from_dir* segment, then the remaining *to_path* segments.
    "" from_dir → to_path; identical → "."."""
    if not from_dir:
        return to_path
    frm = from_dir.split("/")
    to = to_path.split("/")
    common = 0
    cap = min(len(frm), len(to))
    while common < cap and frm[common] == to[common]:
        common += 1
    parts: list[str] = [".."] * (len(frm) - common)
    parts.extend(to[common:])
    return "/".join(parts) if parts else "."
