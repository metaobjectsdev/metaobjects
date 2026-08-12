"""prompt_provider — the prompt / AI + serialization MetaDataTypeProvider
(cross-port ``metaobjects-prompt``; FR-004 / FR-006 / FR-010 / FR-011).

EXTENDS the core-registered types with the prompt / AI-domain markers that are
NOT core properties — every one of them PROJECTED and OPTIONAL, onto a type that
stays complete without it:
  - every field subtype: ``@xmlText`` (XML text-content extract), ``@example``,
    ``@instruction`` (FR-010 field-teaching prompt fragment);
  - ``field.enum`` only: ``@enumAlias`` / ``@enumDoc`` / ``@coerceDefault`` /
    ``@normalize`` (FR-010 / FR-011 tolerant-extract overlays);
  - ``object.value`` only: ``@normalize`` (the object-level default normalization
    mode for its enum fields' tolerant extract).

The ``template.prompt`` / ``template.output`` / ``template.toolcall`` attr
vocabulary (``@payloadRef`` / ``@textRef`` / ``@format`` / ``@toolName`` / …) does
**NOT** live here. FR-033 originally re-homed it to this provider, including the
REQUIRED ``@payloadRef`` / ``@toolName`` — that made a core type's validity depend
on an optional provider: compose ``core_providers`` without ``metaobjects-prompt``
and ``template.prompt`` stayed "registered" with zero attrs, so the required-attr
rule silently stopped firing. Those attrs are OWN (the type is invalid without
them) and now register WITH the type in ``core_types.py``, always — see the
``template.*`` block there. Only genuinely OPTIONAL projections belong in a
concern provider; this module's remaining attrs (above) all satisfy that.

``@xmlText`` was previously registered in ``template_provider``; the rest of this
module's attrs were previously registered in ``core_types`` (the field / object
attrs). FR-033 re-homed them here to match the TS provider split (``promptProvider``
renamed from ``templateProvider``), the C# ``PromptMetaDataProvider``, and Java's
prompt concern provider. The attrs + their value-types / required-ness /
allowed-values / defaults are DATA — read from the embedded
``spec/metamodel/prompt.json`` (single-sourced, never hand-copied) via
:func:`load_provider_extends`. The composed registry is UNCHANGED (the manifest is
provider-agnostic) — this only moves WHICH provider registers each attr.

``metaobjects-template`` is kept as a back-compat alias to this provider (the
cross-port fixtures that pre-date the rename still name it; TS's adapter does the
same — see ``adapter.ts`` ``"metaobjects-template": promptProvider``).
"""
from __future__ import annotations

from ...provider import Provider
from ..provider_extends import register_extends
from ...registry import TypeRegistry
from ...shared.base_types import TYPE_FIELD
from ..core.field import field_constants as fc

# The prompt.json ``extends`` directives apply to ``field.*`` (every field subtype),
# ``field.enum`` and ``object.value`` — the template.* attrs are OWN (registered in
# core_types.py, not here; see this module's docstring). register_extends()
# expands the ``"*"`` field subtype to every concrete field subtype (the shared
# FIELD_SUBTYPES tuple — which excludes ``enum`` — PLUS ``field.enum``), mirroring
# db_provider, so the field-teaching + serialization markers reach every field
# including enum.
_FIELD_SUBTYPES: tuple[str, ...] = (*fc.FIELD_SUBTYPES, fc.FIELD_SUBTYPE_ENUM)

#: The embedded shared provider-definition file this provider sources its attrs from.
_PROMPT_DEFINITION_FILE = "prompt.json"


def _register(registry: TypeRegistry) -> None:
    register_extends(
        registry,
        _PROMPT_DEFINITION_FILE,
        field_subtype_expansion={TYPE_FIELD: _FIELD_SUBTYPES},
    )


def _make_prompt_provider() -> Provider:
    p = Provider("metaobjects-prompt", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


prompt_provider = _make_prompt_provider()
