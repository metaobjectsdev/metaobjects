"""Credential fields (#484): a field declaring or inheriting a ``view.password`` child."""
from __future__ import annotations

from typing import TYPE_CHECKING

from ...presentation.view.view_constants import VIEW_SUBTYPE_PASSWORD
from ....shared.base_types import TYPE_VIEW

if TYPE_CHECKING:
    from .meta_field import MetaField


def is_credential_field(field: "MetaField") -> bool:
    """True iff *field* declares (or inherits) a ``view.password`` child. RESOLVING
    ``children()`` (ADR-0039), so an inherited ``view.password`` counts."""
    return any(c.type == TYPE_VIEW and c.sub_type == VIEW_SUBTYPE_PASSWORD for c in field.children())
