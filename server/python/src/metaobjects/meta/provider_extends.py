"""FR-033 (provider re-home) — the shared bridge that lets a DATA-DRIVEN concern
provider (``metaobjects-ui`` / ``metaobjects-prompt``) register its attrs onto the
core-registered types by reading the embedded ``spec/metamodel/<file>.json``.

A provider declares NO new types — it only ``registry.extend``s existing ones with
the attrs the shared JSON ``extends`` directives scope to each ``(type, subType)``.
This keeps the attrs (names, value-types, required-ness, allowed-values, defaults)
single-sourced from the cross-port JSON rather than hand-copied — exactly the
duplication FR-033 kills — and mirrors the TS ``applyProviderDefinition`` apply
path's ``extends`` handling.

A ``subType: "*"`` directive (e.g. ui.json's ``@filterable`` on ``field.*``) is
expanded to every concrete subtype of that type via the caller-supplied
``field_subtype_expansion`` map (the provider owns its FIELD_SUBTYPES tuple, the
same way ``db_provider`` / ``prompt_provider`` do).
"""
from __future__ import annotations

from ..registry import AttrSchema, TypeRegistry
from ..spec_metamodel import AttrEntry, ExtendsTarget, load_provider_extends

#: The wildcard subtype token used in the JSON ``extends`` matchers.
_WILDCARD = "*"


def attr_schema_from_entry(entry: AttrEntry) -> AttrSchema:
    """Build a fully-specified :class:`AttrSchema` from a JSON ``extends`` attr entry.

    ``value_type`` is the JSON ``subType``; ``required`` is derived from the JSON
    cardinality (``min == 1``); ``is_array`` / ``allowed_values`` / ``default`` carry
    straight through. The ``description`` (+ rules/example/whenToUse) is left to the
    registry's :func:`apply_spec_descriptions` pass (which re-sources it from the same
    JSON post-compose), exactly as for the core-registered attrs."""
    return AttrSchema(
        name=entry.name,
        value_type=entry.sub_type,
        required=entry.required,
        allowed_values=entry.allowed_values,
        default=entry.default,
        is_array=entry.is_array,
    )


def register_extends(
    registry: TypeRegistry,
    file_name: str,
    *,
    field_subtype_expansion: dict[str, tuple[str, ...]] | None = None,
) -> None:
    """Read the embedded ``spec/metamodel/<file_name>`` and ``registry.extend`` each
    of its ``extends`` directives onto the matching core-registered ``(type, subType)``.

    ``field_subtype_expansion`` maps a type name to the concrete subtype tuple a
    ``subType: "*"`` directive expands to (the provider supplies its own FIELD_SUBTYPES,
    mirroring db_provider / prompt_provider). A wildcard directive for a type NOT in
    the map is an error (no provider should emit one we can't expand).

    ``registry.extend`` is additive and raises ``ERR_PROVIDER_ATTR_CONFLICT`` if an
    attr is already declared on the target — the double-registration guard. Because
    FR-033 removed the re-homed attrs from ``core_types``, no conflict occurs."""
    expansion = field_subtype_expansion or {}
    for target in load_provider_extends(file_name):
        sub_types = _expand_subtypes(target, expansion)
        schemas = [attr_schema_from_entry(a) for a in target.attrs]
        for st in sub_types:
            registry.extend(target.type, st, attributes=schemas)


def _expand_subtypes(
    target: ExtendsTarget, expansion: dict[str, tuple[str, ...]]
) -> tuple[str, ...]:
    if target.sub_type != _WILDCARD:
        return (target.sub_type,)
    subtypes = expansion.get(target.type)
    if subtypes is None:
        raise ValueError(
            f'register_extends: wildcard subType "*" on type "{target.type}" has no '
            f"field_subtype_expansion mapping (cannot expand a wildcard extend)."
        )
    return subtypes
