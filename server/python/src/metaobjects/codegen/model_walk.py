"""Everything a generator written from scratch needs, in one import (ADR-0034 Amendment 4).

MetaObjects' product is the core; the outputs an application needs beyond the reference
generators — OpenAPI, JSON Schema, a client, docs — are generators the adopter writes. A
generator is any object with a ``name`` and a ``generate(ctx) -> list[EmittedFile]``; wire it
as ``module:symbol`` in ``--generators`` or in ``metaobjects.config.yaml``'s
``targets.<name>.generators`` and ``metaobjects gen`` runs it and ``metaobjects verify
--codegen`` drift-gates it. See ``docs/recipes/write-your-own-generator.md``.

These helpers answer the questions whose right answer is a rule the engine already owns.
Before this module they were spread over five internal modules, one of them private, and the
obvious spelling of several was wrong:

* **Python's ``attr(name)`` is OWN-ONLY** (ADR-0039's naming inversion). A field that inherits
  ``@maxLength`` or ``@required`` through ``extends`` reads ``None`` through it. Read effective
  values with ``node.attrs().get(name)`` — or the helpers below, which do.
* ``field.is_array`` is the raw own flag; :func:`field_is_array` resolves.
* An ``@objectRef`` is resolved package-locally (ADR-0042), never by short name.
"""
from __future__ import annotations

from typing import Any

from metaobjects.apidocs.naming import route_path
from metaobjects.codegen.generator import (
    EmittedFile,
    GenContext,
    Generator,
    once_per_run,
    per_entity,
    per_model,
    per_package,
)
from metaobjects.codegen.instance_artifacts import is_abstract
from metaobjects.codegen.template_codegen.template_data import package_of
from metaobjects.codegen.type_map import effective_enum_values, field_is_array
from metaobjects.codegen.value_objects import object_ref_target
from metaobjects.meta.core.field.field_constants import FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_REQUIRED
from metaobjects.naming import to_snake_case

__all__ = [
    "EmittedFile",
    "GenContext",
    "Generator",
    "description",
    "enum_values",
    "field_is_array",
    "is_abstract",
    "is_required",
    "max_length",
    "object_ref_target",
    "once_per_run",
    "package_of",
    "per_entity",
    "per_model",
    "per_package",
    "primary_key_fields",
    "route_path",
    "to_snake_case",
]

_TYPE_VALIDATOR = "validator"
_VALIDATOR_REQUIRED = "required"
_DOC_DESCRIPTION = "description"
_IDENTITY_FIELDS = "fields"


def is_required(field: Any) -> bool:
    """Effective required-ness: ``@required: true`` or a ``validator.required`` child, own or
    inherited through ``extends`` — the same rule the neutral template data uses."""
    if field.attrs().get(FIELD_ATTR_REQUIRED) is True:
        return True
    return any(c.type == _TYPE_VALIDATOR and c.sub_type == _VALIDATOR_REQUIRED for c in field.children())


def max_length(field: Any) -> int | None:
    """Effective ``@maxLength``, or ``None``."""
    v = field.attrs().get(FIELD_ATTR_MAX_LENGTH)
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def enum_values(field: Any) -> list[str]:
    """A ``field.enum``'s effective ``@values`` (empty when absent)."""
    return effective_enum_values(field)


def description(node: Any) -> str | None:
    """The node's effective ``@description``, or ``None``."""
    v = node.attrs().get(_DOC_DESCRIPTION)
    return v if isinstance(v, str) else None


def primary_key_fields(obj: Any) -> list[str]:
    """The primary identity's field names, own or inherited (empty when none)."""
    identity = obj.primary_identity()
    if identity is None:
        return []
    v = identity.attrs().get(_IDENTITY_FIELDS)
    if isinstance(v, str):
        return [s.strip() for s in v.split(",") if s.strip()]
    return [str(x) for x in v] if isinstance(v, (list, tuple)) else []
