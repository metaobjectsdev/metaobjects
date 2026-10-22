"""Physical naming: how a metadata name becomes a database identifier (ADR-0058).

The naming rules are CONFIG, not metadata (ADR-0023 does not apply). The same model has
to be able to drive a snake_case Postgres schema and a literal-column one — which is
exactly why they live beside the persistence layer rather than in the metadata.

Cross-port siblings, sharing this vocabulary and this algorithm:
  * TypeScript  ``metadata/src/naming.ts``      (``applyColumnNamingStrategy``)
  * C#          ``MetaObjects.Codegen``         (``ColumnNamingStrategy``)
  * Kotlin      ``KotlinGenUtil``               (``applyColumnNamingStrategy``)

**ADR-0058 — one project setting, read by every port.** ``naming`` in
``.metaobjects/config.json`` (``{"columns": ..., "tables": ...}``) is the ONE place a
project declares its physical-naming rules. Both default to ``snake_case`` — what
``meta migrate`` has always created — in every port, including this one (this port
used to default ``columns`` to ``literal``; that default FLIPPED in 1.1.0, because a
default that disagreed with the database the toolchain itself creates was the defect,
not a feature). The loaded root carries the resolved :class:`NamingRules`
(``MetaRoot.naming``); every resolver reads them from there — see
:func:`naming_rules_of` — never from a CLI flag, a runtime constructor argument, or a
second config key. Every other place a rule used to be configured REFUSES; see
``removed_naming_source_message``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

if TYPE_CHECKING:
    from pathlib import Path

COLUMN_NAMING_SNAKE_CASE = "snake_case"
COLUMN_NAMING_LITERAL = "literal"
COLUMN_NAMING_KEBAB_CASE = "kebab-case"

COLUMN_NAMING_STRATEGIES = (
    COLUMN_NAMING_SNAKE_CASE,
    COLUMN_NAMING_LITERAL,
    COLUMN_NAMING_KEBAB_CASE,
)

#: ADR-0058 — the project default, in every port: what ``meta migrate`` has always
#: created. FLIPPED in 1.1.0 (was ``literal`` in this port only).
DEFAULT_COLUMN_NAMING = COLUMN_NAMING_SNAKE_CASE

#: ADR-0058 — ``tables`` accepts only these two: no ``kebab-case`` table rule.
TABLE_NAMING_SNAKE_CASE = "snake_case"
TABLE_NAMING_LITERAL = "literal"

TABLE_NAMING_RULES = (TABLE_NAMING_SNAKE_CASE, TABLE_NAMING_LITERAL)

#: ADR-0058 — the project default, in every port.
DEFAULT_TABLE_NAMING = TABLE_NAMING_SNAKE_CASE

#: ADR-0058 Decision 4 — the migration guide every removed naming source points at.
#: One named constant: every refusal site below quotes the SAME url.
PHYSICAL_NAMING_MIGRATION_GUIDE_URL = (
    "https://github.com/metaobjectsdev/metaobjects/blob/v1.1.0/"
    "docs/features/migrations/physical-naming.md"
)


def removed_naming_source_message(what: str, value: object) -> str:
    """The refusal every retired column/table-naming source raises (ADR-0058 Decision 4).

    *what* names the source exactly (``--column-naming``, ``ObjectManager(column_naming=...)``,
    ``columnNaming in metaobjects.config.yaml``); *value* is what the caller gave it. Never
    guesses a replacement — the old value may have been right for that adopter's database, and
    silently dropping it would rename every column.
    """
    return (
        f'{what} was removed in 1.1.0. Column and table naming is one project setting now, '
        f'read by every port: "naming" in .metaobjects/config.json, for example '
        f'"naming": {{ "columns": "{value}" }}. Move it there and delete {what}. '
        f"See {PHYSICAL_NAMING_MIGRATION_GUIDE_URL}"
    )


@dataclass(frozen=True)
class NamingRules:
    """ADR-0058 — the resolved ``naming`` block: one project physical-naming setting.

    Carried by the loaded root (``MetaRoot.naming``) so codegen, the runtime and
    ``verify`` all read the SAME values regardless of how they loaded the tree. Trusted
    input — validation happens where the raw ``naming`` JSON is parsed
    (``metaobjects.config.neutral_config``), not here.
    """

    columns: str = DEFAULT_COLUMN_NAMING
    tables: str = DEFAULT_TABLE_NAMING


def naming_rules_of(node: MetaData) -> NamingRules:
    """ADR-0058 — the :class:`NamingRules` in force for *node*: walk to the loaded
    root and read its ``naming`` attribute, defaulting to :class:`NamingRules`'s own
    defaults when the root carries none (a hand-built tree — tests, plugins — or a
    root nobody attached rules to).
    """
    cur: MetaData = node
    while cur.parent is not None:
        cur = cur.parent
    rules = getattr(cur, "naming", None)
    return rules if isinstance(rules, NamingRules) else NamingRules()


def to_snake_case(name: str) -> str:
    """``displayName`` → ``display_name``, ``URLPath`` → ``url_path``.

    Byte-for-byte the algorithm the other ports use: insert ``_`` before an uppercase
    letter preceded by a lowercase letter or digit, OR before an uppercase letter that
    both follows another uppercase and precedes a lowercase (so an acronym splits once,
    ``URLPath`` → ``url_path``, not ``u_r_l_path``). A port-local approximation would put
    the two halves of one schema out of step.
    """
    if not name:
        return name
    out: list[str] = []
    for i, c in enumerate(name):
        if i > 0 and c.isupper():
            prev = name[i - 1]
            nxt = name[i + 1] if i + 1 < len(name) else None
            if prev.islower() or prev.isdigit() or (
                prev.isupper() and nxt is not None and nxt.islower()
            ):
                out.append("_")
        out.append(c.lower())
    return "".join(out)


def apply_column_naming_strategy(name: str, strategy: str = DEFAULT_COLUMN_NAMING) -> str:
    """Apply a strategy to a bare name.

    An unknown strategy RAISES rather than falling back to the default: a typo would
    otherwise bind a whole schema to the wrong columns and report success.
    """
    if strategy == COLUMN_NAMING_LITERAL:
        return name
    if strategy == COLUMN_NAMING_SNAKE_CASE:
        return to_snake_case(name)
    if strategy == COLUMN_NAMING_KEBAB_CASE:
        return to_snake_case(name).replace("_", "-")
    raise ValueError(
        f"unknown column-naming strategy {strategy!r}; "
        f"expected one of: {', '.join(COLUMN_NAMING_STRATEGIES)}"
    )


def resolve_column_name(field: MetaField, strategy: str | None = None) -> str:
    """THE physical column name for a field: its explicit ``@column`` when present,
    else ``field.name`` through the project's naming rule.

    ADR-0039: read RESOLVING — ``@column`` may be inherited through ``extends``.

    ``strategy`` defaults to ``None``, which resolves the rule from *field*'s own
    loaded root (:func:`naming_rules_of` — ADR-0058: the loaded root carries the ONE
    project setting, so codegen and the runtime cannot disagree). Pass an explicit
    value only to probe an ALTERNATE rule against a committed tree (the ``verify
    --codegen`` drift message) — never as a second, independently-configured source.
    """
    col = field.get_meta_attr(fc.FIELD_ATTR_COLUMN)
    if isinstance(col, str) and col:
        return col
    effective = strategy if strategy is not None else naming_rules_of(field).columns
    return apply_column_naming_strategy(field.name, effective)


def strip_package(name: str) -> str:
    """The bare, package-less segment of a metadata name — ``acme::demo::by_name``
    → ``by_name``.

    A metadata name is package-qualified in some ports and not in others (the JVM
    loader spells a nested index name with its package; this one does not), so the
    strip is a no-op here and exists so the RULE holds without a per-port branch.
    """
    return name.rsplit(PACKAGE_SEP, 1)[-1]


def package_of_resolution_key(fqn: str) -> str:
    """The package half of a resolution key — the complement of :func:`strip_package`
    (``a::b::C`` → ``a::b``; a root-level ``C`` → ``""``). Mirrors TS
    ``packageOfResolutionKey``.
    """
    return fqn.rpartition(PACKAGE_SEP)[0]


def resolve_index_name(node: MetaData) -> str:
    """THE database name of an ``identity.secondary`` / ``index.lookup``.

    These nodes carry no ``@column``-style physical spelling — the database name IS
    the metamodel name — which reads like there is nothing to resolve, and is exactly
    how the answer came to be written independently in three places in the TypeScript
    port before ``resolveIndexName`` was made the single door. Nothing to RESTATE is
    not nothing to REFERENCE.

    Two rules the callers did not each carry:

      * a package qualifier is STRIPPED (see :func:`strip_package`);
      * an EMPTY name is REFUSED rather than emitted. That gap is exactly one node
        type wide: an ``identity.*`` with no name is already refused by the loader
        (``ERR_IDENTITY_NAME_REQUIRED`` — identity nodes carry an FR-024 name check so
        a dotted ``extends`` ref can address them), while an ``index.lookup`` is not
        addressable that way and carries no such check, so it loads with ZERO errors
        and reaches the emitters.
    """
    short = strip_package(node.name)
    if not short:
        raise ValueError(
            f"{node.type}.{node.sub_type} declares an empty name; an index's database "
            f"name IS its metamodel name, so there is nothing to emit. Give it a name."
        )
    return short


def load_project_naming(project_dir: "Path") -> NamingRules:
    """ADR-0058 Decision 3 — the ``naming`` rules a PROJECT at *project_dir* declares
    in its ``.metaobjects/config.json``, or the defaults when it declares none / has
    no such file.

    The rung for a runtime that loads metadata from somewhere OTHER than the project
    directory (a packaged resource, a conformance fixture's own metadata directory,
    a classpath): give THIS the project's ``.metaobjects/config.json`` location —
    never read a rule value of your own. See :func:`attach_naming`.

    Local import (not module-level): ``neutral_config`` imports naming constants
    from this module, so importing it back at module scope here would be circular.
    """
    from metaobjects.config.neutral_config import read_neutral_config

    cfg = read_neutral_config(project_dir)
    return cfg.naming if cfg is not None else NamingRules()


def attach_naming(root: MetaData, project_dir: "Path") -> MetaData:
    """Set ``root.naming`` from *project_dir*'s ``.metaobjects/config.json`` and
    return *root*, for a one-line call at a load site that bypasses the CLI's own
    collection-resolution ladder (a conformance runner, a direct
    ``MetaDataLoader.from_directory`` call against a fixture directory).
    """
    root.naming = load_project_naming(project_dir)  # type: ignore[attr-defined]
    return root
