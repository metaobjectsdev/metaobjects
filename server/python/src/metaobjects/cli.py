"""The ``metaobjects`` console-script — codegen `gen` + drift `verify` (SP-E Unit 2).

Two subcommands:

  metaobjects gen    <metadataDir> --out <dir> [--package <pkg>]
                     [--templates <dir>] [--template-spec <json>]
      Load metadata, run the Python codegen generator suite, and write files
      under ``--out`` (guarded by the @generated header). Prints each written
      file. Non-zero exit on a load error. ``--template-spec`` appends the
      declarative Mustache template generators (scope perEntity/perPackage/
      perModel + outputPattern) described by a JSON spec.

      ``--templates <dir>`` is the on-disk root every template ref resolves
      under. It feeds BOTH the ``--template-spec`` pass and the ``render-helper``
      generator's build-time drift gate; until 1.0.5 it reached only the former,
      so ``--generators render-helper`` read a hardcoded ``templates`` whatever
      this flag said.

  metaobjects verify <metadataDir> [--codegen] [--templates] [--db URL] ...
      Drift gate with explicit subverbs (ADR-0021 D2 — one verify vocabulary
      across ports):

        --codegen    regenerate into a temp dir + diff against the committed
                     ``--out`` tree (Python's historical default behavior).
                     The column naming comes from ``naming.columns`` in
                     ``.metaobjects/config.json`` (ADR-0058), the same setting
                     ``gen`` reads, so the ``names`` generator's constants match
                     the committed tree; when another column rule, another
                     table rule, or both reproduce that tree, verify reports a
                     naming mismatch naming the setting instead of asking you
                     to regenerate.
        --templates  template/prompt ``{{field}}`` ↔ payload-VO drift — the
                     render ``verify()`` gate — resolving each ``template.*``
                     node's refs via a filesystem provider rooted at
                     ``templates`` in ``metaobjects.config.yaml`` (else
                     ``--prompts``), over the config's ``metadata``.
        --db URL     REJECTED in the Python port (exit 2): schema verify is the
                     migrate engine (ADR-0015), not this CLI.

      Combining flags runs each requested mode and aggregates the exit code
      (non-zero if ANY mode drifts). A bare ``verify`` keeps the historical
      default = ``--codegen`` (back-compat) and prints a one-line note that the
      explicit subverbs exist.

Named ``metaobjects``, NOT ``meta``: ``meta`` is the Node schema CLI. This CLI
intentionally has NO ``migrate`` subcommand — schema is owned by the Node
toolchain (ADR-0015). The ``--codegen`` mode shares the exact same generation
code path as ``gen`` (verify = gen-to-temp + diff), so drift can never be a
generator-wiring divergence between the two commands.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

from metaobjects import MetaDataLoader
from metaobjects.errors import ErrorCode, MetaError, ParseError
from metaobjects.config.dependencies import (
    Collection,
    imported_from,
    refuse_library_package_misuse,
    refuse_unowned_packages,
)
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.field_lint import lint_duplicate_fields, lint_reference_fields
from metaobjects.loader.meta_data_loader import LoadResult
from metaobjects.loader.sources import FileSource
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.agent_context import (
    AGENT_CONTEXT_MANIFEST_PATH,
    agent_context_staleness,
    installed_metaobjects_version,
)
from metaobjects.meta.core.requirement.requirement_constants import REQUIREMENT_STATUSES
from metaobjects.meta.meta_data import MetaData
from metaobjects.requirement_check import (
    SEVERITY_ERROR,
    Diagnostic,
    check_requirements,
    scan_requirements,
    summarise_requirements,
)
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.overwrite_policy import (
    has_hash_manifest,
    is_pristine_generated,
    read_generated_hash,
)
from metaobjects.codegen.project_config import (
    CONFIG_FILENAME,
    ConfigError,
    ProjectConfig,
    TargetConfig,
    load_project_config,
)
from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.extractor_generator import extractor_generator
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.generators.output_parser_generator import (
    output_parser_generator,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    output_prompt_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.generator_registry import (
    GENERATOR_REGISTRY,
    GeneratorBuildContext,
    RequirementTestsOptions,
    get_generator,
    list_generators,
    unsatisfied_requires,
)
from metaobjects.codegen.project_import import import_project_symbol
from metaobjects.codegen.orphan_sweep import refused_orphan_message, sweep_orphans
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen import eject as owned
from metaobjects.codegen.generators.render_helper_generator import (
    _derive_payload_field_tree,
)
from metaobjects.codegen.value_objects import pkg_of, resolve_payload_vo
from metaobjects.meta.template import template_constants as tc
from metaobjects.naming import (
    COLUMN_NAMING_STRATEGIES,
    DEFAULT_COLUMN_NAMING,
    TABLE_NAMING_RULES,
    NamingRules,
    package_of_resolution_key,
    removed_naming_source_message,
)
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.render.verify import (
    ERR_REQUIRED_SLOT_UNUSED,
    PayloadField,
    verify as render_verify,
)
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_TEMPLATE


#: The error a run with no generator selection reports.
#:
#: There is no default suite. This port used to run EIGHT generators for a caller who
#: named none — entity, router, filter-allowlist, names, payload, output-parser,
#: output-prompt, extractor — which is a shape nobody chose. Java has never had a
#: default set and has been right all along; TypeScript and C# dropped theirs in the
#: same change.
#:
#: Deciding WHICH code an application needs belongs to whoever is building it —
#: increasingly an LLM working in the repo, which is well able to make that call given a
#: truthful catalog and is badly served by a default that pre-empts it. ``--list`` is
#: that catalog.
NO_GENERATORS_SELECTED = (
    "gen: no generators selected. Nothing is generated until you choose it — "
    "pass --generators <a,b,c>. See the catalog: metaobjects gen --list"
)


class NoGeneratorsSelectedError(ValueError):
    """Raised when a codegen run names no generator. Carries the usage message."""

    def __init__(self) -> None:
        super().__init__(NO_GENERATORS_SELECTED)


#: The migration section every 1.1.0 refusal below points at (ADR-0034 Amendment 9).
_MIGRATION_SECTION = 'See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section "Python".'

#: What ``metaobjects docs`` prints, exit 2: the command was removed in 1.1.0.
DOCS_COMMAND_REMOVED = (
    "metaobjects docs was removed in 1.1.0. `metaobjects gen` writes documentation now: declare "
    "each docs generator in a target's `generators` in metaobjects.config.yaml. "
    + _MIGRATION_SECTION
)


def no_generator_list_message(command: str) -> str:
    """What *command* prints, exit 2, when there is no ``metaobjects.config.yaml``."""
    return (
        f"{command}: no metaobjects.config.yaml. The generator list lives there in 1.1.0, "
        f"documentation included. {_MIGRATION_SECTION}"
    )


def legacy_docs_message(command: str) -> str:
    """What *command* prints, exit 2, for a config that still carries the 1.0 ``docs`` block."""
    return (
        f"{command}: found 1.0 docs configuration (the docs block in metaobjects.config.yaml). "
        "Nothing reads it any more, so this run would write no documentation. Declare each docs "
        "generator in a target's `generators` in metaobjects.config.yaml. " + _MIGRATION_SECTION
    )


def legacy_template_spec_message(command: str) -> str:
    """What *command* prints, exit 2, when the project still has the conventional
    ``template-spec.json`` and no target declares a ``templateSpec``: through 1.0 the flag form
    discovered that file, and nothing reads it now."""
    return (
        f"{command}: found 1.0 template-spec configuration ({TEMPLATE_SPEC_FILENAME}). Nothing "
        "reads it any more, so this run would not render its templates. Declare it on the target "
        f"it writes into, as `templateSpec: {TEMPLATE_SPEC_FILENAME}` in metaobjects.config.yaml. "
        + _MIGRATION_SECTION
    )


#: What a gen or ``verify --codegen`` run given the 1.0 ``<metadata_dir> --out`` form prints,
#: exit 2, in a project that has its config: the config's ``metadata`` and each target's
#: ``outDir`` say where, and a flag that disagreed with them would be a second list.
FLAG_FORM_NOT_READ = (
    "{command}: <metadata_dir> and --out are not read in 1.1.0. The metadata directory is "
    "`metadata` and each output directory is a target's `outDir` in metaobjects.config.yaml. "
    + _MIGRATION_SECTION
)


def _resolve_providers(specs: list[str] | None) -> tuple[list[object], list[str]]:
    """Import consumer providers named as ``module:symbol`` (repeatable ``--provider``).

    The symbol must be a metaobjects ``Provider`` (or a list of them, or a zero-arg
    factory returning either). A provider carries CODE — factories and optional
    validators — so it is loaded as a native Python object, not a JSON file (#158).
    This is the Python CLI's idiomatic parity with TS ``metaobjects.config.ts``
    ``providers``; the underlying loader already accepts providers.
    """
    if not specs:
        return [], []
    import importlib

    from metaobjects.provider import Provider

    providers: list[object] = []
    errors: list[str] = []
    for spec in specs:
        module_name, sep, symbol = spec.partition(":")
        if not sep or not module_name or not symbol:
            errors.append(
                f"--provider '{spec}' must be in 'module:symbol' form "
                "(e.g. myapp.providers:my_provider)"
            )
            continue
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # ImportError + anything raised at import time
            errors.append(f"--provider '{spec}': cannot import '{module_name}': {exc}")
            continue
        try:
            obj = getattr(module, symbol)
        except AttributeError:
            errors.append(
                f"--provider '{spec}': '{module_name}' has no attribute '{symbol}'"
            )
            continue
        # A zero-arg factory is supported: call it to obtain the provider(s).
        if callable(obj) and not isinstance(obj, Provider):
            try:
                obj = obj()
            except Exception as exc:
                errors.append(f"--provider '{spec}': factory '{symbol}()' raised: {exc}")
                continue
        for item in obj if isinstance(obj, list) else [obj]:
            if isinstance(item, Provider):
                providers.append(item)
            else:
                errors.append(
                    f"--provider '{spec}': '{symbol}' resolved to "
                    f"{type(item).__name__}, expected a metaobjects Provider"
                )
    return providers, errors


def _providers_from_args(args: argparse.Namespace) -> tuple[list[object], bool]:
    """Resolve ``--provider`` specs; print resolution errors. Returns (providers, ok)."""
    providers, errors = _resolve_providers(getattr(args, "provider", None))
    if errors:
        print("error: invalid --provider:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return providers, False
    return providers, True


def _find_config(args: argparse.Namespace) -> Path | None:
    """The config path: ``--config`` if given (even if missing → clear load error),
    else ``./metaobjects.config.yaml`` in cwd when it exists, else ``None``."""
    explicit = getattr(args, "config", None)
    if explicit:
        return Path(explicit)
    default = Path.cwd() / CONFIG_FILENAME
    return default if default.is_file() else None


def _resolve_config_providers(config: ProjectConfig) -> tuple[list[object], list[str]]:
    """Resolve ``config.providers`` with the config file's directory on ``sys.path``.

    #267: prepend the config directory so a ``module:symbol`` provider living beside
    the config imports with no ``PYTHONPATH=``. Idempotent; the entry is left in
    place (a short-lived CLI process). Prints nothing; returns (providers, errors).
    """
    config_dir = str(config.config_dir)
    if config_dir not in sys.path:
        sys.path.insert(0, config_dir)
    return _resolve_providers(config.providers)


def _config_providers(config: ProjectConfig) -> tuple[list[object], bool]:
    """:func:`_resolve_config_providers`, printing resolution errors; returns (providers, ok)."""
    providers, errors = _resolve_config_providers(config)
    if errors:
        print("error: invalid provider in config:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return providers, False
    return providers, True


def _import_config_symbol(spec: str, config_dir: Path) -> tuple[object | None, str | None]:
    """Import a ``module:symbol`` named by the config, relative to *config_dir*.

    The same resolver an owned generator is imported with (:func:`import_project_symbol`; its
    docstring states the rule). In short: the config directory goes on ``sys.path`` so a module
    beside the config imports with no ``PYTHONPATH=``; a cached module of the spec's top-level
    name is dropped only when it is not under the config directory AND the config directory
    offers that name; the running ``metaobjects`` package is never dropped; and a project package
    named like a standard-library module is refused. A package the project does not provide (an
    installed hook package) is imported once and shared by every hook that names it. Returns
    ``(callable, None)`` or ``(None, message)``; the message names the spec, the module and the
    real cause.
    """
    module_name, _sep, symbol = spec.partition(":")
    obj, err = import_project_symbol(module_name, symbol, config_dir)
    if err is not None:
        return None, f"{spec!r}: {err}"
    if not callable(obj):
        return None, f"{spec!r}: {symbol!r} is not callable"
    return obj, None


def _requirement_tests_options(
    config: ProjectConfig,
) -> tuple[RequirementTestsOptions | None, list[str]]:
    """The ``requirementTests`` block with its ``renderer`` and ``filter`` imported.

    ``(None, [])`` when the config carries no block, so the generator's defaults apply.
    """
    block = config.requirement_tests
    if block is None:
        return None, []
    errors: list[str] = []
    hooks: dict[str, object | None] = {}
    for key, spec in (("renderer", block.renderer), ("filter", block.filter)):
        if spec is None:
            hooks[key] = None
            continue
        obj, err = _import_config_symbol(spec, config.config_dir)
        if err is not None:
            errors.append(f"requirementTests.{key}: {err}")
        hooks[key] = obj
    if errors:
        return None, errors
    return (
        RequirementTestsOptions(
            witness_module=block.witness_module,
            grain=block.grain,
            renderer=hooks["renderer"],  # type: ignore[arg-type]
            filter=hooks["filter"],  # type: ignore[arg-type]
            warn_uncovered=block.warn_uncovered,
        ),
        [],
    )


def _select_targets(
    config: ProjectConfig, target_name: str | None
) -> tuple[list[TargetConfig], str | None]:
    """All targets, or the single ``--target`` (error string when the name is unknown)."""
    if target_name is None:
        return config.targets, None
    t = config.target(target_name)
    if t is None:
        known = ", ".join(sorted(x.name for x in config.targets))
        return [], f"unknown --target {target_name!r}; known targets: {known}"
    return [t], None


def _merge_libraries(*groups: "list[str] | tuple[str, ...] | None") -> list[str]:
    """Union several ``libraries`` selection-token groups, de-duplicated and
    order-preserving (first occurrence wins the position).

    Every group is a selection from a DIFFERENT source for the same concept —
    the neutral ``.metaobjects/config.json`` (FR-043 §12 Q4, read at every rung)
    and, where one exists, a per-port config surface's own ``libraries:`` key
    (Python's ``metaobjects.config.yaml``). Neither is authoritative over the
    other, so a project may declare libraries in either place or both.
    """
    seen: dict[str, None] = {}
    for group in groups:
        for token in group or ():
            seen.setdefault(token, None)
    return list(seen)


def _load_root(
    metadata_dir: str,
    strict: bool = False,
    providers: list[object] | None = None,
    libraries: list[str] | None = None,
    unknown_attr_out: list[str] | None = None,
) -> tuple[MetaData | None, list[str]]:
    """Load metadata; return ``(root, error_messages)``. ``root`` is None on error.

    ``unknown_attr_out`` — when given on a LENIENT load, a second strict load of the
    same metadata is run and its ``ERR_UNKNOWN_ATTR`` findings are appended, formatted,
    so ``gen`` can warn about what ``verify`` would reject instead of staying silent.

    ``strict`` (ADR-0023, #96) — when True, an undeclared own ``@attr`` →
    ``ERR_UNKNOWN_ATTR``. Defaults False so ``gen`` / ``docs`` keep the legacy
    open-attr load; only ``verify`` opts in (strict-by-default with a ``--lax``
    escape).

    ``providers`` (#158) — consumer providers (from ``--provider module:symbol``)
    composed ON TOP of the core set, so a config-registered custom subtype resolves
    through the standalone CLI just as it does when an app loads the loader directly.
    Empty/None keeps the core-providers-only default (``from_directory`` convenience).

    ``libraries`` — MetaObjects-shipped library packages (config key ``libraries``,
    e.g. ``["ai"]``). Without this the CLI could not load ``metaobjects::ai::LlmCallBase``,
    so ``metaobjects gen`` failed with ERR_UNRESOLVED_SUPER on exactly the metadata the
    registered ``trace-helper`` generator exists to consume — the generator was reachable
    from the CLI while its input was not. ADDITIVE to (never a replacement for) the
    neutral ``.metaobjects/config.json``'s own ``libraries`` key (FR-043 §12 Q4), which
    this function ALWAYS also reads, from the project holding ``metadata_dir``
    (:func:`project_root_for`) — an explicit-``metadata_dir`` CLI invocation
    (``gen``, ``docs``, ``verify --templates``, ``verify --codegen``'s
    regenerate-to-temp path) never resolves a `Collection`
    (:func:`resolve_metadata_location`'s docstring: rung 1 is not its concern), so
    without this an adopter whose opt-in lives only in ``.metaobjects/config.json``
    could not run any explicit-directory command against metadata using a library
    at all — exactly the gap ``config``-mode (:func:`_cmd_gen_config`) does not have,
    because it already threads ``config.libraries`` through
    :func:`_load_root_from_collection`.
    """
    try:
        neutral = read_neutral_config(project_root_for(metadata_dir))
    except ParseError as exc:
        return None, [f"{exc.code}: {exc}"]
    all_libraries = _merge_libraries(neutral.libraries if neutral is not None else None, libraries)

    def load(strict_load: bool) -> LoadResult:
        if providers:
            from metaobjects.core_types import core_providers

            return MetaDataLoader.from_directory(
                metadata_dir,
                providers=[*core_providers, *providers],
                strict=strict_load,
                libraries=all_libraries,
            )
        return MetaDataLoader.from_directory(
            metadata_dir, strict=strict_load, libraries=all_libraries
        )

    try:
        result = load(strict)
        if unknown_attr_out is not None and not strict and not result.errors:
            unknown_attr_out.extend(_unknown_attr_findings(load(True)))
    except OSError as e:
        # `DirectorySource.expand()` walks via `iterdir()` (not `rglob()`, so it
        # can follow a symlinked subdirectory — the I1 fix) and raises a plain
        # OSError (FileNotFoundError / NotADirectoryError, or `SymlinkLoopError`
        # on a symlink cycle) when `metadata_dir` itself can't be walked. Nothing
        # upstream of this call catches it, so it would otherwise surface as a
        # raw Python traceback instead of the coded "error: failed to load
        # metadata" every other `_load_root` failure prints. Mirrors the
        # TypeScript reference, which wraps the equivalent `readdir` failure in
        # a clean `Error` at the same boundary (`metadata-files.ts`,
        # `listMetadataFiles`: "cannot read metadata directory ...").
        return None, [f"cannot read metadata directory {metadata_dir}: {e}"]
    if result.errors:
        msgs = [f"{e.code}: {e.message}" for e in result.errors]
        return None, msgs
    try:
        # FR-043 §3.4 / §3.5 — same misuse guard the `Collection` load path runs
        # (`_load_collection_result`): an explicit-directory load opted into a
        # library was the one path that never checked for an ejected-copy
        # collision or an adopter node declared straight into the library's
        # package.
        refuse_library_package_misuse(result.root, all_libraries)
    except ParseError as exc:
        return None, [f"{exc.code}: {exc}"]
    # ADR-0058 Decision 3 — the loaded root carries the ONE project naming setting,
    # from the SAME neutral `.metaobjects/config.json` read above for `libraries`,
    # so codegen and the runtime (both reached from an explicit-`metadata_dir` CLI
    # invocation) read the same values `gen`/`verify --codegen` would.
    result.root.naming = neutral.naming if neutral is not None else NamingRules()
    return result.root, []


def _load_collection_result(
    collection: Collection,
    strict: bool = False,
    providers: list[object] | None = None,
    libraries: list[str] | None = None,
) -> LoadResult:
    """Load a resolved `Collection`'s files — its dependency artifacts leading,
    each under its `dep:<name>/<artifact>` source id (FR-023) — then run the
    post-load ownership refusal (`ERR_DEPENDENCY_PACKAGE_NOT_OWNED`, DESIGN
    §11.5). Mirrors the TS `loadMemory` (`sdk/src/memory.ts`).

    ``libraries`` is ADDITIVE to ``collection.libraries`` (the neutral
    `.metaobjects/config.json`'s own key, read at every rung — FR-043 §12 Q4),
    never a replacement for it: a caller passes a per-port config surface's own
    selection here (Python's `metaobjects.config.yaml` `libraries:` key), and
    both are merged before resolving library sources.

    Lower-level than :func:`_load_root_from_collection`: this returns the raw
    `LoadResult` (structured `MetaError`s, a code + provenance on each) rather
    than the CLI's flattened `(root, message-strings)` contract, so a caller
    that needs the CODE or the offending FILE — the dependency corpus runner —
    can read them. ``refuse_unowned_packages`` runs AFTER the loader's own
    errors, never before: an unflagged overlay whose target the upstream
    removed fails first, with its own coded error.
    """
    # `collection.libraries` (FR-043 §12 Q4 — the neutral `.metaobjects/config.json`,
    # read at every rung) is merged with whatever the caller additionally passes
    # (a per-port config surface's own `libraries:` key, e.g. Python's
    # `metaobjects.config.yaml` — see `_cmd_gen_config`). Neither source is
    # authoritative over the other.
    all_libraries = _merge_libraries(collection.libraries, libraries)

    lib_sources: list[object] = []
    if all_libraries:
        from metaobjects.library import library_sources

        lib_sources = library_sources(all_libraries)

    sources = [FileSource(p, id=collection.file_ids.get(p)) for p in collection.files]

    if providers:
        from metaobjects.core_types import core_providers

        loader = MetaDataLoader(providers=[*core_providers, *providers], strict=strict)
    else:
        loader = MetaDataLoader(strict=strict)

    result = loader.load([*lib_sources, *sources])
    if not result.errors:
        refuse_unowned_packages(result.root, collection.imported_packages, collection.imported_nodes)
        # FR-043 §3.4 / §3.5 — the same rule for a shipped LIBRARY's package, where the
        # two ways to get it wrong are opposite: a node the library also declares (an
        # ejected copy, still opted in) and one it does not (a new node in someone
        # else's package).
        refuse_library_package_misuse(result.root, all_libraries)
        # ADR-0058 Decision 3 — the resolved `Collection` already carries this
        # project's ONE naming setting (read at the same rung as `libraries`); attach
        # it to the loaded root so codegen, the runtime and `verify` agree.
        result.root.naming = collection.naming
    return result


def _load_root_from_collection(
    collection: Collection,
    strict: bool = False,
    providers: list[object] | None = None,
    libraries: list[str] | None = None,
    unknown_attr_out: list[str] | None = None,
) -> tuple[MetaData | None, list[str]]:
    """Load a resolved `Collection` — the source-resolution ladder's
    ``.metaobjects/config.json`` rung (:func:`resolve_metadata_location`), which
    can resolve to several directories, individual files, AND a dependency's
    snapshot artifact, none of which a single ``from_directory`` call can
    express. Mirrors :func:`_load_root`'s ``strict``/``providers``/``libraries``
    contract exactly (CLI-facing: flattened error messages, never a raised
    exception for a plain loader error).
    """
    try:
        result = _load_collection_result(collection, strict=strict, providers=providers, libraries=libraries)
    except ParseError as exc:
        return None, [f"{exc.code}: {exc}"]
    if result.errors:
        msgs = [f"{e.code}: {e.message}" for e in result.errors]
        return None, msgs
    if unknown_attr_out is not None and not strict:
        # See `_load_root`: what a strict load (`verify`) would reject, for `gen` to warn.
        try:
            strict_result = _load_collection_result(
                collection, strict=True, providers=providers, libraries=libraries
            )
        except ParseError:
            strict_result = None
        if strict_result is not None:
            unknown_attr_out.extend(_unknown_attr_findings(strict_result))
    return result.root, []


#: Trailing advice after ``gen``'s unknown-attribute warnings. ``gen`` has no strict
#: flag of its own; ``verify`` is the strict door (ADR-0023), so that is what it names.
UNKNOWN_ATTR_GEN_ADVICE = (
    "metaobjects gen loads leniently and generated anyway, but `metaobjects verify` "
    "rejects this metadata (ADR-0023): fix or remove the attribute - a typo'd one "
    "(`isAbstrakt`, `requird`) silently changes what is generated."
)


def _format_unknown_attr(err: MetaError) -> str:
    """One ``gen`` warning: code + message (naming attribute and node), then the file."""
    env = getattr(err, "envelope", None)
    files = [f for f in (getattr(env, "files", None) or ()) if f]
    json_path = getattr(env, "json_path", None)
    where = " ".join(
        p for p in (", ".join(files) if files else None, f"at {json_path}" if json_path else None) if p
    )
    head = f"{err.code.value if hasattr(err.code, 'value') else err.code}: {err.message}"
    return f"{head}\n  in {where}" if where else head


def _unknown_attr_findings(result: LoadResult) -> list[str]:
    """The ERR_UNKNOWN_ATTR findings of a STRICT load, formatted for ``gen``."""
    return [
        _format_unknown_attr(e) for e in result.errors
        if (e.code.value if hasattr(e.code, "value") else e.code) == ErrorCode.ERR_UNKNOWN_ATTR.value
    ]


def _print_unknown_attr_warnings(findings: list[str]) -> None:
    """``gen`` loads leniently; an unknown attribute ``verify`` would reject is named here
    as a warning (attribute, node, file). Advisory only: the exit code is unchanged."""
    if not findings:
        return
    for f in findings:
        print(f"warning: {f}", file=sys.stderr)
    print(f"warning: {UNKNOWN_ATTR_GEN_ADVICE}", file=sys.stderr)


def _strict_load_hint() -> str:
    """Actionable next-steps when strict verify rejects an undeclared @attr."""
    return (
        "verify is strict (ADR-0023): every authored @attr must be declared. Fix: "
        "register the attr on a metadata provider, OR move arbitrary author-supplied "
        "properties into an `attr.properties` bag, OR re-run with `--lax` to keep the "
        "legacy open-attr load."
    )


def _load_failure_lines(errors: list[str], strict: bool) -> list[str]:
    """The lines a ``verify`` gate prints for metadata that did not load: the heading, one
    indented line per loader message, and the strict-load advice when an unknown attribute is
    among them."""
    lines = ["error: failed to load metadata:", *(f"  {msg}" for msg in errors)]
    if strict and any("ERR_UNKNOWN_ATTR" in m for m in errors):
        lines.append(_strict_load_hint())
    return lines


#: The canonical directory name for authored template bodies. Named `prompts` because
#: that is what the Node CLI has always called it (`DEFAULT_PROMPTS_DIR`), and the Node
#: CLI is the schema door every project meets first.
DEFAULT_PROMPTS_DIR = "prompts"

#: The name this port defaulted to before 1.0.5, kept as the FALLBACK rather than
#: replaced. Flipping the default outright would move where an existing project's
#: template refs resolve from, and a project whose bodies are in `templates/` would
#: start finding nothing — a silent drift-gate failure, or worse a `verify --codegen`
#: that convicts committed output. A fallback breaks nobody: a project with
#: `templates/` and no `prompts/` behaves exactly as it did.
LEGACY_TEMPLATES_DIR = "templates"


def _default_template_root(base: str | Path = ".") -> str:
    """The template root to use when the caller named none.

    `prompts` when it exists, else `templates`. The two halves of the toolchain
    disagreed about this: the Node CLI has always defaulted to `prompts`, while this
    port and C#'s `GenCommand` defaulted to `templates`, so a project following the
    Node CLI's layout — which this repo's own adopter estate does — had a `gen` that
    looked somewhere its `prompts/` was not.
    """
    return (DEFAULT_PROMPTS_DIR if Path(base, DEFAULT_PROMPTS_DIR).is_dir()
            else LEGACY_TEMPLATES_DIR)


def _templates_dir_flag(args: argparse.Namespace) -> str | None:
    """The template directory a flag names on THIS invocation, or ``None``.

    The two commands spell the directory differently, and that is not cosmetic. On
    ``gen`` it is ``--templates <dir>``. On ``verify`` ``--templates`` is the BOOLEAN
    prompt-drift subverb and the directory is ``--prompts <dir>`` (F101's converged
    spelling; ``--templates-root`` is its deprecated alias, and argparse lands both on
    ``templates_root``). Hence the isinstance check rather than a plain ``or`` chain:
    ``getattr(args, "templates")`` is a ``True`` on one of these commands, and ``or``
    would hand a boolean to a path join.
    """
    gen_dir = getattr(args, "templates", None)
    if isinstance(gen_dir, str) and gen_dir:
        return gen_dir
    return getattr(args, "templates_root", None)


def _template_root_for(args: argparse.Namespace) -> str:
    """The on-disk template root for THIS invocation. Never ``None``.

    EVERY path that builds a generator list must call this, for the same reason the C#
    port says it of its template-spec resolution: ``gen`` and ``verify --codegen``
    regenerate the same suite and diff the result, so if they resolve the template root
    differently, ``verify`` builds ``render-helper`` against another directory and
    reports the committed helpers as stale — with a remedy that loops, since
    regenerating cannot fix a disagreement about where the templates are. That is also
    why the fallback applies to BOTH commands: a default on one and not the other is the
    same disagreement wearing a different hat.
    """
    return _templates_dir_flag(args) or _default_template_root()


#: Where the run's settings are declared, as the refusals and the drift advice name it.
_CONFIG_NAME = "metaobjects.config.yaml"


def _refuse_column_naming_flag(args: argparse.Namespace) -> str | None:
    """ADR-0058 Decision 4 — ``--column-naming`` was removed in 1.1.0: naming is one
    project setting (``naming`` in ``.metaobjects/config.json``), read from the loaded
    root (``MetaRoot.naming``) by every resolver. Returns the refusal (``gen`` and
    ``verify`` print it and exit 2 before anything else runs) when the flag was given at
    all, else ``None``.
    """
    flag = getattr(args, "column_naming", None)
    if flag is None:
        return None
    return "error: " + removed_naming_source_message("--column-naming", flag)


def _template_root_for_config(args: argparse.Namespace, config: ProjectConfig) -> tuple[str, str | None]:
    """``(template root, refusal)`` for a config-driven run: ``templates`` in the config, else
    :func:`_template_root_for`. A ``--templates`` (``gen``) or ``--prompts`` (``verify``) that
    names another directory than the config is refused: the config declares the run's inputs
    once (ADR-0034 Amendment 9), and a flag that silently lost, or silently won, is how a plain
    ``metaobjects gen`` came to disagree with ``verify`` about where the templates are."""
    declared = config.templates_dir()
    if declared is None:
        return _template_root_for(args), None
    flag = _templates_dir_flag(args)
    if flag and Path(flag).resolve() != Path(declared):
        return declared, (
            f"error: the template directory {flag!r} contradicts templates: {config.templates} in "
            f"{_CONFIG_NAME}. The config declares it once; drop the flag, or change the config."
        )
    return declared, None


def _resolve_generators(
    names: str, ctx: GeneratorBuildContext | None = None, owned_root: Path | None = None,
) -> tuple[list[Generator], list[str]]:
    """Resolve a comma-separated list of STABLE generator names via the registry.

    An entry of the form ``module:symbol`` is an adopter-owned copy (``metaobjects
    eject``), imported with *owned_root* (default: the working directory) on ``sys.path``
    — the config directory in config mode, so a copy beside the config resolves.

    Returns ``(generators, errors)``. An unknown name produces a clear error and
    no generators (so the caller can fail with exit code != 0).

    *ctx* carries what a factory needs beyond the metadata — today the on-disk template
    root, which ``render-helper`` requires for its build-time drift gate. It used to be
    absent entirely: the registry hardcoded ``template_root="templates"``, so
    ``--templates`` reached the template-spec pass and nothing else, and selecting
    ``render-helper`` read a directory the user had never named.
    """
    if ctx is None:
        ctx = GeneratorBuildContext()
    requested = [n.strip() for n in names.split(",") if n.strip()]
    gens: list[Generator] = []
    errors: list[str] = []
    selected: list[str] = []
    for n in requested:
        entry = get_generator(n)
        if entry is None and (":" in n or "." in n):
            gen, err = owned.build_owned(n, owned_root or Path.cwd(), ctx)
            if err is not None:
                errors.append(err)
                continue
            gens.append(gen)
            selected.append(gen.name)
            continue
        if entry is None:
            known = ", ".join(sorted(GENERATOR_REGISTRY))
            errors.append(f"unknown generator {n!r}; known: {known}")
            continue
        gens.append(entry.factory(ctx))
        selected.append(n)
    if not errors and not gens:
        errors.append("no generators selected (empty --generators list)")
    if not errors:
        for warning in unsatisfied_requires(selected):
            print(f"warning: {warning}", file=sys.stderr)
    return gens, errors


def _parse_entities(value: str | None) -> list[str] | None:
    """Parse a comma-separated ``--entities`` value into a name list (``None`` =
    no filter = generate every entity). Blank names are dropped."""
    if not value:
        return None
    names = [n.strip() for n in value.split(",") if n.strip()]
    return names or None


def _refuse_imported_entities(
    entity_names: list[str] | None,
    root: MetaData,
    collection: Collection,
) -> str | None:
    """FR-023 §11.1 item 2 — the error message for a target's ``entities:`` (or
    ``--entities``) naming ONLY objects imported from a dependency and excluded
    from output (imported metadata is load-only by default; only the project's
    own `scope.include` naming the package literally opts it in). Returns
    `None` for every other case, INCLUDING a name matching nothing at all —
    that stays the runner's own "no entities matched" warning, unchanged.
    Mirrors the TS `refuseImportedPositional` (`cli/src/commands/gen.ts`).

    A named entity is a bare NAME, not a fully-qualified one, so two packages
    declaring the same short name are both candidates; the refusal fires only
    when NONE of them would generate.
    """
    if not entity_names:
        return None
    # ADR-0039 sanctioned own: top-level object scan on the loader ROOT
    # (metadata.root is never extended, so own == effective) — mirrors
    # `codegen.runner._objects`.
    all_objects = [
        c for c in root.own_children() if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    ]
    for name in entity_names:
        matches = [o for o in all_objects if o.name == name]
        if not matches:
            continue  # nothing loaded by this name — the runner's own warning covers it
        all_excluded = all(
            collection.imported(o.resolution_key()) and not collection.in_scope(o.resolution_key())
            for o in matches
        )
        if not all_excluded:
            continue
        fqn = matches[0].resolution_key()
        pkg = package_of_resolution_key(fqn)
        dep_name = imported_from(pkg, collection.dependencies) or pkg
        return (
            f"error: '{name}' ({fqn}) is imported from dependency '{dep_name}' and is not "
            "generated here — add its package to scope.include in .metaobjects/config.json"
        )
    return None


def _run_suite(
    root: MetaData,
    out_dir: str,
    generators: list[Generator] | None = None,
    entity_filter: list[str] | None = None,
    emit_package_init: bool = True,
    gen_state_dir: str | None = None,
    column_naming: str = DEFAULT_COLUMN_NAMING,
    project_root: str | None = None,
    baseline: str = "default",
    refused_out: list[str] | None = None,
    select: Callable[[str], bool] | None = None,
    overwrite_hand_edits: frozenset[str] = frozenset(),
    overwrite_paths_out: set[str] | None = None,
) -> list[str]:
    """Run a generator suite against an ALREADY-LOADED ``root`` into ``out_dir``.

    ``overwrite_hand_edits`` names the generators (by ``.name``) declared
    ``handEdits: overwrite``: a hand-edited file of theirs is replaced with fresh output
    instead of refused. ``overwrite_paths_out`` collects every path those generators emitted,
    which is how ``verify --codegen`` knows that ``gen`` would replace an edit.

    Split out from :func:`_generate` so a single gen invocation can load the
    metadata once and run multiple passes against it (the default Python suite +
    the ``--template-spec`` pass). See :func:`_generate` for the parameter
    semantics. Returns the written paths.

    ``select`` (FR-023 §11.1 item 2) — normally a resolved `Collection`'s
    `in_scope`: the output filter that excludes an imported dependency's
    objects from codegen unless the project's own `scope.include` names their
    package. `None` (the default) admits everything, byte-identical to a
    project with no dependencies.

    NOTE: ``run_gen``'s output-path collision guard is per-pass — a
    ``--template-spec`` ``outputPattern`` that collides with a default-suite path
    is not flagged across the two passes (it would overwrite, since default files
    carry the ``@generated`` header). Accepted marginal limitation (requires user
    misconfiguration).
    """
    # The hash manifest gives `metaobjects gen` hand-edit detection: without it the
    # write path falls back to the legacy @generated-marker rule, which cannot tell an
    # edited generated file from a pristine one (an edited file keeps its marker).
    # COMMIT `.gen-state/.hashes.json`.
    #
    # Anchored on the caller's project, NEVER on `Path.cwd()`. cwd is whatever directory
    # the process happens to sit in, so a cwd default leaks a `.metaobjects/` into any
    # package that merely runs a test through this function — the exact leak codegen-ts's
    # runner refuses, for the same reason. No project ⇒ no manifest ⇒ documented weaker
    # guarantees, rather than state scattered somewhere arbitrary.
    config = GenConfig(
        out_dir=out_dir,
        emit_package_init=emit_package_init,
        gen_state_dir=gen_state_dir,
        column_naming=column_naming,
        # Manifest keys are relative to the PROJECT, which is what the manifest is
        # anchored on — not to ``--out``, which varies per run while the manifest does
        # not. Passed alongside gen_state_dir because the two are one decision: state
        # that lives in the project must be keyed by the project.
        project_root=project_root,
        # `--baseline=adopt`: record what is on disk and write nothing. The refusal it
        # exists for is the pre-manifest one, so it reaches every real gen path and no
        # verify path (those pass gen_state_dir=None and record nothing at all).
        baseline=baseline,
        overwrite_hand_edits=overwrite_hand_edits,
    )
    # No default suite — see NO_GENERATORS_SELECTED. A caller that names none gets a
    # usage error and an empty out dir, never a shape this CLI picked.
    if not generators:
        raise NoGeneratorsSelectedError
    suite = generators
    result = run_gen(config, root, generators=suite, entity_filter=entity_filter, select=select)
    if overwrite_paths_out is not None:
        overwrite_paths_out.update(
            path for path, by in result.generated_by.items() if by in overwrite_hand_edits
        )
    for warning in result.warnings:
        print(f"warning: {warning}")
    # A refusal is a FAILED gate, and the return value carries only what was WRITTEN — so
    # without this the one fact a CI step reads (the exit code) could not see it. An
    # out-list rather than a changed return type: five call sites read the written paths,
    # and only the ones that own an exit code care about the refusals.
    if refused_out is not None:
        refused_out.extend(path for path, status in result.files if status == "refused")
    return [path for path, status in result.files if status != "refused"]


def gen_state_dir_for(metadata_dir: str) -> str:
    """Where a project's codegen hash manifest lives.

    Anchored on the project — never on ``Path.cwd()``, which is whatever directory the
    process happens to sit in and would scatter ``.metaobjects/`` into any package that
    merely runs a generator.

    It resolves the project through :func:`project_root_for` rather than repeating
    ``Path(metadata_dir).resolve().parent``. That function's own docstring already claimed
    this one "is anchored here" while the code spelled the rule out a second time, and the
    manifest key and the manifest LOCATION have to agree on where the project is or a
    lookup finds nothing and every file reads as "not ours".
    """
    return str(project_root_for(metadata_dir) / ".metaobjects" / ".gen-state")


#: The conventional declarative-template-spec file (SP-1 §4), discovered when
#: ``--template-spec`` is not passed. VISIBLE and at the project root on purpose:
#: this repo splits author input (visible — ``metaobjects/``, ``templates/``) from
#: tool state (hidden — ``.metaobjects/``), and a spec is authored, not generated.
#: It also sits beside the ``templates/`` dir its refs resolve under.
TEMPLATE_SPEC_FILENAME = "template-spec.json"


def project_root_for(metadata_dir: str) -> Path:
    """The project a metadata directory belongs to: its PARENT — the directory
    holding ``metaobjects/``. Same rule as :func:`gen_state_dir_for` (which is
    anchored here) and the C# port's ``GenCommand.ProjectRootFor``."""
    return Path(metadata_dir).resolve().parent


def template_spec_path_for(metadata_dir: str, explicit: str | None) -> str | None:
    """Resolve the template-spec to use, or ``None`` for "no template generators".

    An explicit ``--template-spec`` always wins and is used verbatim (a flag naming
    a missing file stays a hard error at read time — silently ignoring a path the
    user typed would be worse). Otherwise the conventional
    ``<projectRoot>/template-spec.json`` is used IF it exists.

    **Every code path that builds a generator list must call this.** The defect this
    exists to prevent is `gen` and `verify --codegen` resolving the spec differently:
    `gen` honoured the flag while `verify` built its own list and never looked, so
    `verify` regenerated WITHOUT the template generators and reported their committed
    output as stale — with a remedy that loops (regenerating cannot produce files the
    regen does not know about).
    """
    if explicit:
        return explicit
    candidate = project_root_for(metadata_dir) / TEMPLATE_SPEC_FILENAME
    return str(candidate) if candidate.is_file() else None


def template_spec_generators(
    metadata_dir: str, explicit: str | None, templates_dir: str,
) -> tuple[list[Generator], str | None]:
    """The declarative Mustache generators for this project, or an error message.

    Returns ``(generators, None)`` on success — an EMPTY list when there is no spec
    at all — and ``([], message)`` when a spec was found but could not be used.
    """
    spec_path = template_spec_path_for(metadata_dir, explicit)
    if spec_path is None:
        return [], None
    from metaobjects.codegen.template_codegen.template_spec import (
        parse_template_spec,
        template_spec_to_generators,
    )

    try:
        spec = parse_template_spec(json.loads(Path(spec_path).read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        return [], f"error: invalid template-spec {spec_path!r}: {exc}"
    return template_spec_to_generators(spec, FilesystemProvider(templates_dir)), None


def resolve_metadata_location(
    config: ProjectConfig | None,
    root: Path,
) -> Collection:
    """The precedence ladder for where metadata lives, rungs 2-4. First match wins.
    Returns the full FR-023-aware `Collection` at EVERY rung — `dependencies` (and
    `scope`/`migrate.scope`) are read from `root`'s neutral `.metaobjects/config.json`
    regardless of which rung supplied the OWN files (DESIGN §2.3).

    2. This port's native surface — ``metadata`` in ``metaobjects.config.yaml``, when the
       file names it (a config that does not falls through to rungs 3-4).
    3. ``sources`` in the port-neutral ``.metaobjects/config.json``.
    4. The built-in default directory.

    Rung 1 — an explicit CLI argument (the positional ``metadata_dir``) — is
    NOT this function's concern: every command handler that accepts one already
    loads it directly via ``_load_root(args.metadata_dir)`` (``MetaDataLoader
    .from_directory``, a single-directory load with no resolve-then-rejoin step
    of its own) BEFORE this function would even be reachable, so this function is
    only ever called with rung 1 already having been tried and found absent. An
    earlier revision accepted an ``explicit`` parameter and duplicated rung 1
    here via `resolve_sources` — reachable from no command handler, so it could
    silently drift from the real rung-1 path (e.g. picking up
    `source_resolver.py`'s CLI-facing `_pending` exclusion while
    `_load_root`'s loader-level walk does not) with nothing to notice. Removed
    rather than wired: replumbing every metadataDir-taking command onto
    `resolve_sources`'s `from_uris`-based load instead of `from_directory` is a
    materially different, higher-risk change than this ladder needs.

    A file that EXISTS at any rung but is malformed raises rather than falling
    through to the next rung. See
    `docs/superpowers/specs/2026-08-19-cross-port-metadata-sources-design.md` §5.
    """
    from metaobjects.config.source_resolver import (
        build_collection,
        resolve_collection_full,
        resolve_sources,
    )

    if config is not None and config.metadata_declared:
        # `config.metadata_dir()` is already resolved to an absolute path
        # (`ProjectConfig._resolve_under`), so the base passed here is
        # likewise irrelevant to resolving OWN files — but `root` is still
        # where `.metaobjects/config.json` (dependencies/scope) is read from.
        own_files = resolve_sources(root, [{"path": config.metadata_dir()}])
        return build_collection(root, own_files)

    # Rungs 3 and 4 both live in `resolve_collection_full`.
    return resolve_collection_full(root)


def _resolve_metadata_location_or_print_error(
    config: ProjectConfig | None, root: Path
) -> Collection | None:
    """``resolve_metadata_location`` for the no-explicit-``metadata_dir`` CLI
    paths (``docs``, and the ``gen``/``verify --codegen`` neutral fallbacks),
    translating a raised ``ParseError`` into this CLI's print-and-return-1
    convention instead of letting it propagate. Returns ``None`` on failure —
    the caller has nothing further to print and should return 1.
    """
    try:
        return resolve_metadata_location(config=config, root=root)
    except ParseError as exc:
        print(f"error: could not resolve metadata location: {exc}", file=sys.stderr)
        return None


#: ADR-0034 Amendment 3: generators are reference helpers you own with ``metaobjects
#: eject``. Printed above the ``--list`` entries.
LIST_HEADER = (
    "Reference generators — each is a helper, not a guarantee: `metaobjects eject <name>`\n"
    "copies it into codegen/generators/ and the copy is yours to change. What MetaObjects\n"
    "guarantees (verify, render) is not a generator and is not listed.\n"
    "Select with --generators <name,...>:"
)


def _cmd_list(_args: argparse.Namespace) -> int:
    """Print each registered generator ``<stable-name> — <description>`` and exit 0.

    Does NOT run codegen — pure discoverability (ADR-0021 D3).
    """
    print(LIST_HEADER)
    root = Path.cwd()
    for entry in list_generators():
        requires = f" (requires: {', '.join(entry.requires)})" if entry.requires else ""
        status = owned.owned_status(root, entry)
        mark = f" [owned — {status}]" if status is not None else ""
        print(f"{entry.name} — {entry.description}{requires}{mark}")
    for path, status in owned.runtime_status(root):
        print(f"runtime {path.as_posix()} [owned — {status}]")
    return 0


def _describe_fmt_report(report: "object", cwd: Path) -> str:
    from metaobjects import fmt

    try:
        rel = report.path.relative_to(cwd)
    except ValueError:
        rel = report.path
    if report.status == fmt.STATUS_FORMATTED:
        return f"  reformatted  {rel}"
    if report.status == fmt.STATUS_WOULD_FORMAT:
        return f"  not canonical  {rel}"
    if report.status == fmt.STATUS_UNCHANGED:
        return f"  ok           {rel}"
    if report.status == fmt.STATUS_SKIPPED_YAML:
        return f"  skipped (yaml)     {rel} — {report.detail}"
    if report.status == fmt.STATUS_SKIPPED_OVERLAY:
        return (
            f"  skipped (overlay)  {rel} — this file declares an overlay fmt "
            "cannot resolve standalone"
        )
    if report.status == fmt.STATUS_ERROR:
        return f"  error        {rel} — {report.detail}"
    return f"  {report.status}  {rel}"  # pragma: no cover — exhaustive in practice


def _cmd_fmt(args: argparse.Namespace) -> int:
    """``fmt`` (#304) — rewrite metadata files into canonical form; ``--check``
    lists non-canonical files and exits non-zero without changing anything.

    Mirrors the TS reference surface exactly: no ``metadata_dir`` positional —
    files come from the neutral ``.metaobjects/config.json`` ladder
    (:func:`resolve_metadata_location`, rungs 3-4; this command does not read
    this port's own ``metaobjects.config.yaml`` rung 2, matching the scope the
    C# and Java ports also keep for `fmt`), optionally narrowed by explicit
    file arguments.
    """
    from metaobjects import fmt
    from metaobjects.core_types import core_providers
    from metaobjects.library import library_sources
    from metaobjects.provider import compose_registry

    providers_extra, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1
    providers = [*core_providers, *providers_extra]
    registry = compose_registry(providers)

    cwd = Path.cwd()
    collection = _resolve_metadata_location_or_print_error(None, cwd)
    if collection is None:
        return 1

    all_files = list(collection.files)
    own_files = list(collection.own_files)

    if args.files:
        wanted = [Path(f).resolve() for f in args.files]
        owned_set = {p.resolve() for p in own_files}
        missing = [str(p) for p in wanted if p not in owned_set]
        if missing:
            print(
                "error: not among this project's resolved metadata sources: "
                + ", ".join(missing),
                file=sys.stderr,
            )
            print(
                "metaobjects fmt only formats files the metadata-location ladder "
                "already resolves — pass no arguments to format every one of them.",
                file=sys.stderr,
            )
            return 1
        wanted_set = {p for p in wanted}
        targets = [p for p in own_files if p.resolve() in wanted_set]
    else:
        targets = own_files

    lib_sources = library_sources(list(collection.libraries)) if collection.libraries else []

    result = fmt.run(
        all_files=all_files,
        target_files=targets,
        file_ids=dict(collection.file_ids),
        registry=registry,
        lib_sources=lib_sources,
        check=bool(args.check),
        providers=providers,
    )

    if result.fatal is not None:
        print(f"error: {result.fatal}", file=sys.stderr)
        return 1

    if not result.files:
        print("metaobjects fmt — no metadata files to format.")
        return 0

    for report in result.files:
        print(_describe_fmt_report(report, cwd))

    errored = sum(1 for r in result.files if r.status == fmt.STATUS_ERROR)
    needs_format = sum(1 for r in result.files if r.status == fmt.STATUS_WOULD_FORMAT)
    reformatted = sum(1 for r in result.files if r.status == fmt.STATUS_FORMATTED)

    if args.check:
        if needs_format or errored:
            suffix = f", {errored} error(s)" if errored else ""
            print(
                f"metaobjects fmt --check — {needs_format} file(s) not canonical{suffix}. "
                "Run `metaobjects fmt` to fix.",
                file=sys.stderr,
            )
            return 1
        print("metaobjects fmt --check — every file is already canonical.")
        return 0

    if errored:
        print(
            f"metaobjects fmt — {errored} file(s) could not be formatted safely (left unchanged).",
            file=sys.stderr,
        )
        return 1

    print(f"metaobjects fmt — {reformatted} file(s) reformatted.")
    return 0


def _cmd_eject(args: argparse.Namespace) -> int:
    """Copy reference generators into ``codegen/generators/`` to own (ADR-0034 Am. 3)."""
    root = Path(args.root) if args.root else Path.cwd()
    result = owned.eject(args.names, root, force=args.force)
    for line in result.out:
        print(line)
    for line in result.err:
        print(f"error: {line}", file=sys.stderr)
    return result.code


def _warn_if_agent_context_stale() -> None:
    """Print ONE advisory line to stderr if the scaffolded agent context is stale.

    Reads ``<cwd>/.metaobjects/.agent-context.json`` (if present), compares its
    stamped ``generatedBy`` to the installed version, and nudges a re-scaffold on
    any drift. Advisory only: never raises, never changes the exit code, never
    writes — a missing or corrupt manifest is silently ignored.
    """
    try:
        manifest_path = Path.cwd() / AGENT_CONTEXT_MANIFEST_PATH
        if not manifest_path.is_file():
            return
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            return
        msg = agent_context_staleness(manifest, installed_metaobjects_version())
        if msg is not None:
            print(msg, file=sys.stderr)
    except Exception:  # noqa: BLE001 — advisory; any failure is silently ignored
        return


def _cmd_gen(args: argparse.Namespace) -> int:
    naming_refusal = _refuse_column_naming_flag(args)
    if naming_refusal is not None:
        print(naming_refusal, file=sys.stderr)
        return 2
    # `--list` is a pure discoverability path: print the registry and exit, no codegen.
    if getattr(args, "list", False):
        return _cmd_list(args)

    _warn_if_agent_context_stale()
    return _cmd_gen_config(args)


def _load_generator_list(
    args: argparse.Namespace, command: str
) -> tuple[ProjectConfig | None, int]:
    """The project's generator list — ``metaobjects.config.yaml`` — for ``gen`` and ``verify
    --codegen``, or ``(None, exit_code)`` after printing why there is none.

    ADR-0034 Amendment 9: nothing is generated that the config does not declare, so a run
    with no config fails rather than generating something this CLI chose, and a config that
    still carries the 1.0 ``docs`` block fails before anything is written: nothing reads it,
    and a passing run would write no documentation."""
    config_path = _find_config(args)
    if config_path is None:
        print(no_generator_list_message(command), file=sys.stderr)
        return None, 2
    try:
        config = load_project_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return None, 1
    if config.legacy_docs:
        print(legacy_docs_message(command), file=sys.stderr)
        return None, 2
    unlisted = [t.name for t in config.targets if t.generators is None]
    if unlisted:
        print(
            f"{command}: target(s) {', '.join(repr(n) for n in unlisted)} declare no `generators` "
            "key. In 1.1.0 a target runs only the generators it lists: list them, or write "
            "`generators: []` for a target that writes nothing. " + _MIGRATION_SECTION,
            file=sys.stderr,
        )
        return None, 2
    conventional = project_root_for(config.metadata_dir()) / TEMPLATE_SPEC_FILENAME
    if conventional.is_file() and not any(t.template_spec for t in config.targets):
        print(legacy_template_spec_message(command), file=sys.stderr)
        return None, 2
    return config, 0


def _selection_from_args(args: argparse.Namespace) -> list[str] | None:
    """The ``--generators`` names, or ``None`` for the whole list. A blank ``--generators``
    gives ``[]``, which :func:`_refuse_narrowing` refuses."""
    raw = getattr(args, "generators", None)
    if raw is None:
        return None
    return [n.strip() for n in raw.split(",") if n.strip()]


def _refuse_narrowing(
    args: argparse.Namespace, selection: list[str] | None, root: MetaData, command: str
) -> bool:
    """A narrowing that names nothing: a blank ``--generators`` (an unset shell variable)
    would run the whole list, and an ``--entities`` name that matches no object would
    generate, and so check, nothing. Refused, exit 2."""
    if selection == []:
        print(f"error: {command}: --generators names no generator.", file=sys.stderr)
        return True
    names = _parse_entities(getattr(args, "entities", None))
    if names is None and getattr(args, "entities", None) is not None:
        print(f"error: {command}: --entities names no object.", file=sys.stderr)
        return True
    # ADR-0039 sanctioned own: top-level object scan on the loader ROOT (metadata.root is
    # never extended, so own == effective), as in `_refuse_imported_entities`.
    known = {c.name for c in root.own_children() if c.type == TYPE_OBJECT}
    unknown = [n for n in names or [] if n not in known]
    if unknown:
        print(
            f"error: {command}: --entities names {', '.join(repr(n) for n in unknown)}, "
            "which matches no object in the metadata.",
            file=sys.stderr,
        )
        return True
    return False


def _narrow_entities(
    targets: list[TargetConfig], args: argparse.Namespace
) -> list[TargetConfig]:
    """Apply ``--entities`` to each target: only the named entities are emitted, and a
    target that already lists ``entities`` keeps only the names in both."""
    names = _parse_entities(getattr(args, "entities", None))
    if names is None:
        return targets
    return [
        dataclasses.replace(
            t, entities=names if t.entities is None else [n for n in t.entities if n in names]
        )
        for t in targets
    ]


def _refuse_template_spec_flag(args: argparse.Namespace, command: str) -> bool:
    """``--template-spec`` names no target, and every output directory is a target's, so it
    has nowhere to write. Refused with the key that replaces it."""
    if not getattr(args, "template_spec", None):
        return False
    print(
        f"error: {command}: --template-spec is not read; declare the spec on the target it "
        "writes into, as `templateSpec: <path>` beside its `outDir` in metaobjects.config.yaml.",
        file=sys.stderr,
    )
    return True


def _run_gen_targets(
    config: ProjectConfig,
    targets: list[TargetConfig],
    root: MetaData,
    *,
    gen_state_dir: str | None = None,
    project_root: str | None = None,
    baseline: str = "default",
    refused_out: list[str] | None = None,
    select: Callable[[str], bool] | None = None,
    build_ctx: GeneratorBuildContext | None = None,
    column_naming: str = DEFAULT_COLUMN_NAMING,
    selection: list[str] | None = None,
    targeted_out: set[str] | None = None,
    overwrite_paths_out: set[str] | None = None,
) -> tuple[list[str], list[str]]:
    """Run each target's declared generators into its ``outDir``. Returns (all_written, errors).

    The list is the config (ADR-0034 Amendment 9): a target runs the ``generators`` it lists,
    then the generators of its ``templateSpec`` (a second pass with no ``__init__.py``, since
    their output need not be Python). ``selection`` — the ``--generators`` names — narrows
    that to the declared entries named, across every target; a name no target declares is
    an error, reported before anything is written. A target that declares nothing writes
    nothing and says so.

    This is the path the manifest keying matters most on: every target writes into its
    OWN ``outDir`` while all of them share ONE ``gen_state_dir``, so out-dir-relative
    keys meant target B's hash could claim ownership of target A's identically-named
    file. ``project_root`` is the common anchor that makes the keys distinct.

    Cross-target duplicate-output-path guard (#267): ``run_gen``'s collision guard
    is per-pass, so two targets writing the same full path would silently clobber
    (generated files carry the @generated header). We accumulate every written full
    path across targets and record an error when two targets emit the same one.
    (Detection is post-write — the colliding file may already be on disk — but the
    command still fails, so a misconfigured gate is caught in CI.)

    ``select`` (FR-023 §11.1 item 2) — see :func:`_run_suite`; the SAME predicate
    applies to every target, since a `Collection`'s scope is project-wide.

    ``targeted_out`` collects the ``outDir`` of every target with a declared entry left to
    run after ``selection``: decided from the config, whatever the entries then emit.

    A generator entry written as ``{name: ..., handEdits: overwrite}`` replaces its
    hand-edited files instead of refusing them; ``overwrite_paths_out`` collects the paths
    such entries emitted (see :func:`_run_suite`).
    """
    all_written: list[str] = []
    seen: dict[str, str] = {}  # full path -> target name
    errors: list[str] = []
    # The `requirementTests` and `apiDocs` blocks reach a generator factory (packaged or
    # owned) through the build context, so `gen` and `verify --codegen` build it identically.
    requirement_tests, hook_errors = _requirement_tests_options(config)
    if hook_errors:
        return [], hook_errors
    ctx = dataclasses.replace(
        build_ctx or GeneratorBuildContext(),
        requirement_tests=requirement_tests,
        api_docs=config.api_docs,
    )
    template_root = ctx.template_root or _default_template_root()
    packaged_names = {
        name: entry.factory(ctx).name
        for name in selection or []
        if (entry := get_generator(name)) is not None
    }
    matched: set[str] = set()

    def selected(gen: Generator, token: str) -> bool:
        if selection is None:
            return True
        hits = [
            n for n in selection
            if token == n or gen.name == n or packaged_names.get(n) == gen.name
        ]
        matched.update(hits)
        return bool(hits)

    # Resolve every target first, so a bad entry or an undeclared --generators name fails
    # the run before any target writes.
    plan: list[tuple[TargetConfig, list[Generator], list[Generator], frozenset[str]]] = []
    for t in targets:
        gens: list[Generator] = []
        commas = [tok for tok in t.generators or [] if "," in tok]
        if commas:
            errors.extend(
                f"target '{t.name}': generators entry {tok!r} holds a comma; list each "
                "generator as an entry of its own." for tok in commas
            )
            continue
        if t.generators:
            gens, gen_errors = _resolve_generators(
                ",".join(t.generators), ctx, owned_root=config.config_dir)
            if gen_errors:
                errors.extend(f"target '{t.name}': {m}" for m in gen_errors)
                continue
            overwrite = frozenset(
                g.name for g, tok in zip(gens, t.generators) if tok in t.overwrite_hand_edits
            )
            gens = [g for g, tok in zip(gens, t.generators) if selected(g, tok)]
        else:
            overwrite = frozenset()
        spec_gens: list[Generator] = []
        spec_path = config.template_spec_for(t)
        if spec_path is not None:
            spec_gens, spec_err = template_spec_generators(
                config.metadata_dir(), spec_path, template_root)
            if spec_err is not None:
                errors.append(f"target '{t.name}': {spec_err}")
                continue
            spec_gens = [g for g in spec_gens if selected(g, g.name)]
        plan.append((t, gens, spec_gens, overwrite))
    if selection is not None:
        undeclared = [n for n in selection if n not in matched]
        if undeclared:
            errors.append(
                f"--generators names {', '.join(repr(n) for n in undeclared)}, which no target "
                "in metaobjects.config.yaml declares. --generators only narrows the declared "
                "list; add the entry to a target's `generators` to run it."
            )
    if errors:
        return [], errors

    from metaobjects.render.renderer import RenderError

    for t, gens, spec_gens, overwrite in plan:
        if not gens and not spec_gens:
            print(f"target '{t.name}' declares no generators; nothing written")
            continue
        out_dir = config.out_dir_for(t)
        if targeted_out is not None:
            targeted_out.add(out_dir)
        written: list[str] = []
        try:
            if gens:
                written = _run_suite(
                    root, out_dir, gens, t.entities, gen_state_dir=gen_state_dir,
                    column_naming=column_naming, project_root=project_root, baseline=baseline,
                    refused_out=refused_out, select=select,
                    overwrite_hand_edits=overwrite, overwrite_paths_out=overwrite_paths_out,
                )
            if spec_gens:
                written = written + _run_suite(
                    root, out_dir, spec_gens, t.entities, emit_package_init=False,
                    gen_state_dir=gen_state_dir, column_naming=column_naming,
                    project_root=project_root, baseline=baseline, refused_out=refused_out,
                    select=select,
                )
        except ValueError as exc:  # intra-target run_gen collision → clean error
            errors.append(f"target '{t.name}': {exc}")
            continue
        except RenderError as exc:
            errors.append(
                f"target '{t.name}': template-spec render failed (check the templateSpec's "
                f"template refs and the --templates dir {template_root!r}): {exc}"
            )
            continue
        for full in written:
            if Path(full).name == "__init__.py":
                continue  # auto-emitted package marker — byte-identical across targets sharing an outDir; not a real collision
            prior = seen.get(full)
            if prior is not None and prior != t.name:
                errors.append(
                    f"duplicate output path across targets: {full!r} written by "
                    f"both '{prior}' and '{t.name}'."
                )
            else:
                seen[full] = t.name
        all_written.extend(written)
    return all_written, errors


def _cmd_gen_config(args: argparse.Namespace) -> int:
    """``gen`` — run the generator list in ``metaobjects.config.yaml`` (ADR-0034 Amendment 9).

    Load the config, load metadata ONCE, and run every target (or ``--target``) into its own
    ``outDir`` with a cross-target duplicate-path guard. ``--generators`` narrows the run to
    the declared entries named. Providers resolve relative to the config file (no
    ``PYTHONPATH=``). No ``metaobjects.config.yaml`` is an error: the list lives there.
    """
    config, code = _load_generator_list(args, "metaobjects gen")
    if config is None:
        return code
    if args.metadata_dir is not None or args.out is not None:
        print(FLAG_FORM_NOT_READ.format(command="metaobjects gen"), file=sys.stderr)
        return 2
    if _refuse_template_spec_flag(args, "metaobjects gen"):
        return 2

    targets, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1
    targets = _narrow_entities(targets, args)

    providers, providers_ok = _config_providers(config)
    if not providers_ok:
        return 1
    flag_providers, flag_providers_ok = _providers_from_args(args)
    if not flag_providers_ok:
        return 1
    providers = [*providers, *flag_providers]

    # FR-023: rung 2 (this native `metaobjects.config.yaml` surface) still reads
    # `dependencies`/`scope`/`migrate.scope` from the project's neutral
    # `.metaobjects/config.json` (DESIGN §2.3 — dependencies apply at EVERY rung).
    collection = _resolve_metadata_location_or_print_error(
        config, project_root_for(config.metadata_dir())
    )
    if collection is None:
        return 1

    unknown_attrs: list[str] = []
    root, load_errors = _load_root_from_collection(
        collection, providers=providers, libraries=config.libraries,
        unknown_attr_out=unknown_attrs,
    )
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        return 1
    _print_unknown_attr_warnings(unknown_attrs)

    template_root, templates_refusal = _template_root_for_config(args, config)
    if templates_refusal is not None:
        print(templates_refusal, file=sys.stderr)
        return 2
    # ADR-0058 Decision 3 — the loaded root's `naming` (set from `.metaobjects/
    # config.json` at load time) is THE strategy; never a flag or a config key.
    column_naming = root.naming.columns

    selection = _selection_from_args(args)
    if _refuse_narrowing(args, selection, root, "metaobjects gen"):
        return 2
    for t in targets:
        imported_refusal = _refuse_imported_entities(t.entities, root, collection)
        if imported_refusal is not None:
            print(imported_refusal, file=sys.stderr)
            return 2

    refused: list[str] = []
    targeted: set[str] = set()
    baseline = getattr(args, "baseline", None) or "default"
    gen_state_dir = gen_state_dir_for(config.metadata_dir())
    project_root = str(project_root_for(config.metadata_dir()))
    written, errors = _run_gen_targets(
        config, targets, root,
        gen_state_dir=gen_state_dir,
        project_root=project_root,
        baseline=baseline,
        refused_out=refused,
        select=collection.in_scope,
        build_ctx=GeneratorBuildContext(template_root),
        column_naming=column_naming,
        selection=selection,
        targeted_out=targeted,
    )
    if errors:
        for msg in errors:
            print(f"error: {msg}", file=sys.stderr)
        return 1
    for path in written:
        print(path)
    removed = _sweep_orphans_after_gen(
        args, config, targets, targeted, selection, baseline, gen_state_dir, project_root,
        emitted={*written, *refused},
    )
    for path in removed:
        print(f"removed {path}")
    print(
        f"metaobjects gen: wrote {len(written)} file(s) across {len(targets)} target(s)."
        + (f" Removed {len(removed)} file(s) no generator emits any more." if removed else "")
    )
    if refused:
        # A refusal is a failed gate, matching TypeScript's `meta gen` (exit 1). Python and
        # C# used to warn and exit 0, so an adopter wiring this into CI as a drift gate was
        # green while codegen refused to write — a gate that did not gate. The warnings
        # above carry the detail; this line carries the verdict.
        print(
            f"metaobjects gen: FAILED — {len(refused)} file(s) refused (see the warnings "
            f"above; `--baseline=adopt` records what you have and writes nothing)",
            file=sys.stderr,
        )
        return 1
    return 0


def _sweep_orphans_after_gen(
    args: argparse.Namespace,
    config: ProjectConfig,
    targets: list[TargetConfig],
    targeted: set[str],
    selection: list[str] | None,
    baseline: str,
    gen_state_dir: str,
    project_root: str,
    *,
    emitted: set[str],
) -> list[str]:
    """Delete what this run no longer generates (``codegen/orphan_sweep.py``) and return
    the paths removed. Only a run of the WHOLE declared output into a directory sweeps it.

    ``--generators`` and ``--entities`` narrow the output by construction, so every file of
    the part left out would look orphaned: those runs sweep nothing and say so when there
    was something to sweep. ``--target`` sweeps a directory only when every target writing
    into it ran. ``--baseline=adopt`` writes nothing, so it deletes nothing either.
    """
    if baseline == "adopt":
        return []
    ran = {t.name for t in targets}
    out_dirs = sorted(
        out for out in targeted
        if all(t.name in ran for t in config.targets if config.out_dir_for(t) == out)
    )
    narrowed = selection is not None or _parse_entities(getattr(args, "entities", None)) is not None
    if narrowed:
        pending = sweep_orphans(gen_state_dir, project_root, out_dirs, emitted, dry_run=True)
        if pending.removed or pending.refused:
            print(
                "warning: Skipped orphan cleanup: this run was narrowed by --generators or "
                "--entities, so it cannot tell a file the rest of the list writes from one no "
                "generator emits any more. Run `metaobjects gen` without them to delete "
                "generated files that are no longer generated."
            )
        return []
    result = sweep_orphans(
        gen_state_dir, project_root, out_dirs, emitted,
        overwrite_dirs=frozenset(out for out in out_dirs if _overwrites_hand_edits(config, out)),
    )
    for key in result.discarded:
        print(
            f"warning: deleted hand-edited {key}, which no generator emits any more "
            "(handEdits: overwrite)"
        )
    if result.refused:
        print(f"warning: {refused_orphan_message(result.refused)}")
    return result.removed


def _overwrites_hand_edits(config: ProjectConfig, out_dir: str) -> bool:
    """True when every generator writing into ``out_dir`` is declared ``handEdits: overwrite``.

    The manifest does not record which generator wrote a file, so an edited orphan can be
    deleted only when no generator sharing its directory asked to keep hand edits. A
    ``templateSpec`` pass has no entry to carry the setting, so it always keeps.
    """
    sharing = [t for t in config.targets if config.out_dir_for(t) == out_dir]
    return bool(sharing) and all(
        t.generators
        and config.template_spec_for(t) is None
        and all(tok in t.overwrite_hand_edits for tok in t.generators)
        for t in sharing
    )


#: Never compared: interpreter droppings, not generated artifacts. A committed
#: ``__pycache__`` would otherwise read as drift on every run.
_UNCOMPARED_DIRS = {"__pycache__", ".gen-state", ".metaobjects"}
_UNCOMPARED_SUFFIXES = {".pyc", ".pyo"}


def _relative_set(root: Path) -> dict[str, str]:
    """Map every generated-artifact file under ``root`` to its content, keyed by rel path.

    Deliberately NOT scoped to ``*.py``. It was, with a note saying to broaden it "if a
    generator ever emits a non-``.py`` artifact" — and one does: the declarative
    ``--template-spec`` generators emit text/markdown/csv/json/xml/html by design. The
    consequence was a gate that answered ``in sync`` with a template-emitted file
    DELETED and another CORRUPTED, because neither was a ``.py`` and neither was
    compared. A gate silent about its own output is worse than one that is wrong.

    Binary files are skipped rather than decoded: every generator this project ships
    emits text, so an undecodable file is by definition not ours.
    """
    files: dict[str, str] = {}
    if not root.exists():
        return files
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if any(part in _UNCOMPARED_DIRS for part in rel.parts):
            continue
        if p.suffix in _UNCOMPARED_SUFFIXES:
            continue
        try:
            files[str(rel)] = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
    return files


def _out_prefix(out_dir: str, project_root: Path) -> str:
    """The out dir, relative to the project — the translation between this diff's
    out-dir-relative keys and the manifest's project-relative ones.

    BOTH SIDES RESOLVED, and that is the whole content of this function. `project_root`
    arrives resolved; relpath from a resolved anchor to an unresolved path is not the
    path between the two directories, and under a directory symlink it walks OUT of the
    project. Every lookup then misses, `is_ours` is false for every file, and the gate
    prints a clean verdict over stale output — silent in the direction that matters.
    It is written once here rather than at each of the three call sites, because three
    spellings of one translation is how they came to disagree in the first place.
    """
    return os.path.relpath(Path(out_dir).resolve(), project_root)


def _is_ours_for(gen_state_dir: str | None, out_prefix: str = ""):
    """Jurisdiction predicate for the ``extra`` verdict: did WE write this path?

    ``out_dir`` is a DIRECTORY, not a namespace this tool owns — the same ruling the
    TypeScript gate reached (0.24.3), for the same reason. Broadening the comparison
    beyond ``*.py`` means the gate now sees every stranger's file too, and convicting
    those turns a project with zero drift into a red build.

    The manifest already records what we WROTE, so it answers the ownership question
    exactly — but it is keyed relative to the PROJECT while this diff is keyed relative
    to ``out_dir``. ``out_prefix`` (the out dir, relative to the project) is what turns
    one into the other. Getting this wrong is silent in the direction that matters: a
    lookup that finds nothing makes ``is_ours`` false for every file, and the gate simply
    stops reporting stale output while still printing a clean verdict.

    The out-dir-relative name is tried as a fallback, because that is how a manifest
    written before the re-keying spells it — the same fallback ``decide_and_write``
    makes, so the write path and the gate cannot disagree about which entry is a record
    of this file.

    FAILS CLOSED, matching :func:`is_pristine_generated`: with no manifest at all
    nothing is proven, so every file stays in scope and the old verdict stands.
    """
    if gen_state_dir is None or not has_hash_manifest(gen_state_dir):
        return lambda _rel: True

    def is_ours(rel: str) -> bool:
        key = os.path.join(out_prefix, rel) if out_prefix else rel
        return read_generated_hash(gen_state_dir, key, legacy_rel_path=rel) is not None

    return is_ours


def _verify_codegen(args: argparse.Namespace) -> int:
    """``verify --codegen`` — regenerate the config's generator list into a temp tree and diff
    it against each target's committed ``outDir`` (ADR-0034 Amendment 9: the list ``gen``
    runs is the list ``verify`` checks)."""
    return _verify_codegen_config(args)


def _temp_slot_for(temp_root: Path, real_outdir: str, config_dir: Path) -> str:
    """The temp mirror of a committed ``outDir``.

    Keyed by the real outDir's path relative to ``config_dir`` when it lives under
    it, else a sanitized flat name — mirroring the TS ``computeCodegenDrift``
    ``tempFor``. Two targets sharing a real outDir map to the SAME slot so their
    co-resident regen accumulates into one tree: the diff is then union-of-
    co-resident-regen vs the shared committed dir, so the other target's files are
    never false ``extra`` drift.
    """
    try:
        rel = Path(real_outdir).relative_to(config_dir)
    except ValueError:
        rel = None
    if rel is None:
        safe = re.sub(r"[^A-Za-z0-9]+", "_", real_outdir)
        return str(temp_root / safe)
    return str(temp_root / rel)


@dataclasses.dataclass(frozen=True)
class _DirReport:
    """One committed outDir diffed against a fresh regen (``verify --codegen`` config mode)."""

    names: str
    expected_count: int
    changed: list[str]
    missing: list[str]
    extra: list[str]
    edited_extra: list[str]
    replaced: list[str]
    overwrite_dir: bool


def _verify_codegen_config(args: argparse.Namespace) -> int:
    """``verify --codegen`` with no positional ``metadata_dir`` → config mode (#267).

    Symmetric with ``gen`` config mode: ONE whole-selection regen into a temp tree
    (reusing :func:`_run_gen_targets` — the exact gen pipeline, so verify rejects
    exactly what gen rejects, including the cross-target duplicate-output-path
    guard), then a diff per UNIQUE real outDir. Targets that share an outDir are
    verified TOGETHER — the diff is the union of their co-resident regen vs the
    shared committed dir, so a shared outDir is never a false-positive ``extra``
    drift (mirrors the TS ``computeCodegenDrift`` unit = unique outDir).
    ``--target`` widens to the outDir-sharing closure (an outDir is verified as a
    unit). Strict-by-default (ADR-0023) unless ``--lax``.
    No ``metaobjects.config.yaml`` is an error: the list lives there.
    A ``--generators``/``--entities``-narrowed run checks only the paths the narrowed run
    emits, each against the content the whole declared list gives it (an aggregate such as
    ``enums.py`` is built from every entity), never reports ``extra`` (a committed file the
    narrowed run does not emit is some other entry's), and skips an outDir no selected
    entry writes into.
    """
    config, code = _load_generator_list(args, "metaobjects verify --codegen")
    if config is None:
        return code
    if args.out is not None:
        print(FLAG_FORM_NOT_READ.format(command="metaobjects verify --codegen"), file=sys.stderr)
        return 2
    if _refuse_template_spec_flag(args, "metaobjects verify --codegen"):
        return 2

    selected, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1
    selected = _narrow_entities(selected, args)

    # Widen to the outDir-sharing closure: a shared outDir is verified as a unit,
    # so --target a (whose outDir b also writes) pulls b in.
    selected_outdirs = {config.out_dir_for(t) for t in selected}
    closure = _narrow_entities(
        [t for t in config.targets if config.out_dir_for(t) in selected_outdirs], args
    )
    added = [t.name for t in closure if t not in selected]
    if added:
        target_arg = getattr(args, "target", None)
        print(
            f"note: --target {target_arg!r} shares an outDir with "
            f"{', '.join(added)}; verifying the shared outDir as a unit.",
            file=sys.stderr,
        )

    strict = not getattr(args, "lax", False)
    providers, providers_ok = _config_providers(config)
    if not providers_ok:
        return 1
    flag_providers, flag_providers_ok = _providers_from_args(args)
    if not flag_providers_ok:
        return 1
    providers = [*providers, *flag_providers]

    # FR-023: see the matching comment in `_cmd_gen_config` — dependencies apply
    # at this rung too.
    collection = _resolve_metadata_location_or_print_error(
        config, project_root_for(config.metadata_dir())
    )
    if collection is None:
        return 1

    root, load_errors = _load_root_from_collection(
        collection, strict=strict, providers=providers, libraries=config.libraries
    )
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        if strict and any("ERR_UNKNOWN_ATTR" in m for m in load_errors):
            print(_strict_load_hint(), file=sys.stderr)
        return 1

    selection = _selection_from_args(args)
    if _refuse_narrowing(args, selection, root, "metaobjects verify --codegen"):
        return 2
    for t in closure:
        imported_refusal = _refuse_imported_entities(t.entities, root, collection)
        if imported_refusal is not None:
            print(imported_refusal, file=sys.stderr)
            return 2
    narrowed = selection is not None or _parse_entities(getattr(args, "entities", None)) is not None

    template_root, templates_refusal = _template_root_for_config(args, config)
    if templates_refusal is not None:
        print(templates_refusal, file=sys.stderr)
        return 2
    # ADR-0058 Decision 3 — the loaded root's `naming` is THE strategy.
    column_naming = root.naming.columns

    # Map each unique real outDir to ONE temp slot name (shared real dir => shared slot).
    real_outdirs = sorted({config.out_dir_for(t) for t in closure})

    def compare(naming: str) -> tuple[list[str], list[_DirReport]]:
        """Regenerate the closure with ``naming`` and diff it against every committed outDir.

        ``edited_extra`` is the subset of ``extra`` edited since ``gen`` wrote it. ``gen``
        deletes an untouched ``extra`` file and refuses an edited one
        (``codegen/orphan_sweep.py``), so the two need different remedies, unless every
        generator writing into the directory is declared ``handEdits: overwrite``
        (``overwrite_dir``), when ``gen`` deletes the edited one too. ``replaced`` is the
        subset of ``changed`` that was edited by hand and that ``gen`` replaces anyway,
        because its generator is declared ``handEdits: overwrite``."""
        with tempfile.TemporaryDirectory() as temp_root, tempfile.TemporaryDirectory() as declared_root:
            temp_for = {
                real: _temp_slot_for(Path(temp_root), real, config.config_dir) for real in real_outdirs
            }
            remapped = [
                dataclasses.replace(t, out_dir=temp_for[config.out_dir_for(t)]) for t in closure
            ]

            # The exact gen pipeline into the temp tree — verify now rejects exactly
            # what gen rejects (incl. the cross-target duplicate-output-path guard).
            # gen_state_dir stays None: this regenerates into a temp tree purely to
            # diff, so recording a manifest would mutate the user's project from a
            # read-only drift check, keyed to a directory deleted seconds later.
            # build_ctx from the SAME resolver `gen` uses — a verify that resolved the
            # template root differently would regenerate render-helper against another
            # directory and convict the committed output of being stale.
            targeted: set[str] = set()
            overwrite_paths: set[str] = set()
            regen = dict(
                select=collection.in_scope,
                build_ctx=GeneratorBuildContext(template_root),
                # R31: the `names` generator's constants are strategy-dependent, so the regen
                # must use the strategy `gen` wrote with, or every constant reads as drift.
                column_naming=naming,
            )
            _written, errors = _run_gen_targets(
                config, remapped, root, selection=selection, targeted_out=targeted,
                overwrite_paths_out=overwrite_paths, **regen)
            # A narrowed run's paths get the content the whole declared list writes, which is
            # what `gen` committed: a second regen of the un-narrowed closure supplies it.
            declared_for: dict[str, str] = {}
            if narrowed and not errors:
                unnarrowed = [t for t in config.targets if config.out_dir_for(t) in temp_for]
                for real in temp_for:
                    declared_for[real] = _temp_slot_for(Path(declared_root), real, config.config_dir)
                _written, errors = _run_gen_targets(
                    config,
                    [dataclasses.replace(t, out_dir=declared_for[config.out_dir_for(t)])
                     for t in unnarrowed],
                    root, **regen)
            if errors:
                return errors, []

            reports: list[_DirReport] = []
            for real_outdir in real_outdirs:
                tmp_slot = temp_for[real_outdir]
                if narrowed and tmp_slot not in targeted:
                    continue
                expected = _relative_set(Path(tmp_slot))
                committed = _relative_set(Path(real_outdir))
                if narrowed:
                    declared = _relative_set(Path(declared_for[real_outdir]))
                    expected = {k: declared[k] for k in expected if k in declared}

                changed = sorted(
                    k for k in expected if k in committed and expected[k] != committed[k]
                )
                missing = sorted(k for k in expected if k not in committed)
                project_gen_state = gen_state_dir_for(config.metadata_dir())
                prefix = _out_prefix(real_outdir, project_root_for(config.metadata_dir()))
                if narrowed:
                    extra: list[str] = []
                else:
                    # Same jurisdiction rule as _diff_report — this rung inlines its diff to
                    # report per-target, so the guard has to be inlined with it. Without it,
                    # broadening the comparison past *.py convicts every stranger's file.
                    #
                    # PER-TARGET prefix, because that is the whole point on this rung: two
                    # targets with different outDirs share one manifest, and the key that tells
                    # their identically-named files apart is the one anchored on the project.
                    is_ours = _is_ours_for(project_gen_state, prefix)
                    extra = sorted(k for k in committed if k not in expected and is_ours(k))
                # The sweep's own test, on the same evidence: with no manifest nothing is
                # proven untouched, and every extra file reads as edited.
                edited_extra = [
                    k for k in extra
                    if not is_pristine_generated(
                        project_gen_state, os.path.join(prefix, k), committed[k], legacy_rel_path=k
                    )
                ]

                replaced = [
                    k for k in changed
                    if os.path.join(tmp_slot, k) in overwrite_paths
                    and not is_pristine_generated(
                        project_gen_state, os.path.join(prefix, k), committed[k], legacy_rel_path=k
                    )
                ]

                names = "+".join(
                    t.name for t in closure if config.out_dir_for(t) == real_outdir
                )
                reports.append(_DirReport(
                    names, len(expected), changed, missing, extra, edited_extra, replaced,
                    _overwrites_hand_edits(config, real_outdir),
                ))
            return [], reports

    errors, reports = compare(column_naming)
    if errors:
        for msg in errors:
            print(f"error: {msg}", file=sys.stderr)
        return 1

    failed = False
    regenerable = False
    edited_orphans: list[str] = []
    for rep in reports:
        if _report_clean(rep.changed, rep.missing, rep.extra):
            print(f"metaobjects verify [{rep.names}]: in sync ({rep.expected_count} file(s)).")
            continue
        failed = True
        print(
            f"error: [{rep.names}] generated code is out of sync with metadata.",
            file=sys.stderr,
        )
        for k in rep.changed:
            if k in rep.replaced:
                print(f"  drifted: {k} (edited by hand; its generator sets handEdits: overwrite, "
                      "so gen replaces it with fresh output)", file=sys.stderr)
            else:
                print(f"  drifted: {k}", file=sys.stderr)
        for k in rep.missing:
            print(f"  missing: {k}", file=sys.stderr)
        kept_orphans = [] if rep.overwrite_dir else rep.edited_extra
        for k in rep.extra:
            if k in kept_orphans:
                print(f"  extra:   {k} (no generator emits it any more, and it was edited by hand)",
                      file=sys.stderr)
            elif k in rep.edited_extra:
                print(f"  extra:   {k} (no generator emits it any more, and it was edited by hand; "
                      "handEdits is overwrite, so gen deletes it)", file=sys.stderr)
            else:
                print(f"  extra:   {k} (no generator emits it any more; gen deletes it)",
                      file=sys.stderr)
        edited_orphans.extend(kept_orphans)
        regenerable = regenerable or bool(
            rep.changed or rep.missing or len(rep.extra) > len(kept_orphans))
    if not failed:
        return 0

    # The committed output may be right and this run's naming wrong: the naming reaches every
    # column and table name, so "regenerate" would commit names the database does not have.
    # When another naming reproduces the committed tree exactly, say that instead. The table
    # rule reaches codegen only through the root (`naming_rules_of`), so each probe sets the
    # candidate on the root and restores the loaded naming afterwards.
    used = root.naming
    for candidate in naming_candidates(used):
        root.naming = candidate
        try:
            other_errors, other_reports = compare(candidate.columns)
        finally:
            root.naming = used
        if not other_errors and all(
            _report_clean(rep.changed, rep.missing, rep.extra) for rep in other_reports
        ):
            print(naming_differs_message(candidate, used), file=sys.stderr)
            return 1
    if regenerable:
        print("regenerate (metaobjects gen) and commit the result.", file=sys.stderr)
    if edited_orphans:
        # `gen` refuses to delete these, so "regenerate" alone would loop.
        print(
            "For the extra file(s) edited by hand, `metaobjects gen` will NOT delete them: "
            "delete each one, or move your edits into a file of your own first.",
            file=sys.stderr,
        )
    return 1


def naming_candidates(used: NamingRules) -> list[NamingRules]:
    """Every naming other than ``used``, in the order ``verify --codegen`` probes them (the C#
    port probes the same order): the used table rule first, so a different column rule alone
    is tried before a different table rule; within each, the used column rule first, then
    snake_case, literal, kebab-case."""
    tables = sorted(TABLE_NAMING_RULES, key=lambda t: t != used.tables)
    columns = sorted(COLUMN_NAMING_STRATEGIES, key=lambda c: c != used.columns)
    return [
        candidate
        for t in tables
        for c in columns
        if (candidate := NamingRules(columns=c, tables=t)) != used
    ]


def _report_clean(changed: list[str], missing: list[str], extra: list[str]) -> bool:
    """The drift verdict of one per-target report: nothing changed, nothing missing,
    nothing extra. It is asked twice — the first pass' per-target print and the naming
    probe — and the two spellings must mean the same thing."""
    return not changed and not missing and not extra


def _naming_block(naming: NamingRules) -> str:
    """A naming as the ``naming`` block that declares it."""
    return f'"naming": {{ "columns": "{naming.columns}", "tables": "{naming.tables}" }}'


def naming_differs_message(committed: NamingRules, used: NamingRules) -> str:
    """What ``verify --codegen`` says, in place of "regenerate", when the committed output was
    generated with ``committed`` and this run's loaded root resolved ``used`` (ADR-0058: the one
    project ``naming`` setting, read from ``.metaobjects/config.json``). The C# port prints the
    same text."""
    return (
        f"The committed output was generated with {_naming_block(committed)}; this run used "
        f"{_naming_block(used)} (.metaobjects/config.json; each rule defaults to snake_case). Do "
        f"not regenerate: that rewrites column or table names to ones the database does not have. "
        f"Declare {_naming_block(committed)} in .metaobjects/config.json, and gen and verify "
        f"--codegen both read it."
    )


#: The text-ref attrs a ``template.*`` node may carry. Each is resolved through
#: the filesystem provider and run through the render ``verify()`` gate. A prompt
#: / document uses ``@textRef``; an email uses subject / html / (optional) text
#: part-refs. We check whichever are declared (matching the render-helper gate).
_TEMPLATE_TEXT_REF_ATTRS = (
    tc.TEMPLATE_ATTR_TEXT_REF,
    tc.TEMPLATE_ATTR_SUBJECT_REF,
    tc.TEMPLATE_ATTR_HTML_BODY_REF,
    tc.TEMPLATE_ATTR_TEXT_BODY_REF,
)


def _attr_str_list(raw: object) -> list[str] | None:
    """Coerce a string-array attr (a list, or a single string) to ``list[str]``; ``None``
    when absent — the shape :func:`render.verify` expects for required_slots/required_tags."""
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw]
    return None


def _verify_templates(args: argparse.Namespace) -> int:
    """``verify --templates`` — the template/prompt ``{{field}}`` ↔ payload drift gate.

    For each ``template.*`` node: resolve its ``@payloadRef`` to an
    ``object.value`` + derive its field tree (reusing the render-helper
    generator's derivation — nested ``@objectRef`` resolved by short-name,
    cycle-guarded), resolve each declared text-ref through a
    :class:`FilesystemProvider` rooted at ``--templates-root``, and run the render
    ``verify()`` engine ({{field}} ↔ payload-field drift). Any drift — an
    unresolvable ref or a non-warning ``verify`` error — is reported and fails
    (exit 1). Clean → 0. Reuses the render engine + field-tree walk; nothing is
    reimplemented here.
    """
    # ADR-0023 strict-by-default (#96) — same as --codegen: an undeclared @attr
    # fails verify unless --lax is passed.
    strict = not getattr(args, "lax", False)
    providers, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1

    # The metadata and the template root come from the same metaobjects.config.yaml that
    # `gen` and `verify --codegen` read, when the run names no <metadata_dir>: a gate that
    # refused the project's own config made every adopter spell the paths a second time.
    config_path = _find_config(args) if args.metadata_dir is None else None
    if args.metadata_dir is None and config_path is None:
        print(
            "error: verify --templates needs the metadata: run it beside a "
            "metaobjects.config.yaml (or pass --config), or name <metadata_dir>.",
            file=sys.stderr,
        )
        return 2
    if config_path is not None:
        try:
            config = load_project_config(config_path)
        except ConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        template_root, templates_refusal = _template_root_for_config(args, config)
        if templates_refusal is not None:
            print(templates_refusal, file=sys.stderr)
            return 2
        config_providers, config_providers_ok = _config_providers(config)
        if not config_providers_ok:
            return 1
        collection = _resolve_metadata_location_or_print_error(
            config, project_root_for(config.metadata_dir())
        )
        if collection is None:
            return 1
        root, errors = _load_root_from_collection(
            collection, strict=strict, providers=[*config_providers, *providers],
            libraries=config.libraries,
        )
    else:
        template_root = getattr(args, "templates_root", None)
        if not template_root:
            print(
                "error: verify --templates requires --prompts (the on-disk "
                "template/prompt dir) when it is given <metadata_dir>.",
                file=sys.stderr,
            )
            return 2
        root, errors = _load_root(args.metadata_dir, strict=strict, providers=providers)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        if strict and any("ERR_UNKNOWN_ATTR" in m for m in errors):
            print(_strict_load_hint(), file=sys.stderr)
        return 1

    provider = FilesystemProvider(template_root)
    # Toolcall templates have no renderable text body (the body IS the schema) —
    # skip them; there is no {{field}} drift to check.
    templates = [
        # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
        c
        for c in root.own_children()
        if c.type == TYPE_TEMPLATE and c.sub_type != tc.TEMPLATE_SUBTYPE_TOOLCALL
    ]

    if not templates:
        print("metaobjects verify --templates: no template.* nodes found.")
        return 0

    error_count = 0
    checked = 0
    for tmpl in sorted(templates, key=lambda c: c.name):
        payload_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
        if not isinstance(payload_ref, str) or not payload_ref:
            print(f"error: [{tmpl.name}] missing @payloadRef.", file=sys.stderr)
            error_count += 1
            continue
        # ADR-0042 (#228): the referrer is THIS template — a bare @payloadRef
        # resolves in ITS OWN package first.
        vo = resolve_payload_vo(root, payload_ref, pkg_of(tmpl))
        if vo is None:
            print(
                f"error: [{tmpl.name}] @payloadRef '{payload_ref}' did not "
                "resolve to an object.value.",
                file=sys.stderr,
            )
            error_count += 1
            continue

        fields: list[PayloadField] = _derive_payload_field_tree(root, vo, frozenset())

        refs = [
            val
            for a in _TEMPLATE_TEXT_REF_ATTRS
            # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
            if isinstance(val := tmpl.get_meta_attr(a), str) and val
        ]
        if not refs:
            print(
                f"error: [{tmpl.name}] declares no resolvable text-ref "
                "(@textRef / @subjectRef / @htmlBodyRef / @textBodyRef).",
                file=sys.stderr,
            )
            error_count += 1
            continue

        # #193/#230: @requiredSlots/@requiredTags are a template.prompt concept — enforced ONLY on
        # the prompt path (the email/document output gate does not apply them per-part; the #193
        # cross-port consensus). A prompt whose body omits a required output tag →
        # ERR_OUTPUT_TAG_MISSING (drift, fails); an unused required slot → ERR_REQUIRED_SLOT_UNUSED
        # (warning). This brings Python to parity with TS/Java/C# (previously it enforced neither).
        is_prompt = tmpl.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
        # ADR-0039: resolving read — an inherited @requiredSlots/@requiredTags is honored.
        req_slots = _attr_str_list(tmpl.get_meta_attr(tc.TEMPLATE_ATTR_REQUIRED_SLOTS)) if is_prompt else None
        req_tags = _attr_str_list(tmpl.get_meta_attr(tc.TEMPLATE_ATTR_REQUIRED_TAGS)) if is_prompt else None

        for ref in refs:
            text = provider.resolve(ref)
            if text is None:
                print(
                    f"error: [{tmpl.name}] ref '{ref}' did not resolve under "
                    f"{template_root} (missing template).",
                    file=sys.stderr,
                )
                error_count += 1
                continue
            checked += 1
            for e in render_verify(
                text, fields, provider=provider,
                required_slots=req_slots, required_tags=req_tags,
            ):
                if e.code == ERR_REQUIRED_SLOT_UNUSED:
                    continue  # an unused required slot is a warning, not drift
                print(
                    f"error: [{tmpl.name}] ref '{ref}' — {e.code}: {e.path}",
                    file=sys.stderr,
                )
                error_count += 1

    if error_count > 0:
        print(
            f"metaobjects verify --templates: {error_count} drift error(s).",
            file=sys.stderr,
        )
        return 1
    print(f"metaobjects verify --templates: {checked} template ref(s) clean.")
    return 0


def _verify_db(_args: argparse.Namespace) -> int:
    """``verify --db`` — REJECTED in the Python port (ADR-0021 D2).

    Schema drift is owned by the migrate engine (ADR-0015), not this codegen CLI.
    """
    print(
        "error: verify --db is not supported in the Python port; schema verify "
        "is the migrate engine (the Node `meta` CLI, ADR-0015).",
        file=sys.stderr,
    )
    return 2


#: Opt-out for the advisory field lint, beside ``--no-field-lint`` (Node `meta` parity).
FIELD_LINT_ENV = "META_NO_FIELD_LINT"


@dataclasses.dataclass(frozen=True)
class _VerifyModel:
    """The metadata ``verify`` was pointed at, loaded once for every pass that reads it."""

    root: MetaData
    #: The project's OWN files — a dependency artifact is not the adopter's to edit.
    own_files: list[Path]
    #: Every file that loaded, dependency artifacts included. The denominator's provenance.
    loaded_files: int
    #: ``None`` for an explicit ``<metadata_dir>``, which never resolves one.
    collection: Collection | None


def _load_verify_model(
    args: argparse.Namespace, failure: "list[str] | None" = None
) -> "_VerifyModel | None":
    """Load the metadata ``verify`` was pointed at, for the passes that read the model.

    Returns ``None`` when there is nothing to read: the metadata could not be located or
    did not load. Why not is appended to ``failure`` as the lines to print, in the form the
    gate that normally meets that failure prints it. A gate that ran may have printed the
    same lines already, or NOT: ``--codegen`` with no generators selected returns before it
    loads anything, and then this load is the only one in the command. The caller decides
    (:func:`_report_unloaded_model`); this function only says what went wrong.

    Loads STRICT unless ``--lax``, as every other gate of this command does (ADR-0023), so a
    mistyped attribute on a requirement is refused here and never read as "no such claim".
    The field lint reads the same load, so it says nothing about a model the load refuses:
    that model already fails the command.
    """
    from metaobjects.loader.sources import DirectorySource

    strict = not getattr(args, "lax", False)

    def unread(*lines: str) -> "_VerifyModel | None":
        """Nothing to read: record why, and hand back the ``None`` the caller returns."""
        if failure is not None:
            failure.extend(lines)
        return None

    try:
        providers, provider_errors = _resolve_providers(getattr(args, "provider", None))
        if args.metadata_dir is not None:
            if provider_errors:
                return unread("error: invalid --provider:", *(f"  {m}" for m in provider_errors))
            root, errors = _load_root(args.metadata_dir, strict=strict, providers=providers)
            if root is None:
                return unread(*_load_failure_lines(errors, strict))
            files = [source.path for source in DirectorySource(args.metadata_dir).expand()]
            collection = None
            loaded_files = len(files)
        else:
            config_path = _find_config(args)
            config = load_project_config(config_path) if config_path is not None else None
            libraries: "list[str] | None" = None
            if config is not None:
                providers, provider_errors = _resolve_config_providers(config)
                if provider_errors:
                    return unread(
                        "error: invalid provider in config:", *(f"  {m}" for m in provider_errors)
                    )
                libraries = config.libraries
                start = project_root_for(config.metadata_dir())
            else:
                if provider_errors:
                    return unread("error: invalid --provider:", *(f"  {m}" for m in provider_errors))
                start = Path.cwd()
            try:
                collection = resolve_metadata_location(config=config, root=start)
            except ParseError as exc:
                return unread(f"error: could not resolve metadata location: {exc}")
            root, errors = _load_root_from_collection(
                collection, strict=strict, providers=providers, libraries=libraries
            )
            if root is None:
                return unread(*_load_failure_lines(errors, strict))
            files = list(collection.own_files)
            loaded_files = len(collection.files)
    except ConfigError as exc:
        return unread(f"error: {exc}")
    except ParseError as exc:
        return unread(*_load_failure_lines([f"{exc.code}: {exc}"], strict))
    except OSError as exc:
        return unread(*_load_failure_lines([str(exc)], strict))
    # Only the failures the loader and the config readers RAISE for input that cannot be
    # read are caught above. Anything else is a bug, and it must not read as "no
    # requirements declared": this result feeds a build gate, which a swallowed exception
    # would turn off with exit 0.
    return _VerifyModel(root=root, own_files=files, loaded_files=loaded_files, collection=collection)


class _RecordedStderr:
    """``sys.stderr`` for the gates ``verify`` was asked to run, remembering each line they
    wrote, so a load failure one of them already reported is not printed a second time.

    Asking what was PRINTED, and not which gate returned non-zero or reached its load, is
    deliberate: it cannot be wrong in the direction that matters. A gate that changes its
    wording costs a repeated message. Nothing can make a failure nobody printed look reported.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._parts: list[str] = []

    def write(self, text: str) -> int:
        self._parts.append(text)
        return int(self._inner.write(text))

    def flush(self) -> None:
        self._inner.flush()

    def lines(self) -> set[str]:
        return set("".join(self._parts).splitlines())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _report_unloaded_model(failure: list[str], printed: set[str]) -> int:
    """The metadata did not load, so ``verify`` fails: an unloadable model is not a model with
    no ``requirement.*`` node. Prints why, once: skipped when a gate that ran already printed
    every one of these lines. Always returns 1."""
    # A loader message can span lines (a YAML parse error does); compare what a terminal shows.
    if not all(line in printed for line in "\n".join(failure).splitlines()):
        for line in failure:
            print(line, file=sys.stderr)
    return 1


def _run_field_lint_advisory(args: argparse.Namespace, model: "_VerifyModel | None") -> None:
    """The field AUTHORING lint (see :mod:`metaobjects.field_lint`) — runs on every
    ``verify``, whichever gates were selected. Warnings ONLY: it prints to stderr and
    never changes the exit code. Muted by ``--no-field-lint`` or ``META_NO_FIELD_LINT=1``.
    """
    if getattr(args, "no_field_lint", False) or os.environ.get(FIELD_LINT_ENV) == "1":
        return
    if model is None:
        return
    try:
        findings = [*lint_reference_fields(model.root), *lint_duplicate_fields(model.own_files)]
    except Exception:  # noqa: BLE001 — an advisory scan never breaks verify
        return
    if not findings:
        return
    print(
        f"metaobjects verify — fields: {len(findings)} authoring warning(s) "
        "(advisory — does not fail the build):",
        file=sys.stderr,
    )
    for finding in findings:
        print(f"  {finding.code} [{finding.path}]: {finding.message}", file=sys.stderr)


#: Raises ``WARN_REQUIREMENT_NOTHING_IMPLEMENTS`` to an error, beside ``--require-implementers``
#: (Node `meta` parity, ADR-0057).
REQUIRE_IMPLEMENTERS_ENV = "META_REQUIRE_IMPLEMENTERS"


def _format_requirement_diagnostic(d: Diagnostic) -> str:
    return f"  {d.code}{'' if d.path is None else f' [{d.path}]'}: {d.message}"


def _verify_requirements(args: argparse.Namespace, model: "_VerifyModel | None") -> int:
    """The requirement (capability) gate (see :mod:`metaobjects.requirement_check`) — runs
    on EVERY ``verify``, with no subverb to select it: ``requirement.*`` nodes are metadata,
    so a model declaring none is silent, not in drift.

    Prints the summary line on every run that has a requirement, clean or not (a gate that
    says nothing when it passes cannot be told apart from one that checked nothing), then
    every finding, uncapped. Returns 1 when any finding is an error. Returns 0 and prints
    nothing when the metadata did not load (``model`` is ``None``): that is reported, and
    fails the command, in :func:`_cmd_verify`, and a load that failed is not retried here.
    """
    if model is None:
        return 0
    collection = model.collection
    scan = scan_requirements(
        model.root,
        coverable=collection.in_scope if collection is not None else None,
        require_implementers=bool(getattr(args, "require_implementers", False))
        or os.environ.get(REQUIRE_IMPLEMENTERS_ENV) == "1",
    )
    summary = summarise_requirements(model.root, scan)
    if summary is None:
        return 0

    statuses = ", ".join(
        f"{summary.by_status[k]} {k}" for k in REQUIREMENT_STATUSES if summary.by_status.get(k, 0) > 0
    )
    if summary.entities_total is None:
        coverage = "coverage: not measured (no project-authored requirements)."
    else:
        # The file count is the DENOMINATOR'S PROVENANCE: `entities_total` is only ever taken
        # over what actually loaded, so a spine that covers half an estate reports the
        # covered half as fully claimed unless the count says what it was taken over.
        from_dependencies = (
            f", {len(collection.dependencies)} from dependencies."
            if collection is not None and collection.dependencies
            else "."
        )
        coverage = (
            f"{summary.entities_claimed}/{summary.entities_total} entities claimed, "
            f"counted over {model.loaded_files} metadata file(s)" + from_dependencies
        )
    print(
        f"metaobjects verify — requirements: {summary.total} entries ({summary.functional} functional, "
        f"{summary.architectural} architectural) — {statuses}; {coverage}",
        file=sys.stderr,
    )
    if summary.undecided > 0:
        print(
            f"metaobjects verify — requirements: {summary.undecided} recorded gap(s) with no @disposition. "
            "These are known problems nobody has ruled on — set 'accepted' or 'deferred' to close the question.",
            file=sys.stderr,
        )

    diagnostics = check_requirements(model.root, scan)
    errors = [d for d in diagnostics if d.severity == SEVERITY_ERROR]
    warnings = [d for d in diagnostics if d.severity != SEVERITY_ERROR]
    for d in errors:
        print(_format_requirement_diagnostic(d), file=sys.stderr)
    for d in warnings:
        print(_format_requirement_diagnostic(d), file=sys.stderr)
    if errors:
        print(f"metaobjects verify — requirements: {len(errors)} error(s).", file=sys.stderr)
        return 1
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    """Subverb dispatch (ADR-0021 D2). Run each requested mode; aggregate exit =
    max (non-zero if ANY mode drifts). Bare ``verify`` (no subverb) keeps the
    historical default = ``--codegen`` + a one-line note advertising the subverbs.
    """
    naming_refusal = _refuse_column_naming_flag(args)
    if naming_refusal is not None:
        print(naming_refusal, file=sys.stderr)
        return 2
    _warn_if_agent_context_stale()

    run_db = args.db is not None
    run_templates = bool(args.templates)
    run_codegen = bool(args.codegen)
    any_explicit = run_db or run_templates or run_codegen

    if not any_explicit:
        print(
            "metaobjects verify — running --codegen (default). Explicit "
            "subverbs: --codegen (codegen drift), --templates (template/prompt "
            "drift), --db (schema drift — not supported in Python).",
            file=sys.stderr,
        )
        run_codegen = True

    exit_code = 0
    gates_stderr = _RecordedStderr(sys.stderr)
    with contextlib.redirect_stderr(gates_stderr):
        if run_db:
            exit_code = max(exit_code, _verify_db(args))
        if run_codegen:
            exit_code = max(exit_code, _verify_codegen(args))
        if run_templates:
            exit_code = max(exit_code, _verify_templates(args))
    # One load for both passes that read the model. The requirement gate runs on EVERY verify.
    load_failure: list[str] = []
    model = _load_verify_model(args, load_failure)
    if model is None:
        exit_code = max(exit_code, _report_unloaded_model(load_failure, gates_stderr.lines()))
    exit_code = max(exit_code, _verify_requirements(args, model))
    _run_field_lint_advisory(args, model)
    return exit_code


def _cmd_agent_docs(args: argparse.Namespace) -> int:
    """``agent-docs`` — redirect to the canonical Node meta CLI scaffolder."""
    print(
        "agent-context scaffolding moved to the meta CLI — run: "
        "npx meta agent-docs --server python [--client <fw>] [--out <dir>]",
        file=sys.stderr,
    )
    return 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="metaobjects",
        description=(
            "MetaObjects Python codegen CLI. Generate idiomatic Python from "
            "metadata and verify it has not drifted. Schema migrations are "
            "owned by the Node `meta` CLI (ADR-0015) — there is no `migrate` "
            "subcommand here."
        ),
        epilog="--version, -v, -V  print the version and exit",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser(
        "gen",
        help=(
            "run the generator list in metaobjects.config.yaml: each target's generators, "
            "into its outDir"
        ),
    )
    # metadata_dir / --out are the 1.0 form. They are accepted so a 1.0 invocation gets the
    # line that says where they went (the config's `metadata` and each target's `outDir`)
    # instead of argparse's "unrecognized arguments".
    gen.add_argument(
        "metadata_dir",
        nargs="?",
        default=None,
        help="not read since 1.1.0: set `metadata` in metaobjects.config.yaml",
    )
    gen.add_argument(
        "--out", default=None,
        help="not read since 1.1.0: each target's `outDir` in metaobjects.config.yaml",
    )
    gen.add_argument(
        "--column-naming",
        dest="column_naming",
        choices=COLUMN_NAMING_STRATEGIES,
        default=None,
        help=(
            "removed in 1.1.0 (ADR-0058): naming is one project setting now, `naming` in "
            ".metaobjects/config.json, read by every port from the loaded root. Passing "
            "this flag at all is refused."
        ),
    )
    gen.add_argument(
        "--generators",
        default=None,
        help=(
            "narrow the run to these declared entries (comma-separated stable names, or an "
            "owned entry as written in the config). Never adds a generator the config does "
            "not declare; naming one is refused."
        ),
    )
    gen.add_argument(
        "--list",
        action="store_true",
        help="list registered generators (stable name + description) and exit",
    )
    gen.add_argument(
        "--baseline",
        choices=("default", "adopt"),
        default="default",
        help=(
            "first-time-on-existing-file behaviour. 'default' refuses a file that cannot "
            "be proved to be generated output; 'adopt' records the files you have as the "
            "baseline and writes NOTHING — the one run a project with no committed "
            ".gen-state/.hashes.json can perform, since nothing writes a manifest until a "
            "gen succeeds. Adopting DECLARES those files to be generated output: the next "
            "gen regenerates over them, so commit before you run it."
        ),
    )
    gen.add_argument(
        "--template-spec",
        dest="template_spec",
        default=None,
        help=(
            "not read since 1.1.0: declare a template-spec on the target it writes into, "
            "as `templateSpec: <path>` in metaobjects.config.yaml"
        ),
    )
    gen.add_argument(
        "--templates",
        default=None,
        help=(
            "on-disk root that template refs resolve under — used by a target's "
            "declared templateSpec AND by the render-helper generator's drift gate "
            "(default: prompts/ when it exists, else templates/)"
        ),
    )
    gen.add_argument(
        "--package",
        default=None,
        help="(reserved) package hint; Python derives package from metadata",
    )
    gen.add_argument(
        "--entities",
        default=None,
        help=(
            "comma-separated entity NAMES to emit (allowlist). The whole model is "
            "still loaded so `extends` bases and @objectRef VOs resolve; only the "
            "named entities are written. Omit to emit every entity."
        ),
    )
    gen.add_argument(
        "--provider",
        action="append",
        metavar="module:symbol",
        help=(
            "load a consumer metadata Provider as 'module:symbol' (repeatable) — the "
            "Python parity of TS metaobjects.config.ts providers, so a custom subtype "
            "resolves through the standalone CLI (#158)"
        ),
    )
    gen.add_argument(
        "--config",
        default=None,
        help=(
            "path to the metaobjects.config.yaml that declares the generator list "
            "(default: ./metaobjects.config.yaml in cwd)"
        ),
    )
    gen.add_argument(
        "--target",
        default=None,
        help="run only this named target from the config (default: every target)",
    )
    gen.set_defaults(func=_cmd_gen)

    verify = sub.add_parser(
        "verify",
        help=(
            "drift gate — explicit subverbs --codegen / --templates / --db "
            "(ADR-0021 D2); bare verify defaults to --codegen"
        ),
    )
    verify.add_argument(
        "metadata_dir",
        nargs="?",
        default=None,
        help=(
            "directory of metadata JSON/YAML files for --templates when there is no "
            "metaobjects.config.yaml (with one, its `metadata` is read). Not read "
            "since 1.1.0 by --codegen, which always runs config mode: set `metadata` "
            "in metaobjects.config.yaml instead."
        ),
    )
    verify.add_argument(
        "--codegen",
        action="store_true",
        help="codegen drift: regenerate to a temp dir + diff vs --out (default)",
    )
    verify.add_argument(
        "--column-naming",
        dest="column_naming",
        choices=COLUMN_NAMING_STRATEGIES,
        default=None,
        help=(
            "removed in 1.1.0 (ADR-0058): naming is one project setting now, `naming` in "
            ".metaobjects/config.json, read by every port from the loaded root. Passing "
            "this flag at all is refused."
        ),
    )
    verify.add_argument(
        "--templates",
        action="store_true",
        help=(
            "template drift: each template.* node's {{field}} ↔ payload-VO "
            "field tree (render verify); reads `metadata` and `templates` from "
            "metaobjects.config.yaml, or takes <metadata_dir> with --prompts"
        ),
    )
    verify.add_argument(
        "--db",
        default=None,
        metavar="URL",
        help="schema drift — NOT supported in the Python port (exit 2)",
    )
    verify.add_argument(
        "--out",
        default=None,
        help="not read since 1.1.0: each target's `outDir` in metaobjects.config.yaml",
    )
    # F101 — the prompt directory is spelled three ways across the ports: `--prompts <dir>`
    # (Node `meta`, the reference), `--templates <root>` (dotnet meta, inline on the subverb)
    # and `--templates-root` here. `--prompts` is the converged spelling, adopted from the
    # reference port because it does not overload the subverb's own name. `--templates-root`
    # keeps working — the 1.0 CLI surface is frozen, so this is additive; the old spelling is
    # deprecated in 1.1 and stays until a major. argparse's FIRST option string is the one
    # help prints, so the converged name leads.
    verify.add_argument(
        "--prompts",
        "--templates-root",
        dest="templates_root",
        default=None,
        help=(
            "on-disk template/prompt dir the --templates gate resolves refs against "
            "(--templates-root is the deprecated alias)"
        ),
    )
    verify.add_argument(
        "--entities",
        default=None,
        help="comma-separated entity allowlist for --codegen drift (match `gen --entities`)",
    )
    verify.add_argument(
        "--no-field-lint",
        action="store_true",
        help=(
            "suppress the advisory field AUTHORING lint (a reference identity over a "
            "missing field; a duplicate field name) — never a gate, it cannot fail the "
            "build. META_NO_FIELD_LINT=1 does the same."
        ),
    )
    verify.add_argument(
        "--require-implementers",
        action="store_true",
        help=(
            "raise WARN_REQUIREMENT_NOTHING_IMPLEMENTS (a live functional requirement whose "
            "subtree names no implementing node) from a warning to an error. "
            "META_REQUIRE_IMPLEMENTERS=1 does the same."
        ),
    )
    verify.add_argument(
        "--lax",
        action="store_true",
        help=(
            "opt out of strict-attr load (ADR-0023, #96): verify is strict by "
            "default — an undeclared/typo'd @attr fails. --lax restores the legacy "
            "open-attr load."
        ),
    )
    verify.add_argument(
        "--provider",
        action="append",
        metavar="module:symbol",
        help="load a consumer metadata Provider as 'module:symbol' (repeatable; #158)",
    )
    verify.add_argument(
        "--config",
        default=None,
        help=(
            "path to the metaobjects.config.yaml that declares the generator list "
            "(default: ./metaobjects.config.yaml in cwd). Drives --codegen's "
            "per-target regen+diff."
        ),
    )
    verify.add_argument(
        "--target",
        default=None,
        help="verify only this named target from the config (default: every target)",
    )
    verify.add_argument(
        "--generators",
        default=None,
        help=(
            "narrow --codegen to these declared entries (comma-separated stable names, "
            "or an owned entry as written in the config), matching `gen --generators`. "
            "Never adds a generator the config does not declare; naming one is refused. "
            "With none named, the whole declared list is checked."
        ),
    )
    verify.set_defaults(func=_cmd_verify)

    fmt_p = sub.add_parser(
        "fmt",
        help="rewrite metadata files into canonical form (#304)",
    )
    fmt_p.add_argument(
        "files",
        nargs="*",
        metavar="FILE",
        help="optional explicit file(s) to format — must be members of this "
        "project's resolved metadata sources; omit to format every one of them",
    )
    fmt_p.add_argument(
        "--check",
        action="store_true",
        help="list files that are not canonical and exit non-zero; changes nothing",
    )
    fmt_p.add_argument(
        "--provider",
        action="append",
        default=None,
        metavar="MODULE:SYMBOL",
        help="consumer-registered Provider(s), repeatable (module:symbol)",
    )
    fmt_p.set_defaults(func=_cmd_fmt)

    eject_p = sub.add_parser(
        "eject",
        help="copy reference generators into codegen/generators/ to own and edit",
    )
    eject_p.add_argument("names", nargs="+", metavar="NAME", help="stable generator names")
    eject_p.add_argument("--force", action="store_true",
                         help="replace an existing owned copy with the reference")
    eject_p.add_argument("--root", default=None, help="project root (default: cwd)")
    eject_p.set_defaults(func=_cmd_eject)

    agent_docs = sub.add_parser(
        "agent-docs",
        help=(
            "scaffold the slim MetaObjects Claude Code agent context "
            "(.metaobjects/AGENTS.md + CLAUDE.md + the metaobjects-* skills)"
        ),
    )
    agent_docs.add_argument(
        "--server",
        action="append",
        default=None,
        metavar="LANG",
        help="server language (repeatable): typescript|java|kotlin|csharp|python",
    )
    agent_docs.add_argument(
        "--client",
        action="append",
        default=None,
        metavar="FRAMEWORK",
        help="client framework (repeatable): react|tanstack|angular",
    )
    agent_docs.add_argument(
        "--out",
        default=None,
        help="output project root (default: cwd)",
    )
    agent_docs.set_defaults(func=_cmd_agent_docs)

    return parser


# The three spellings that print the bare version — the same set every port's CLI answers.
VERSION_FLAGS = ("--version", "-v", "-V")


def _refuse_extras(parser: argparse.ArgumentParser, command: str, extras: list[str]) -> int:
    """Refuse what a subcommand did not consume, naming the subcommand and its flags.

    argparse attributes a subcommand's unknown flag to the TOP-LEVEL parser: it printed
    ``usage: metaobjects [-h] {gen,docs,...}`` and ``unrecognized arguments: --x``, which
    names neither the command nor a flag that would have worked. This is the one wording
    every port's CLI uses for it, and it exits 2.
    """
    subparser = next(
        (
            action.choices.get(command)
            for action in parser._actions  # noqa: SLF001 — argparse exposes no public accessor
            if isinstance(action, argparse._SubParsersAction)  # noqa: SLF001
        ),
        None,
    )
    first = extras[0]
    if not first.startswith("-") or subparser is None:
        print(f"unexpected argument {first!r} for `metaobjects {command}`", file=sys.stderr)
        return 2
    valid = sorted(
        ", ".join(action.option_strings)
        for action in subparser._actions  # noqa: SLF001
        if action.option_strings and "--help" not in action.option_strings
    )
    print(
        f"unknown flag {first} for `metaobjects {command}`. Valid flags: {', '.join(valid)} "
        "(also accepted everywhere: --help)",
        file=sys.stderr,
    )
    return 2


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns the process exit code (does not call ``sys.exit``)."""
    raw = sys.argv[1:] if argv is None else argv
    if len(raw) == 1 and raw[0] in VERSION_FLAGS:
        print(installed_metaobjects_version())
        return 0
    # `docs` was removed in 1.1.0 (ADR-0034 Amendment 9). Whatever follows it, the answer is
    # the one line that names the gen command and the migration section.
    if raw and raw[0] == "docs":
        print(DOCS_COMMAND_REMOVED, file=sys.stderr)
        return 2
    parser = _build_parser()
    args, extras = parser.parse_known_args(raw)
    if extras:
        return _refuse_extras(parser, args.command, extras)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
