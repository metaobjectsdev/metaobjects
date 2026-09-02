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
    # Only "flat" is implemented; a non-default value is REFUSED below rather than
    # silently ignored (see __post_init__).
    output_layout: str = "flat"
    # Python ALWAYS emits the abstract base model — concretes subclass it. Suppression
    # is not implemented in this port (C# has it, behind `dotnet meta gen
    # --emit-abstract-shapes`), so False is REFUSED rather than silently ignored.
    emit_abstract_shapes: bool = True
    emit_package_init: bool = True  # emit an @generated __init__.py so the out dir imports as a package
    # FR-019 (ADR-0026): per-port resolution of a @provided enum's import module. The module
    # never lives in metadata (ADR-0001) — it is codegen config. ``provided_enum_packages``
    # maps a declaring metadata package ("acme::shop") to the Python import module; with a
    # single ``provided_enum_namespace`` fallback for the one-module case. A referenced
    # @provided enum whose package resolves to no module is a codegen-time error.
    # The column-naming strategy: read by the ``names`` generator
    # (codegen/generators/names_generator.py) for any field with no explicit
    # ``@column``, matching whatever the runtime (``ObjectManager(...,
    # column_naming=...)``) was told. The two must agree, or the constant this
    # generator emits names a different column than the one a row actually lands
    # in.
    column_naming: str = DEFAULT_COLUMN_NAMING
    provided_enum_namespace: str | None = None
    provided_enum_packages: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Refuse a value this port cannot honour, instead of accepting it and ignoring it.

        Two fields here are read by NOTHING — `grep -rn "\\.<field>" src/` returns zero
        for each — so setting one runs clean, reports success and changes not a byte.
        `emit_abstract_shapes` is a knob C# genuinely implements, which made a
        cross-port divergence look like a shared option. (`column_naming` used to be
        the worst of these — `docs/features/field-types.md` named it as this port's
        codegen lever while nothing read it — until the `names` generator gave it a
        reader; see that field's own comment.)

        Neither of the two is WIRED here, because neither can be without work this is
        not: Python codegen always emits the abstract base model and implements one
        output layout. So each refuses the value it cannot deliver, and names the
        surface that can. Detect-and-refuse, never silent-and-wrong — the same call
        `apply_column_naming_strategy` already makes for an unknown strategy.

        Defaults are untouched, so every existing call is unaffected.
        """
        if self.output_layout != "flat":
            raise ValueError(
                f"GenConfig.output_layout={self.output_layout!r}: only 'flat' is "
                "implemented in this port."
            )
        if self.emit_abstract_shapes is not True:
            raise ValueError(
                "GenConfig.emit_abstract_shapes=False: this port always emits the abstract "
                "base model — concretes subclass it — and suppressing it is not implemented "
                "here. The C# port implements the same knob (`dotnet meta gen "
                "--emit-abstract-shapes`); this one would have accepted the value and "
                "emitted the shapes anyway."
            )
