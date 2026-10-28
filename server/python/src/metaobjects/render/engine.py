"""Which template engine a body is written for (ADR-0061).

Mustache is the default and the cross-port engine. Jinja is a per-port second engine
(Python and TypeScript): a body is Jinja when its FILE says so — a ``.jinja`` / ``.j2`` /
``.jinja2`` extension beside the usual ``.mustache`` — or when the caller says so with an
explicit ``engine``. The metadata never names an engine: ``@textRef`` stays a logical
``group/source`` reference, so the portable vocabulary carries nothing one port
understands and another does not. Mirrors ``server/typescript/packages/render/src/engine.ts``.
"""

from __future__ import annotations

from typing import Any

TEMPLATE_ENGINE_MUSTACHE = "mustache"
TEMPLATE_ENGINE_JINJA = "jinja"

#: The engines ``render`` and ``verify`` accept.
TEMPLATE_ENGINES = (TEMPLATE_ENGINE_MUSTACHE, TEMPLATE_ENGINE_JINJA)

#: The Mustache file extension — the default in every port.
MUSTACHE_EXTENSION = ".mustache"

#: File extensions that mark a body as Jinja, in lookup order.
JINJA_EXTENSIONS = (".jinja", ".j2", ".jinja2")


def engine_for_extension(extension: str) -> str:
    """The engine a file extension (with its leading dot) selects. Anything else is Mustache."""
    return TEMPLATE_ENGINE_JINJA if extension.lower() in JINJA_EXTENSIONS else TEMPLATE_ENGINE_MUSTACHE


def template_engine_of(provider: Any, ref: str | None, explicit: str | None = None) -> str:
    """The engine for ``ref`` resolved through ``provider``: an explicit choice wins, then
    what the provider knows about the ref (its ``engine_of``, from the file extension), then
    Mustache. ``engine_of`` is optional on a provider."""
    if explicit is not None:
        if explicit not in TEMPLATE_ENGINES:
            raise ValueError(f"unknown template engine {explicit!r}; expected one of {TEMPLATE_ENGINES}")
        return explicit
    engine_of = getattr(provider, "engine_of", None)
    if ref is not None and callable(engine_of):
        known = engine_of(ref)
        if known is not None:
            return str(known)
    return TEMPLATE_ENGINE_MUSTACHE


__all__ = [
    "JINJA_EXTENSIONS",
    "MUSTACHE_EXTENSION",
    "TEMPLATE_ENGINES",
    "TEMPLATE_ENGINE_JINJA",
    "TEMPLATE_ENGINE_MUSTACHE",
    "engine_for_extension",
    "template_engine_of",
]
