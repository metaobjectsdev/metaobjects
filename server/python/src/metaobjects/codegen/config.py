"""Codegen run configuration (the run_gen surface)."""
from __future__ import annotations

from dataclasses import dataclass, field


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
    # NOTE: there is deliberately NO `column_naming` here. One existed and nothing read
    # it, so `GenConfig(column_naming="snake_case")` ran clean, reported success and
    # changed no output — while the docs named it as this port's codegen lever. It could
    # not be wired, because Python codegen emits no physical column name at all: the
    # models, create/patch shapes, router and filter allowlists all key by `field.name`,
    # and persistence is the consumer's repository or `ObjectManager`. The strategy is a
    # RUNTIME concern here — `ObjectManager(..., column_naming=...)` — plus the internal
    # `resolve_m2m_descriptors(..., column_naming=...)` that builds junction FK column
    # names for a consumer repository. If a generator ever emits a column name, add the
    # field back TOGETHER with that generator, never ahead of it.
    provided_enum_namespace: str | None = None
    provided_enum_packages: dict[str, str] = field(default_factory=dict)
