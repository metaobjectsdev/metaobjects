"""Codegen run configuration (the run_gen surface)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GenConfig:
    out_dir: str
    output_layout: str = "flat"  # "flat" only in sub-project A
    emit_abstract_shapes: bool = True  # Python concretes subclass the abstract base model
    emit_package_init: bool = True  # emit an @generated __init__.py so the out dir imports as a package
    # FR-019 (ADR-0026): per-port resolution of a @provided enum's import module. The module
    # never lives in metadata (ADR-0001) — it is codegen config. ``provided_enum_packages``
    # maps a declaring metadata package ("acme::shop") to the Python import module; with a
    # single ``provided_enum_namespace`` fallback for the one-module case. A referenced
    # @provided enum whose package resolves to no module is a codegen-time error.
    provided_enum_namespace: str | None = None
    provided_enum_packages: dict[str, str] = field(default_factory=dict)
