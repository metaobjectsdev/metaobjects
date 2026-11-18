"""The project ``api`` setting: what a generated REST route does at its edges.

``api`` in ``.metaobjects/config.json`` is read by the same port-neutral reader as ``naming`` and
``wire`` and carried by the loaded root (``MetaRoot.api``); codegen reads it with :func:`api_of`.

* ``api.pagination`` (``{"defaultLimit": N, "maxLimit": M}``): a list route with no ``limit`` returns
  ``defaultLimit`` rows, and a ``limit`` above ``maxLimit`` is refused with
  ``400 {"error": "limit_too_large", "maxLimit": M}``. Absent, a route behaves as it always has.
* ``api.unknownFields`` (``"reject"`` | ``"drop"``): what a generated create, PUT or PATCH does with
  a body key the entity declares no field for. ``reject`` (the default) answers
  ``400 {"error": "unknown_fields", "fields": [...]}``; ``drop`` ignores the key.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from metaobjects.meta.meta_data import MetaData

API_KEY_PAGINATION = "pagination"
API_KEY_UNKNOWN_FIELDS = "unknownFields"
PAGINATION_KEY_DEFAULT_LIMIT = "defaultLimit"
PAGINATION_KEY_MAX_LIMIT = "maxLimit"

UNKNOWN_FIELDS_REJECT = "reject"
UNKNOWN_FIELDS_DROP = "drop"
UNKNOWN_FIELDS_MODES = (UNKNOWN_FIELDS_REJECT, UNKNOWN_FIELDS_DROP)

#: What a fresh ``init`` writes.
INIT_DEFAULT_LIMIT = 50
INIT_MAX_LIMIT = 1000


@dataclass(frozen=True)
class ApiPagination:
    default_limit: int
    max_limit: int


@dataclass(frozen=True)
class ApiSettings:
    """The resolved ``api`` block. Trusted input: validated where the raw JSON is parsed."""

    pagination: ApiPagination | None = None
    unknown_fields: str = UNKNOWN_FIELDS_REJECT


def api_of(node: "MetaData") -> ApiSettings:
    """The :class:`ApiSettings` in force for *node*: the loaded root's, or the default."""
    cur = node
    while cur.parent is not None:
        cur = cur.parent
    api = getattr(cur, "api", None)
    return api if isinstance(api, ApiSettings) else ApiSettings()
