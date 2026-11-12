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
from typing import TYPE_CHECKING, Callable

from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.meta_data import MetaData
from metaobjects.shared.separators import PACKAGE_SEP

if TYPE_CHECKING:
    from pathlib import Path

COLUMN_NAMING_SNAKE_CASE = "snake_case"
COLUMN_NAMING_LITERAL = "literal"
COLUMN_NAMING_KEBAB_CASE = "kebab-case"
#: ``pascal``: the first letter upper-cased, nothing else changed (``requestURL`` →
#: ``RequestURL``, ``npi`` → ``Npi``), so a camelCase model maps with no ``@column`` onto a
#: schema whose columns are spelled that way (EF Core's default). Not a word split.
COLUMN_NAMING_PASCAL = "pascal"

#: The column rules every port builds in, in the order the conformance corpus lists them.
#: ADR-0058 Amendment 1: the registry (:func:`registered_column_naming_strategies`) is the
#: full set a config may name — these plus the application's.
BUILTIN_COLUMN_NAMING_STRATEGIES = (
    COLUMN_NAMING_SNAKE_CASE,
    COLUMN_NAMING_LITERAL,
    COLUMN_NAMING_KEBAB_CASE,
    COLUMN_NAMING_PASCAL,
)
#: The built-in column rules (kept under its historical name).
COLUMN_NAMING_STRATEGIES = BUILTIN_COLUMN_NAMING_STRATEGIES

#: ADR-0058 — the project default, in every port: what ``meta migrate`` has always
#: created. FLIPPED in 1.1.0 (was ``literal`` in this port only).
DEFAULT_COLUMN_NAMING = COLUMN_NAMING_SNAKE_CASE

#: ADR-0058 — the built-in table rules: no ``kebab-case`` or ``pascal`` table rule.
TABLE_NAMING_SNAKE_CASE = "snake_case"
TABLE_NAMING_LITERAL = "literal"

BUILTIN_TABLE_NAMING_RULES = (TABLE_NAMING_SNAKE_CASE, TABLE_NAMING_LITERAL)
#: The built-in table rules (kept under its historical name).
TABLE_NAMING_RULES = BUILTIN_TABLE_NAMING_RULES

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
    #: The pluralizer an object without ``@collectionName`` takes its collection name from
    #: (``naming.collections``). Not a physical name; it rides here because it is the same
    #: project setting, read the same way.
    collections: str = "standard"


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


def to_pascal_column(name: str) -> str:
    """The ``pascal`` column rule: the first letter upper-cased, the rest verbatim.

    One UTF-16 unit in, one out, as C#'s ``char.ToUpperInvariant`` and Java's
    ``Character.toUpperCase`` do: a first character whose upper case is not one character
    (``ß`` → ``SS``), or that is outside the Basic Multilingual Plane, is kept as written, so
    every port names it alike.
    """
    first = name[:1]
    upper = first.upper()
    if len(upper) != 1 or ord(first) > 0xFFFF:
        upper = first
    return upper + name[1:]


def _to_table_snake_case(s: str) -> str:
    """The built-in ``snake_case`` TABLE rule: ``MyName`` → ``my_name``; ``HTTPServer`` →
    ``http_server`` (mirrors TS ``toSnakeCase`` regex pair, ASCII-only — what this port's
    source naming has always used, kept byte-for-byte when it moved behind the registry)."""
    if not s:
        return s
    # Run 1: split between an uppercase-run and an upper+lower head.
    out: list[str] = []
    n = len(s)
    for i, ch in enumerate(s):
        is_upper = "A" <= ch <= "Z"
        if is_upper and i > 0:
            prev = s[i - 1]
            prev_upper = "A" <= prev <= "Z"
            prev_alnum_lower = ("a" <= prev <= "z") or ("0" <= prev <= "9")
            nxt = s[i + 1] if i + 1 < n else ""
            nxt_lower = "a" <= nxt <= "z"
            if prev_alnum_lower:
                out.append("_")
            elif prev_upper and nxt_lower:
                out.append("_")
        out.append(ch.lower())
    return "".join(out)


#: A naming strategy: a bare metadata name in, a physical name out.
NamingFunction = Callable[[str], str]

#: The port this registry belongs to, as every port's unknown-strategy message names it.
_NAMING_PORT = "Python"

_COLUMN_STRATEGIES: dict[str, NamingFunction] = {
    COLUMN_NAMING_SNAKE_CASE: to_snake_case,
    COLUMN_NAMING_LITERAL: lambda n: n,
    COLUMN_NAMING_KEBAB_CASE: lambda n: to_snake_case(n).replace("_", "-"),
    COLUMN_NAMING_PASCAL: to_pascal_column,
}
_TABLE_RULES: dict[str, NamingFunction] = {
    TABLE_NAMING_SNAKE_CASE: _to_table_snake_case,
    TABLE_NAMING_LITERAL: lambda n: n,
}

#: The pluralizers every port builds in. ``standard`` is the cross-port rule (already-plural
#: detection, then the suffix rule); ``none`` keeps the object name (a project whose collections
#: are named like its objects).
PLURALIZER_STANDARD = "standard"
PLURALIZER_NONE = "none"
BUILTIN_PLURALIZERS = (PLURALIZER_STANDARD, PLURALIZER_NONE)
#: The pluralizer a project gets when ``naming.collections`` is absent.
DEFAULT_PLURALIZER = PLURALIZER_STANDARD


def _standard_pluralize(name: str) -> str:
    # Local import: the API-docs naming module imports this one.
    from metaobjects.apidocs.naming import pluralize

    return pluralize(name)


_PLURALIZERS: dict[str, NamingFunction] = {
    PLURALIZER_STANDARD: _standard_pluralize,
    PLURALIZER_NONE: lambda n: n,
}


def _registry(kind: str) -> dict[str, NamingFunction]:
    return _COLUMN_STRATEGIES if kind == "columns" else _TABLE_RULES if kind == "tables" else _PLURALIZERS


def _builtins(kind: str) -> tuple[str, ...]:
    return (
        BUILTIN_COLUMN_NAMING_STRATEGIES
        if kind == "columns"
        else BUILTIN_TABLE_NAMING_RULES
        if kind == "tables"
        else BUILTIN_PLURALIZERS
    )


class UnknownNamingStrategyError(ValueError):
    """A name no registered naming strategy answers (ADR-0058 Amendment 1)."""


def _kind_label(kind: str) -> str:
    return (
        "column-naming"
        if kind == "columns"
        else "table-naming"
        if kind == "tables"
        else "collection-naming (pluralizer)"
    )


def _register(kind: str, name: str, apply: NamingFunction) -> None:
    builtins = _builtins(kind)
    if not isinstance(name, str) or not name:
        raise ValueError(f"a {_kind_label(kind)} strategy needs a non-empty name")
    if name in builtins:
        raise ValueError(
            f'"{name}" is a built in {_kind_label(kind)} strategy and cannot be replaced; '
            "register yours under another name"
        )
    if not callable(apply):
        raise ValueError(f'{_kind_label(kind)} strategy "{name}" must be a function from a name to a name')
    # Registering a name again replaces it: an application registers once at startup.
    _registry(kind)[name] = apply


def register_column_naming_strategy(name: str, apply: NamingFunction) -> None:
    """ADR-0058 Amendment 1 — register a named column strategy, which
    ``"naming": {"columns": "<name>"}`` in ``.metaobjects/config.json`` then selects exactly as
    it selects a built-in. Register BEFORE the config is read (an application's startup, or the
    module a ``metaobjects`` command imports first). Wrapping a built-in is one line::

        register_column_naming_strategy(
            "pascal-acronyms", lambda n: "NPI" if n == "npi" else column_naming_strategy("pascal")(n))

    A built-in name cannot be replaced; registering a name of your own again replaces it.
    """
    _register("columns", name, apply)


def register_table_naming_rule(name: str, apply: NamingFunction) -> None:
    """Register a named table rule; see :func:`register_column_naming_strategy`."""
    _register("tables", name, apply)


def register_pluralizer(name: str, apply: NamingFunction) -> None:
    """Register a named pluralizer: an object name (Pascal, as declared) in, its collection name
    out. ``"naming": {"collections": "<name>"}`` selects it; see
    :func:`register_column_naming_strategy`."""
    _register("collections", name, apply)


def registered_pluralizers() -> tuple[str, ...]:
    """Every registered pluralizer: the built-ins, then the application's."""
    return tuple(_PLURALIZERS)


def pluralizer(name: str) -> NamingFunction:
    """The pluralizer registered as *name*; raises like :func:`column_naming_strategy`."""
    fn = _PLURALIZERS.get(name)
    if fn is None:
        raise UnknownNamingStrategyError(unknown_naming_strategy_message("collections", name))
    return fn


def reset_naming_strategies_for_testing() -> None:
    """TEST-ONLY: forget every strategy the application registered, leaving the built-ins. The
    registry is process-wide, so a test that registers one resets it when it is done rather than
    leaving it for the next test to find. Not for production code."""
    for name in [n for n in _COLUMN_STRATEGIES if n not in BUILTIN_COLUMN_NAMING_STRATEGIES]:
        del _COLUMN_STRATEGIES[name]
    for name in [n for n in _TABLE_RULES if n not in BUILTIN_TABLE_NAMING_RULES]:
        del _TABLE_RULES[name]
    for name in [n for n in _PLURALIZERS if n not in BUILTIN_PLURALIZERS]:
        del _PLURALIZERS[name]


def registered_column_naming_strategies() -> tuple[str, ...]:
    """Every registered column strategy: the built-ins in corpus order, then the application's."""
    return tuple(_COLUMN_STRATEGIES)


def registered_table_naming_rules() -> tuple[str, ...]:
    """Every registered table rule: the built-ins, then the application's."""
    return tuple(_TABLE_RULES)


def unknown_naming_strategy_message(kind: str, name: str) -> str:
    """What every port says when a config names a strategy no registered strategy answers:
    the same words in every port, with that port's name. *kind* is ``columns``, ``tables`` or
    ``collections``.
    """
    builtins = _builtins(kind)
    registered = [n for n in _registry(kind) if n not in builtins]
    return (
        f'"naming.{kind}" names "{name}", which no {_kind_label(kind)} strategy registered in the '
        f"{_NAMING_PORT} port answers (built in: {', '.join(builtins)}; registered by the "
        f"application: {', '.join(registered) if registered else 'none'}). Register it before "
        ".metaobjects/config.json is read, or correct the name."
    )


def column_naming_strategy(name: str) -> NamingFunction:
    """The column strategy registered as *name*; raises :class:`UnknownNamingStrategyError`
    naming it when nothing answers it."""
    fn = _COLUMN_STRATEGIES.get(name)
    if fn is None:
        raise UnknownNamingStrategyError(unknown_naming_strategy_message("columns", name))
    return fn


def table_naming_rule(name: str) -> NamingFunction:
    """The table rule registered as *name*; raises like :func:`column_naming_strategy`."""
    fn = _TABLE_RULES.get(name)
    if fn is None:
        raise UnknownNamingStrategyError(unknown_naming_strategy_message("tables", name))
    return fn


def apply_column_naming_strategy(name: str, strategy: str = DEFAULT_COLUMN_NAMING) -> str:
    """Apply a strategy — a built-in or an application-registered one — to a bare name: the
    one door every column resolution in this port goes through.

    An unknown strategy RAISES rather than falling back to the default: a typo would
    otherwise bind a whole schema to the wrong columns and report success.
    """
    return column_naming_strategy(strategy)(name)


def apply_table_naming_rule(name: str, rule: str = DEFAULT_TABLE_NAMING) -> str:
    """*name* cased by the table rule registered as *rule* (never pluralized — that is a
    separate, frozen step). Raises on a name nothing registered."""
    return table_naming_rule(rule)(name)


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


def resolve_flattened_column_prefix(field: MetaField, strategy: str | None = None) -> str:
    """The text before each member's column when *field* (a ``field.object @storage
    "flattened"``) expands its value object into the owning table: its
    ``@flattenedColumnPrefix`` verbatim (``""`` allowed), else its own resolved column and
    ``_``. Core naming, not one generator's: the migration creates these columns and the
    generated ORM mappings address them, so every port spells them the same way.

    ADR-0039: read RESOLVING — the prefix and ``@column`` may be inherited through
    ``extends``. ``strategy`` as for :func:`resolve_column_name`.
    """
    prefix = field.get_meta_attr(fc.FIELD_ATTR_FLATTENED_COLUMN_PREFIX)
    if isinstance(prefix, str):
        return prefix
    return resolve_column_name(field, strategy) + "_"


def resolve_flattened_column_name(
    field: MetaField, member: MetaField, strategy: str | None = None
) -> str:
    """The column a member of a flattened value object gets in the owning table: the
    embedding field's :func:`resolve_flattened_column_prefix` followed by the member's own
    resolved column. The member's rule is the embedding field's, so one project setting
    names both halves."""
    effective = strategy if strategy is not None else naming_rules_of(field).columns
    return resolve_flattened_column_prefix(field, effective) + resolve_column_name(member, effective)


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
