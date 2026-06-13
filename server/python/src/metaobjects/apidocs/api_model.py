"""The Python native SDK api-surface IR (intermediate representation).

Mirrors the Java ``JavaApiModel`` IR (server/java/.../apidocs), the C#
``CSharpApiModel``, and the TS ``api-model.ts``, idiomatic to the Python
(Pydantic / FastAPI / ObjectManager) generated surface: Pydantic model /
``ObjectManager`` data-access / FastAPI routes / validation / extractor /
render helper / payload model / output-format prompt / output parser / filter
allowlist.

NAMES on every symbol come from the :mod:`metaobjects.apidocs.naming` seam (never
re-concatenated in the builder), so what this model documents == what the real
generators emit.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ApiSymbolKind(str, Enum):
    """The generated-category axis a documented symbol belongs to (Python /
    Pydantic + FastAPI flavored)."""

    #: The Pydantic v2 model class (entity) or value-object model.
    MODEL = "model"
    #: Data access — the consumer-implemented repository ``Protocol`` seam.
    DATA_ACCESS = "data_access"
    #: A FastAPI route (named ``"VERB path"``).
    REST = "rest"
    #: Pydantic field validation on the create/update shape.
    VALIDATION = "validation"
    #: The tolerant + strict extractor for a template payload.
    EXTRACTOR = "extractor"
    #: The typed render helper wrapping the render engine.
    RENDER = "render"
    #: The typed payload model bound to a template.
    PAYLOAD = "payload"
    #: The output-format prompt fragment.
    PROMPT = "prompt"
    #: The output parser (``parse_*``) back into the typed payload.
    OUTPUT_PARSER = "output_parser"
    #: The per-entity sort/filter allowlist.
    FILTER = "filter"


@dataclass(frozen=True)
class FieldShape:
    """A documented field: name + Python type + optionality + an optional note
    (e.g. enum values)."""

    name: str
    type: str
    optional: bool
    note: str | None = None


@dataclass(frozen=True)
class UnitExample:
    """A worked example for a unit (reserved for later phases; carried for
    cross-port IR parity)."""

    title: str
    code: str


@dataclass(frozen=True)
class ApiSymbol:
    """One documented symbol of the generated Python SDK surface.

    :param name: the emitted Python identifier (or ``"VERB path"`` for a REST route).
    :param kind: which generated category this symbol belongs to.
    :param module: the import line / module path the symbol lives in.
    :param signature: a human-readable Python signature line.
    :param usage: a one-line "what you use this for".
    :param returns: the symbol's return surface, or ``None``.
    :param fields: per-field shapes for model/validation/payload symbols (may be empty).
    """

    name: str
    kind: ApiSymbolKind
    module: str
    signature: str
    usage: str
    returns: str | None = None
    fields: list[FieldShape] = field(default_factory=list)


@dataclass(frozen=True)
class ApiUnit:
    """One documented unit (an entity / value object, or a template) + its symbols.

    :param node: the unit's short name (the doc-page basename).
    :param package: the unit's metadata package (e.g. ``acme::shop``).
    :param kind: ``"entity"`` | ``"value"`` | ``"template"``.
    :param symbols: the documented symbols, in canonical IR order.
    :param example: an optional unit-level worked example (reserved).
    """

    node: str
    package: str
    kind: str
    symbols: list[ApiSymbol]
    example: UnitExample | None = None


@dataclass(frozen=True)
class ApiModel:
    """The full per-project Python SDK api surface IR."""

    project: str
    units: list[ApiUnit]
