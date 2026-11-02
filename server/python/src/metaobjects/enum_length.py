"""The column length of a string-stored ``field.enum``: its ``@maxLength``, else the project's
``enums.maxLength`` (in ``.metaobjects/config.json``, carried on the loaded root beside the
naming rules), else none — an unbounded text column. Mirrors TS ``enum-length.ts``."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .errors import ErrorCode, ParseError
from .meta.core.field.field_constants import (
    FIELD_ATTR_INT_VALUE_MAP,
    FIELD_ATTR_MAX_LENGTH,
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
)
from .shared.base_types import TYPE_OBJECT

if TYPE_CHECKING:
    from .meta.meta_data import MetaData


@dataclass(frozen=True)
class EnumDefaults:
    """The resolved ``enums`` block. ``max_length`` is the column length of a string-stored
    enum that declares no ``@maxLength``; ``None`` means no default."""

    max_length: int | None = None


def enum_defaults_of(node: "MetaData") -> EnumDefaults:
    """The enum defaults for the tree *node* belongs to: what its root carries, else none."""
    cur = node
    while cur.parent is not None:
        cur = cur.parent
    defaults = getattr(cur, "enum_defaults", None)
    return defaults if isinstance(defaults, EnumDefaults) else EnumDefaults()


def resolve_enum_max_length(field: "MetaData") -> int | None:
    """The column length of *field*, a string-stored ``field.enum``: its ``@maxLength``
    (ADR-0039 — resolving), else the project default, else ``None``. ``None`` for an
    ``@intValueMap`` enum, whose column is an integer, and for any other field.

    The loader refuses an ``@maxLength`` a member does not fit; it does not see the project
    config, so a member longer than the project DEFAULT is refused here
    (``ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH``), by every consumer that sizes the column.
    """
    if field.sub_type != FIELD_SUBTYPE_ENUM or field.get_meta_attr(FIELD_ATTR_INT_VALUE_MAP) is not None:
        return None
    own = field.get_meta_attr(FIELD_ATTR_MAX_LENGTH)
    if isinstance(own, int) and not isinstance(own, bool):
        return own
    fallback = enum_defaults_of(field).max_length
    if fallback is None:
        return None
    values = field.get_meta_attr(FIELD_ATTR_VALUES)
    members = [v for v in (values if isinstance(values, list) else []) if isinstance(v, str)]
    longest = max(members, key=len, default=None)
    if longest is not None and len(longest) > fallback:
        owner = field.parent
        label = f"{owner.name}.{field.name}" if owner is not None and owner.type == TYPE_OBJECT else field.name
        raise ParseError(
            f'field.enum "{label}" has the member "{longest}" ({len(longest)} characters), longer '
            f"than the project's enums.maxLength {fallback}. Give the field its own @maxLength of "
            f"at least {len(longest)}, raise enums.maxLength, or shorten the member.",
            code=ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH,
        )
    return fallback


def attach_enum_defaults(root: "MetaData", project_dir: Path) -> "MetaData":
    """Set ``root.enum_defaults`` from *project_dir*'s ``.metaobjects/config.json`` and return
    *root*, for a load site that bypasses the CLI's collection ladder."""
    from .config.neutral_config import read_neutral_config

    cfg = read_neutral_config(project_dir)
    root.enum_defaults = cfg.enums if cfg is not None else EnumDefaults()  # type: ignore[attr-defined]
    return root
