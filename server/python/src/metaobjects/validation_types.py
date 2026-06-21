"""The validation contract carried by a TypeDefinition — so a type validates itself.

Kept separate from the runner (loader/registered_validation.py) so registry.py can put
these on TypeDefinition without an import cycle. Mirrors the TS validation-types.ts /
Java + C# Validation contracts. See
docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .loader.registered_validation import ValidationContext
    from .meta.meta_data import MetaData


@dataclass(frozen=True)
class ReferenceDescriptor:
    """Declares that one attr on a node is a cross-reference to another node — the
    data-driven half of validation. The registry-derived walk resolves it against the
    symbol table, so a downstream provider's reference validates for free."""

    attr: str
    target_type: str
    target_sub_type: str | None = None
    dotted_field_path: bool = False
    error_code: str = ""


# An imperative validator for a node, carried by its TypeDefinition.
#
# INTENTIONALLY UNUSED BY CORE — do not remove as "dead code": it is an extension point
# (a downstream provider registers a new type with its own validator + error codes — the
# ADR-0023 thesis) and the escape hatch in the config-driven-validation design (#51) for
# novel cross-field rules that fit no declarative shape. Core's per-type validation lives
# in reference descriptors (live) + declarative rule-shapes (#51), not this hook.
NodeValidator = Callable[["MetaData", "ValidationContext"], None]
