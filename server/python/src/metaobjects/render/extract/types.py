"""FR-010 extract model + report.

Frozen cross-port vocabularies (``FieldExtraction``, ``FieldKind``, ``Tolerance``,
``Format``) plus the immutable schema/option/outcome dataclasses and the mutable
``ExtractionReport`` accumulator.

The corpus serializes ``FieldExtraction`` with SCREAMING_SNAKE values
(``EXTRACTED`` / ``DEFAULTED`` / ``LOST_OPTIONAL`` / ``LOST_REQUIRED`` /
``MALFORMED``) and ``Format`` / ``FieldKind`` as UPPER tokens; the conformance
runner maps the schema-json tokens onto these enums.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Generic, TypeVar

from metaobjects.render.extract.normalize import DEFAULT as _NORMALIZE_DEFAULT

T = TypeVar("T")

# A bespoke per-field coercion hook: (field_path, raw_value, spec) -> coerced | None.
# Returning ``None`` falls through to the default coercion. Forward-referenced as a
# string in ExtractOptions to avoid a forward-declaration cycle with FieldSpec.
OnField = Callable[[str, str, "FieldSpec"], object | None]
Normalizer = Callable[[str], object | None]


class Format(Enum):
    """Document format the extract pipeline targets."""

    JSON = "JSON"
    XML = "XML"


class FieldKind(Enum):
    """The coercion target kinds the engine understands. ``OBJECT`` = nested schema."""

    STRING = "STRING"
    INT = "INT"
    LONG = "LONG"
    DOUBLE = "DOUBLE"
    BOOLEAN = "BOOLEAN"
    ENUM = "ENUM"
    OBJECT = "OBJECT"


class FieldExtraction(Enum):
    """FROZEN cross-port per-field extraction classification.

    Do not reorder or add without an ADR. Values match the corpus serialization.
    """

    EXTRACTED = "EXTRACTED"
    # FR-011: a value reached via @coerceDefault (present-but-uncoercible fallback)
    # or @default (absent-fill) — distinct from a cleanly EXTRACTED value.
    DEFAULTED = "DEFAULTED"
    LOST_OPTIONAL = "LOST_OPTIONAL"
    LOST_REQUIRED = "LOST_REQUIRED"
    MALFORMED = "MALFORMED"


class Tolerance(Enum):
    """STRICT: case-sensitive, minimal repair. NORMAL: case-insensitive (default). LOOSE: maximal repair.

    NOTE: LOOSE currently behaves identically to NORMAL (case-insensitive). Reserved
    for future maximal-repair behavior.
    """

    STRICT = "STRICT"
    NORMAL = "NORMAL"
    LOOSE = "LOOSE"


@dataclass(frozen=True, slots=True)
class Coercion:
    """A recorded normalization/coercion.

    ``kind`` e.g. ``"normalize"``, ``"alias"``, ``"runtime-alias-override"``,
    ``"clamp"``, ``"coerceDefault"``, ``"default"``.
    """

    field_path: str
    from_: str
    to: str
    kind: str


@dataclass(frozen=True, slots=True)
class FieldSpec:
    """One field's extract descriptor.

    ``enum_values``/``enum_alias`` non-None only for ENUM; ``min``/``max`` non-None
    only for numeric range constraints; ``nested`` non-None only for OBJECT.
    """

    name: str
    kind: FieldKind
    required: bool = False
    array: bool = False
    enum_values: list[str] | None = None
    enum_alias: dict[str, str] | None = None
    min: float | None = None
    max: float | None = None
    nested: "ExtractSchema | None" = None
    # FR-011: present-but-uncoercible fallback member (from ``@coerceDefault``).
    # ENUM-only; None = none.
    coerce_default: str | None = None
    # FR-011: absent-fill member (from ``@default``). ENUM-only; None = none.
    default_value: str | None = None
    # FR-011: resolved enum normalization mode (from ``@normalize``; default ``"strip"``).
    normalize: str = _NORMALIZE_DEFAULT
    # ``@xmlText``: this field receives its element's TEXT CONTENT (analogous to JAXB
    # ``@XmlValue`` / Jackson ``@JacksonXmlText`` / .NET ``[XmlText]``). The extract engine
    # reads it from the ``#text`` sentinel the lenient XML reader carries when an element has
    # both attributes and a text body, instead of a same-named child. False for normal/JSON.
    text_content: bool = False

    @staticmethod
    def scalar(
        name: str,
        kind: FieldKind,
        required: bool,
        default_value: str | None = None,
    ) -> "FieldSpec":
        """Phase B (generalized ``@default``): a scalar field optionally carrying an
        absent-fill ``@default``. When the field is ABSENT, tolerant extract coerces
        this string to ``kind`` (via the pure ``scalar_coerce``) and classifies the
        field DEFAULTED (which satisfies ``required``). ``default_value is None`` is
        the no-default case (back-compat)."""
        return FieldSpec(
            name=name, kind=kind, required=required, default_value=default_value
        )

    @staticmethod
    def text_content_field(name: str, kind: FieldKind, required: bool) -> "FieldSpec":
        """A field that receives its element's TEXT CONTENT — the ``@xmlText`` marker
        (see ``text_content``). A scalar with the flag set; coerced to ``kind``."""
        return FieldSpec(name=name, kind=kind, required=required, text_content=True)

    @staticmethod
    def scalar_array(name: str, kind: FieldKind, required: bool) -> "FieldSpec":
        """A scalar-array FieldSpec (``array == True``); each element is coerced via
        the scalar pipeline. No per-element default fill."""
        return FieldSpec(name=name, kind=kind, required=required, array=True)

    @staticmethod
    def enum_array(
        name: str,
        required: bool,
        values: list[str] | None,
        aliases: dict[str, str] | None,
        coerce_default: str | None = None,
        normalize: str = _NORMALIZE_DEFAULT,
        default_value: str | None = None,
    ) -> "FieldSpec":
        """Phase B (array-of-enum): an enum field that is a ``list[enum]``
        (``array == True``). Each element flows through the SAME enum pipeline a
        scalar enum uses (exact → normalize → ``@enumAlias`` → ``@coerceDefault`` →
        MALFORMED) and is classified independently by indexed path (``tags[0]``,
        ``tags[1]``, …). Mirrors :meth:`enum_field` but with ``array = True``."""
        return FieldSpec(
            name=name,
            kind=FieldKind.ENUM,
            required=required,
            array=True,
            enum_values=None if values is None else list(values),
            enum_alias={} if aliases is None else dict(aliases),
            coerce_default=coerce_default,
            default_value=default_value,
            normalize=normalize,
        )

    @staticmethod
    def enum_field(
        name: str,
        required: bool,
        values: list[str] | None,
        aliases: dict[str, str] | None,
        coerce_default: str | None = None,
        normalize: str = _NORMALIZE_DEFAULT,
        default_value: str | None = None,
    ) -> "FieldSpec":
        return FieldSpec(
            name=name,
            kind=FieldKind.ENUM,
            required=required,
            enum_values=None if values is None else list(values),
            enum_alias={} if aliases is None else dict(aliases),
            coerce_default=coerce_default,
            default_value=default_value,
            normalize=normalize,
        )

    @staticmethod
    def range_(
        name: str,
        kind: FieldKind,
        required: bool,
        min: float | None,
        max: float | None,
    ) -> "FieldSpec":
        return FieldSpec(name=name, kind=kind, required=required, min=min, max=max)

    @staticmethod
    def object_(
        name: str,
        required: bool,
        array: bool,
        nested: "ExtractSchema | None",
    ) -> "FieldSpec":
        return FieldSpec(
            name=name,
            kind=FieldKind.OBJECT,
            required=required,
            array=array,
            nested=nested,
        )


@dataclass(frozen=True, slots=True)
class ExtractSchema:
    """Top-level extract descriptor.

    ``root_name`` = the XML root tag / logical JSON root name.
    """

    format: Format
    root_name: str
    fields: list[FieldSpec] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ExtractOptions:
    """Bounded runtime override surface (the "20%").

    ``aliases``/``normalizers`` are MERGED with the schema's, runtime winning on key
    conflict. ``on_field`` is the single bespoke-coercion hook.
    """

    tolerance: Tolerance = Tolerance.NORMAL
    aliases: dict[str, str] = field(default_factory=dict)
    normalizers: dict[str, Normalizer] = field(default_factory=dict)
    on_field: OnField | None = None

    @staticmethod
    def defaults() -> "ExtractOptions":
        return ExtractOptions()

    def with_tolerance(self, t: Tolerance) -> "ExtractOptions":
        return ExtractOptions(
            tolerance=t,
            aliases=dict(self.aliases),
            normalizers=dict(self.normalizers),
            on_field=self.on_field,
        )


@dataclass(frozen=True, slots=True)
class ExtractionOutcome:
    """Engine return.

    ``data`` is a forgiving ``dict[str, object]``; Plan 2 wraps it into a typed
    ``ExtractionResult``.
    """

    data: dict[str, object]
    report: "ExtractionReport"


@dataclass(frozen=True, slots=True)
class ExtractionResult(Generic[T]):
    """Typed result of a generated ``extract(...)``: best-effort value + report."""

    data: T | None
    report: "ExtractionReport"


class ExtractionReport:
    """Mutable accumulator of per-field classification, the empty flag, and coercion notes."""

    def __init__(self) -> None:
        self._states: dict[str, FieldExtraction] = {}
        self._coercions: list[Coercion] = []
        self._empty: bool = False

    def set(self, field_path: str, state: FieldExtraction) -> None:
        self._states[field_path] = state

    def add_coercion(self, c: Coercion) -> None:
        self._coercions.append(c)

    def mark_empty(self) -> None:
        self._empty = True

    def is_empty(self) -> bool:
        return self._empty

    def states(self) -> dict[str, FieldExtraction]:
        return dict(self._states)

    def coercions(self) -> list[Coercion]:
        return list(self._coercions)

    def lost_required(self) -> list[str]:
        return self._by_state(FieldExtraction.LOST_REQUIRED)

    def malformed(self) -> list[str]:
        return self._by_state(FieldExtraction.MALFORMED)

    def has_lost_required(self) -> bool:
        return len(self.lost_required()) > 0

    def _by_state(self, s: FieldExtraction) -> list[str]:
        return [k for k, v in self._states.items() if v == s]
