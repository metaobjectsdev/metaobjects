"""FR5a / ADR-0009 — ErrorSource discriminated union + envelope types.

Closed hierarchy over the provenance variants a metadata node or error can
carry. The cross-port realization in Python uses ``@dataclass(frozen=True)`` so
each variant is value-equal, hashable, and immutable.

Pattern-match on the concrete subtype (``isinstance(src, JsonSource)``) to
access variant-specific fields, or read ``src.format`` for the discriminant
tag.

Mirrors:
    * TS  — `server/typescript/packages/metadata/src/source.ts`
    * C#  — `server/csharp/MetaObjects/Source/ErrorSource.cs`
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar, Optional


# ---------------------------------------------------------------------------
# Discriminated union: ErrorSource hierarchy
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ErrorSource:
    """Provenance envelope for a metadata node or loader error.

    Abstract base — never instantiated directly. Every concrete variant
    declares a class-level ``format`` constant that names its discriminant tag
    in the cross-port wire shape.
    """

    # Subclasses override this class-level constant. Declared here as a
    # placeholder so static type-checkers see a string attribute on the base.
    format: ClassVar[str] = ""


@dataclass(frozen=True)
class JsonSource(ErrorSource):
    """Authoring-time: single JSON file (FR5a).

    Args:
        files: Length-1 tuple of project-root-relative file paths. The FR5a
            invariant guarantees exactly one file — multi-file provenance lives
            on :class:`MergedSource` (FR5c). Enforced at construction.
        json_path: Canonical JSONPath string for the node within ``files[0]``.
    """

    files: tuple[str, ...]
    json_path: str
    format: ClassVar[str] = "json"

    def __post_init__(self) -> None:
        # FR5a invariant: exactly one file. Multi-file provenance is
        # MergedSource (FR5c) territory; enforce here so the type can be
        # trusted by cross-port comparison.
        if len(self.files) != 1:
            raise ValueError(
                f"JsonSource requires exactly one file path; got {len(self.files)}. "
                "Use MergedSource for multi-file provenance."
            )


@dataclass(frozen=True)
class YamlPosition:
    """Optional YAML line/col source position (FR5b). 1-based."""

    line: int
    col: int


@dataclass(frozen=True)
class YamlSource(ErrorSource):
    """Authoring-time: single YAML file with optional source-map positions (FR5b)."""

    files: tuple[str, ...]
    json_path: str
    yaml_position: Optional[YamlPosition] = None
    format: ClassVar[str] = "yaml"


@dataclass(frozen=True)
class Contributor:
    """One contributor in a :class:`MergedSource`.

    Args:
        file: Path to the contributing file (project-root relative; forward slashes).
        role: One of ``"overlay-base"``, ``"overlay-extension"``,
            ``"extends-base"``, ``"extends-extension"``.
    """

    file: str
    role: str


@dataclass(frozen=True)
class MergedSource(ErrorSource):
    """Post-load: overlay merge that produced semantic change (FR5c)."""

    files: tuple[str, ...]
    json_path: str
    contributors: tuple[Contributor, ...]
    format: ClassVar[str] = "merged"


@dataclass(frozen=True)
class ResolvedSource(ErrorSource):
    """Post-load: extends / @via / @objectRef / @payloadRef resolution failure (FR5d)."""

    files: tuple[str, ...]
    json_path: Optional[str] = None
    referrer: Optional[str] = None
    target: Optional[str] = None
    format: ClassVar[str] = "resolved"


@dataclass(frozen=True)
class DbLocation:
    """Database location for a node sourced from a row."""

    table: str
    id: str


@dataclass(frozen=True)
class DatabaseSource(ErrorSource):
    """Future: database-sourced metadata (FR5e, gated on FR-003)."""

    db_location: DbLocation
    json_path: Optional[str] = None
    format: ClassVar[str] = "database"


@dataclass(frozen=True)
class CodeSource(ErrorSource):
    """Programmatic / test construction.

    The default for any node not built by a loader phase. Mirrors TS
    ``codeSource(caller?)``.

    Args:
        caller: Optional human label (e.g. ``"QueriesTest.makePost"``).
    """

    caller: Optional[str] = None
    format: ClassVar[str] = "code"

    # Canonical singleton for the no-caller case. Frozen dataclasses are
    # hash-equal across instances, but a single shared default makes intent
    # explicit and matches the C# `CodeSource.Default` convention. Declared
    # here as a forward reference so static analyzers see `CodeSource.DEFAULT`
    # as a `CodeSource` (the assignment lives below).
    DEFAULT: ClassVar["CodeSource"]


CodeSource.DEFAULT = CodeSource(caller=None)


# ---------------------------------------------------------------------------
# Envelope types: error / warning structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodeContext:
    """Optional structural context attached to a loader error.

    RECOMMENDED per ADR-0009; conformance does not enforce population.
    """

    type: Optional[str] = None
    sub_type: Optional[str] = None
    name: Optional[str] = None
    fqn: Optional[str] = None


@dataclass(frozen=True)
class LoaderError:
    """Envelope shape every loader error conforms to. ADR-0009 §Decision.

    ``code``, ``message`` and ``source`` are REQUIRED (conformance-enforced).
    The remaining fields are RECOMMENDED; FR5a does not populate them, FR5b–FR5e
    may.
    """

    code: str
    message: str
    source: ErrorSource
    suggestions: tuple[str, ...] = field(default_factory=tuple)
    fixture: Optional[str] = None
    node: Optional[NodeContext] = None


@dataclass(frozen=True)
class LoaderWarning:
    """Warning envelope — same shape as :class:`LoaderError` but a ``WARN_*`` code.

    Today's only initial warning code is ``WARN_DUPLICATE_DECLARATION``
    (emitted by overlay-merge when a duplicate-with-no-change is detected;
    FR5c will produce these). FR5a does not raise warnings via this channel —
    legacy ``warnings: list[str]`` continues to flow through the loader.
    """

    code: str
    message: str
    source: ErrorSource
    suggestions: tuple[str, ...] = field(default_factory=tuple)
    fixture: Optional[str] = None
    node: Optional[NodeContext] = None
