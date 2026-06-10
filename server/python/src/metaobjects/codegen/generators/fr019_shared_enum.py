"""FR-019 — shared + externally-provided enum resolution (Python port of the TS reference
``enum-shared.ts`` and the C#/Java/Kotlin ``Fr019SharedEnum``).

A reusable enum is a ROOT/package-level abstract ``field.enum`` (a sibling of ``object.entity``)
that concrete entity fields ``extends``. Per ADR-0026 such a declaration is materialized ONCE per
port as a module-level ``class <Name>(str, Enum)`` and referenced, instead of redeclaring the
members inline (a per-entity ``Literal[...]``) in every consumer.

Two cases on the abstract declaration:

* non-``@provided`` → metaobjects MATERIALIZES the type once (a shared ``enums.py`` module), and
  consuming fields reference it (``from .enums import <Name>``).
* ``@provided: true`` → metaobjects emits NOTHING for the type; consuming fields import an existing
  type from a per-port-configured module (``GenConfig.provided_enum_packages`` keyed by the enum's
  declaring metadata package, then the ``provided_enum_namespace`` fallback). The module never lives
  in metadata (ADR-0001); a missing config for a referenced provided enum is a codegen-time error
  naming the enum + its package.

The common inline case (a concrete ``field.enum`` with own ``@values``, no root-extends) is
UNCHANGED — it stays a per-entity ``Literal[...]`` (byte-identical default).
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.base_types import TYPE_METADATA
from metaobjects.shared.separators import PACKAGE_SEP
from metaobjects.codegen import type_map
from metaobjects.codegen.config import GenConfig


@dataclass(frozen=True)
class SharedEnum:
    """A shared (package-level abstract) enum declaration codegen reasons about."""

    name: str            #: materialized type name — the decl's PascalCase short name (cross-port id)
    values: list[str]    #: member symbols (the @values SSOT), verbatim
    provided: bool       #: True when the decl carries @provided: true (reference, don't materialize)
    meta_package: str    #: declaring metadata package in "::" form (the provided-config key)


def _pascal(name: str) -> str:
    """``priority`` → ``Priority`` (leading char only; no snake-splitting — cross-port rule)."""
    return name[:1].upper() + name[1:] if name else name


def resolve_shared_enum_decl(field: MetaField) -> MetaData | None:
    """The package-level abstract ``field.enum`` *field* resolves to via ``extends``, or ``None``
    for an inline enum. Qualifies only when the immediate super is (a) a ``field.enum``,
    (b) abstract, AND (c) a direct child of the metadata root — a sibling of ``object.entity``,
    not an abstract field nested inside an object."""
    if field.sub_type != fc.FIELD_SUBTYPE_ENUM:
        return None
    sup = field.super_data
    if sup is None or sup.sub_type != fc.FIELD_SUBTYPE_ENUM:
        return None
    if not getattr(sup, "is_abstract", False):
        return None
    parent = sup.parent
    if parent is None or parent.type != TYPE_METADATA:
        return None
    return sup


def is_provided(decl: MetaData) -> bool:
    """Own ``@provided`` truth of an enum declaration."""
    return decl.attr(fc.FIELD_ATTR_PROVIDED) is True


def _meta_package_of(decl: MetaData) -> str:
    """The decl's metadata package in ``::`` form (its resolution key minus the trailing name)."""
    key = decl.resolution_key()
    idx = key.rfind(PACKAGE_SEP)
    return key[:idx] if idx >= 0 else ""


def shared_enum_for_field(field: MetaField) -> SharedEnum | None:
    """The shared-enum descriptor *field* resolves to, or ``None`` for inline enums."""
    decl = resolve_shared_enum_decl(field)
    if decl is None:
        return None
    values = type_map.effective_enum_values(field)
    if not values:
        return None
    return SharedEnum(
        name=_pascal(decl.name),
        values=values,
        provided=is_provided(decl),
        meta_package=_meta_package_of(decl),
    )


def collect_shared_enums(entities: list) -> list[SharedEnum]:
    """All shared (package-level abstract) enum decls CONSUMED by at least one entity field,
    keyed by materialized type name, sorted by name (deterministic). A decl nobody extends is
    not materialized (no dangling type)."""
    out: dict[str, SharedEnum] = {}
    for entity in entities:
        for f in entity.own_fields():
            shared = shared_enum_for_field(f)
            if shared is None:
                continue
            out.setdefault(shared.name, shared)
    return sorted(out.values(), key=lambda e: e.name)


def materialized_shared_enums(entities: list) -> list[SharedEnum]:
    """The shared enums metaobjects MATERIALIZES (non-``@provided``, consumed)."""
    return [e for e in collect_shared_enums(entities) if not e.provided]


def enum_type_and_import(shared: SharedEnum, config: GenConfig) -> tuple[str, str]:
    """The ``(type_name, import_line)`` a consuming field emits for a shared/provided enum:

    * materialized → ``("<Name>", "from .enums import <Name>")`` (the shared module).
    * ``@provided`` → ``("<Name>", "from <module> import <Name>")``, *module* resolved from
      ``config.provided_enum_packages`` (keyed by the enum's metadata package) then the single
      ``config.provided_enum_namespace`` fallback. A missing config is a codegen-time ``ValueError``
      naming the enum + its package (ADR-0026 / ADR-0001)."""
    name = shared.name
    if not shared.provided:
        return name, f"from .enums import {name}"
    module = config.provided_enum_packages.get(shared.meta_package) or config.provided_enum_namespace
    if not module:
        raise ValueError(
            f'provided enum "{name}" (declared in package "{shared.meta_package}") is marked '
            f"@provided but no Python import module is configured to reference it from. Map its "
            f'package in GenConfig.provided_enum_packages["{shared.meta_package}"] = '
            f'"your_app.enums", or set the single provided_enum_namespace fallback, so the '
            f'generated code can import "{name}".'
        )
    return name, f"from {module} import {name}"
