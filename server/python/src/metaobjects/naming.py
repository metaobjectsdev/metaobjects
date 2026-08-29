"""Physical naming: how a metadata name becomes a database identifier.

The column-naming strategy is CONFIG, not metadata (ADR-0023 does not apply). The same
model has to be able to drive a snake_case Postgres schema and a literal-column one —
which is exactly why it lives beside the persistence layer rather than in the metadata,
and why the byte-gated registry prose for ``@column`` describes the default as coming
"via columnNamingStrategy".

Cross-port siblings, sharing this vocabulary and this algorithm:
  * TypeScript  ``metadata/src/naming.ts``      (``applyColumnNamingStrategy``)
  * C#          ``MetaObjects.Codegen``         (``ColumnNamingStrategy``)
  * Kotlin      ``KotlinGenUtil``               (``applyColumnNamingStrategy``)

**This port's default is ``literal``** — ``@column`` or the field name verbatim — which
is what it has always done. Note that the ports deliberately differ here (TypeScript
defaults to ``snake_case``, the Postgres convention; C# to ``literal``, EF's
property=column convention), so a polyglot project either sets the strategy explicitly
or declares ``@column``.
"""
from __future__ import annotations

from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField

COLUMN_NAMING_SNAKE_CASE = "snake_case"
COLUMN_NAMING_LITERAL = "literal"
COLUMN_NAMING_KEBAB_CASE = "kebab-case"

COLUMN_NAMING_STRATEGIES = (
    COLUMN_NAMING_SNAKE_CASE,
    COLUMN_NAMING_LITERAL,
    COLUMN_NAMING_KEBAB_CASE,
)

#: This port's default. Not the same as TypeScript's — see the module docstring.
DEFAULT_COLUMN_NAMING = COLUMN_NAMING_LITERAL


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


def resolve_column_name(field: MetaField, strategy: str = DEFAULT_COLUMN_NAMING) -> str:
    """THE physical column name for a field: its explicit ``@column`` when present,
    else ``field.name`` through the project's strategy.

    ADR-0039: read RESOLVING — ``@column`` may be inherited through ``extends``.
    """
    col = field.get_meta_attr(fc.FIELD_ATTR_COLUMN)
    if isinstance(col, str) and col:
        return col
    return apply_column_naming_strategy(field.name, strategy)
