"""Codegen run configuration (the run_gen surface)."""
from __future__ import annotations

from dataclasses import dataclass, field

from metaobjects.naming import DEFAULT_COLUMN_NAMING


@dataclass
class GenConfig:
    out_dir: str
    # Where the codegen hash manifest lives (``<gen_state_dir>/.hashes.json``), which
    # records what this generator wrote so a later run can tell its own output from a
    # hand edit. None disables that detection and falls back to the legacy
    # @generated-marker rule — mirroring TS, where a runGen with no projectRoot also
    # gets weaker guarantees. The CLI always sets it to
    # ``<project>/.metaobjects/.gen-state``. COMMIT the manifest: it is the only thing
    # that makes hand-edit detection work on a machine that did not generate the code.
    gen_state_dir: str | None = None
    output_layout: str = "flat"  # "flat" only in sub-project A
    emit_abstract_shapes: bool = True  # Python concretes subclass the abstract base model
    emit_package_init: bool = True  # emit an @generated __init__.py so the out dir imports as a package
    # FR-019 (ADR-0026): per-port resolution of a @provided enum's import module. The module
    # never lives in metadata (ADR-0001) — it is codegen config. ``provided_enum_packages``
    # maps a declaring metadata package ("acme::shop") to the Python import module; with a
    # single ``provided_enum_namespace`` fallback for the one-module case. A referenced
    # @provided enum whose package resolves to no module is a codegen-time error.
    # How a field with no explicit `@column` becomes a physical column name
    # ("literal" | "snake_case" | "kebab-case"). Config, never metadata: the same model
    # must be able to drive a snake_case schema and a literal-column one. Defaults to
    # `literal`, this port's historical behaviour — but `meta migrate`, which owns
    # schema for EVERY port (ADR-0015), defaults to `snake_case`, so a project whose
    # tables it created wants `snake_case` here or an explicit `@column` per field.
    column_naming: str = DEFAULT_COLUMN_NAMING
    provided_enum_namespace: str | None = None
    provided_enum_packages: dict[str, str] = field(default_factory=dict)
