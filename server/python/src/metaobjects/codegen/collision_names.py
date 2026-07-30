"""ADR-0044 — collision-scoped nested-VO name assignment (shared).

Promoted out of ``payload_vo_generator.py`` (formerly the module-private
``_package_qualified_name`` / ``_assign_nested_names``) so every Python generator that
walks a payload's nested-value-object closure derives IDENTICAL emitted names for an
IDENTICAL closure. Today that's the payload-record tier (``payload_vo_generator.py``)
AND the extract/output-parser tier (``extract_delegate_emitter.py`` /
``extractor_generator.py`` / ``output_parser_generator.py``) — a nested class an
extractor module IMPORTS from the sibling payload module must be spelled exactly the
way the payload module itself emitted it, so both tiers MUST share one naming
function rather than re-derive a second (and possibly-diverging) copy (issue #228).

:func:`assign_nested_names` returns BASE names only — a bare short name when it is
unique across the closure, else its package-qualified derived form
(``acme::alpha`` + ``Note`` → ``AcmeAlphaNote``). It never bakes in a suffix; each
caller applies its OWN transform on top of the shared base (the payload tier:
``payload_class_name(base)`` → ``...Payload``; the extract tier: ``f"{base}Extracted"``
for the mirror dataclass, ``f"_to_strict_{snake(base)}"`` / ``f"_from_{snake(base)}
_extracted"`` for the mapper function names) — one pure function of the closure feeds
every naming scheme that must agree on the same base.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping

from metaobjects.errors import ErrorCode
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

#: ADR-0044 backstop error code — REUSED (never redefined) from the shared cross-port
#: error-code ledger (``metaobjects.errors.ErrorCode``), which already carries it.
ERR_PAYLOAD_NAME_COLLISION = ErrorCode.ERR_PAYLOAD_NAME_COLLISION.value


def pascal_segment(name: str) -> str:
    """``priority`` → ``Priority`` (leading char upper-cased only; no snake-splitting)
    — matches the cross-port rule for PascalCasing a bare field/package segment."""
    return name[:1].upper() + name[1:] if name else name


def package_qualified_name(pkg: str, short_name: str) -> str:
    """PascalCase each ``::``-segment of *pkg*, concatenate, append the bare
    *short_name* (``acme::alpha`` + ``Note`` → ``AcmeAlphaNote``). A root-level
    (empty-package) node keeps its bare short name — the loader's own-package
    uniqueness already precludes two root-level nodes sharing a name, so this can't
    silently under-qualify."""
    if pkg == "":
        return short_name
    return "".join(pascal_segment(seg) for seg in pkg.split(PACKAGE_SEP)) + short_name


def _pkg_of(node: MetaData) -> str:
    """The effective package of an object — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level object). Derived from the resolution
    key so it is correct for BOTH loaded trees (file_default_package) and
    programmatically-built trees (package only on the root)."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def assign_nested_names(
    closure: Mapping[str, MetaData],
    class_name_fn: Callable[[str], str] | None = None,
) -> dict[str, str]:
    """ADR-0044 pass 2 — ``resolution_key()`` → emitted name. A PURE function of the
    closure's ``(key, short-name, package)`` triples, never of traversal order: a bare
    short name unique in the closure emits its bare form (byte-identical to
    pre-ADR-0044 output); a short-name collision emits EVERY member under its
    package-qualified derived form. If two distinct keys still derive the same name,
    fails loud with ``ERR_PAYLOAD_NAME_COLLISION`` — never silently collides a second
    time.

    *class_name_fn*, when supplied, transforms each derived BASE name (bare or
    package-qualified) into the caller's final emitted name — e.g.
    ``payload_vo_generator`` passes ``payload_class_name`` (bare ``"Note"`` →
    ``"NotePayload"``) so its own collision backstop message names the actual emitted
    class. Omitted (``None``, the default) → identity, returning bare BASE names — the
    extract tier's callers apply their OWN suffix/transform on top (see module
    docstring) so every naming scheme derives from ONE shared base-assignment pass.
    """
    name_fn: Callable[[str], str] = class_name_fn if class_name_fn is not None else (lambda base: base)

    by_short: dict[str, list[str]] = {}
    for key, node in closure.items():
        by_short.setdefault(node.name, []).append(key)

    name_map: dict[str, str] = {}
    for short, keys in by_short.items():
        if len(keys) == 1:
            name_map[keys[0]] = name_fn(short)
            continue
        for key in keys:
            node = closure[key]
            name_map[key] = name_fn(package_qualified_name(_pkg_of(node), short))

    # Backstop — sorted by key so both the emptiness of the colliding set and the
    # pair named in the message are a pure function of the closure, not dict order.
    owner: dict[str, str] = {}
    for key in sorted(name_map):
        emitted = name_map[key]
        existing = owner.get(emitted)
        if existing is not None and existing != key:
            raise ValueError(
                f"{ERR_PAYLOAD_NAME_COLLISION}: payload record name collision: "
                f'"{emitted}" derives from both "{existing}" and "{key}" — rename one '
                "value-object or move it to a package that derives a distinct name"
            )
        owner[emitted] = key
    return name_map
