"""Codegen run configuration (the run_gen surface)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class GenConfig:
    out_dir: str
    output_layout: str = "flat"  # "flat" only in sub-project A
    emit_abstract_shapes: bool = True  # Python concretes subclass the abstract base model
