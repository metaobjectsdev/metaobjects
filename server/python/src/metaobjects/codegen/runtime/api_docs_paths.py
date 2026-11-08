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


def index_label(name: str, pkg: str | None, siblings: list[str]) -> str:
    """The index label of a page: its short name, or ``"<name> (<package>)"`` when another
    unit in the same list shares that name (case-insensitively), so the index tells the two
    apart. *siblings* is the whole list, this unit included. Mirrors the TS ``docIndexLabel``."""
    shared = sum(1 for n in siblings if n.lower() == name.lower()) > 1
    return f"{name} ({pkg})" if shared and pkg else name


def assert_no_duplicate_doc_paths(placements: list[tuple[str, str]]) -> None:
    """Refuse two pages that resolve to the same output path, compared case-insensitively:
    macOS and Windows hold ``ProductNdc.md`` and ``ProductNDC.md`` as one file, so one page
    would silently replace the other. Each placement is (path, the node's FQN). Mirrors the TS
    ``assertNoDuplicateDocPaths``."""
    seen: dict[str, tuple[str, str]] = {}
    for path, fqn in placements:
        prior = seen.get(path.lower())
        if prior is not None:
            if prior[0] == path:
                raise ValueError(
                    f'docs: duplicate output path "{path}" from nodes {prior[1]} and {fqn} — '
                    "rename one of them."
                )
            raise ValueError(
                f'docs: output paths "{prior[0]}" ({prior[1]}) and "{path}" ({fqn}) differ only '
                "in case — one file on a case-insensitive filesystem (macOS, Windows), so one page "
                "would replace the other. Rename one of them."
            )
        seen[path.lower()] = (path, fqn)


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
