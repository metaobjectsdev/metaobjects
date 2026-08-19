"""The ``metaobjects`` console-script — codegen `gen` + drift `verify` (SP-E Unit 2).

Two subcommands:

  metaobjects gen    <metadataDir> --out <dir> [--package <pkg>]
                     [--template-spec <json> [--templates <dir>]]
      Load metadata, run the Python codegen generator suite, and write files
      under ``--out`` (guarded by the @generated header). Prints each written
      file. Non-zero exit on a load error. ``--template-spec`` appends the
      declarative Mustache template generators (scope perEntity/perPackage/
      perModel + outputPattern) described by a JSON spec, resolving template
      refs under ``--templates`` (default ``templates``).

  metaobjects verify <metadataDir> [--codegen] [--templates] [--db URL] ...
      Drift gate with explicit subverbs (ADR-0021 D2 — one verify vocabulary
      across ports):

        --codegen    regenerate into a temp dir + diff against the committed
                     ``--out`` tree (Python's historical default behavior).
        --templates  template/prompt ``{{field}}`` ↔ payload-VO drift — the
                     render ``verify()`` gate — resolving each ``template.*``
                     node's refs via a filesystem provider rooted at
                     ``--templates-root``.
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
import dataclasses
import json
import re
import sys
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.agent_context import (
    AGENT_CONTEXT_MANIFEST_PATH,
    agent_context_staleness,
    installed_metaobjects_version,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.codegen.config import GenConfig
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
from metaobjects.codegen.generators.output_parser_generator import (
    output_parser_generator,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    output_prompt_generator,
)
from metaobjects.codegen.generators.payload_vo_generator import payload_vo_generator
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.generator_registry import (
    GENERATOR_REGISTRY,
    get_generator,
    list_generators,
)
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.generators.render_helper_generator import (
    _derive_payload_field_tree,
    _resolve_payload_vo,
)
from metaobjects.meta.template import template_constants as tc
from metaobjects.render.filesystem_provider import FilesystemProvider
from metaobjects.render.verify import (
    ERR_REQUIRED_SLOT_UNUSED,
    PayloadField,
    verify as render_verify,
)
from metaobjects.shared.base_types import TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP


def _pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level node). Duplicated (not imported) to
    match the existing per-generator convention. Used to derive a template's
    referrer package for ``_resolve_payload_vo`` (#228)."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def _default_generators() -> list[Generator]:
    """The default codegen suite — the no-config generators every project gets.

    ``template_generator`` is excluded: it requires a caller-supplied text
    provider + Mustache template and is not a zero-config per-entity emitter.
    """
    return [
        entity_model(),
        router_generator(),
        filter_allowlist_generator(),
        payload_vo_generator(),
        output_parser_generator(),
        output_prompt_generator(),
        extractor_generator(),
    ]


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


def _config_providers(config: ProjectConfig) -> tuple[list[object], bool]:
    """Resolve ``config.providers`` with the config file's directory on ``sys.path``.

    #267: prepend the config directory so a ``module:symbol`` provider living beside
    the config imports with no ``PYTHONPATH=``. Idempotent; the entry is left in
    place (a short-lived CLI process). Prints resolution errors; returns (providers, ok).
    """
    config_dir = str(config.config_dir)
    if config_dir not in sys.path:
        sys.path.insert(0, config_dir)
    providers, errors = _resolve_providers(config.providers)
    if errors:
        print("error: invalid provider in config:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return providers, False
    return providers, True


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


def _load_root(
    metadata_dir: str,
    strict: bool = False,
    providers: list[object] | None = None,
    libraries: list[str] | None = None,
) -> tuple[MetaData | None, list[str]]:
    """Load metadata; return ``(root, error_messages)``. ``root`` is None on error.

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
    from the CLI while its input was not.
    """
    if providers:
        from metaobjects.core_types import core_providers

        result = MetaDataLoader.from_directory(
            metadata_dir,
            providers=[*core_providers, *providers],
            strict=strict,
            libraries=libraries,
        )
    else:
        result = MetaDataLoader.from_directory(
            metadata_dir, strict=strict, libraries=libraries
        )
    if result.errors:
        msgs = [f"{e.code}: {e.message}" for e in result.errors]
        return None, msgs
    return result.root, []


def _strict_load_hint() -> str:
    """Actionable next-steps when strict verify rejects an undeclared @attr."""
    return (
        "verify is strict (ADR-0023): every authored @attr must be declared. Fix: "
        "register the attr on a metadata provider, OR move arbitrary author-supplied "
        "properties into an `attr.properties` bag, OR re-run with `--lax` to keep the "
        "legacy open-attr load."
    )


def _resolve_generators(names: str) -> tuple[list[Generator], list[str]]:
    """Resolve a comma-separated list of STABLE generator names via the registry.

    Returns ``(generators, errors)``. An unknown name produces a clear error and
    no generators (so the caller can fail with exit code != 0).
    """
    requested = [n.strip() for n in names.split(",") if n.strip()]
    gens: list[Generator] = []
    errors: list[str] = []
    for n in requested:
        entry = get_generator(n)
        if entry is None:
            known = ", ".join(sorted(GENERATOR_REGISTRY))
            errors.append(f"unknown generator {n!r}; known: {known}")
            continue
        gens.append(entry.factory())
    if not errors and not gens:
        errors.append("no generators selected (empty --generators list)")
    return gens, errors


def _parse_entities(value: str | None) -> list[str] | None:
    """Parse a comma-separated ``--entities`` value into a name list (``None`` =
    no filter = generate every entity). Blank names are dropped."""
    if not value:
        return None
    names = [n.strip() for n in value.split(",") if n.strip()]
    return names or None


def _run_suite(
    root: MetaData,
    out_dir: str,
    generators: list[Generator] | None = None,
    entity_filter: list[str] | None = None,
    emit_package_init: bool = True,
    gen_state_dir: str | None = None,
) -> list[str]:
    """Run a generator suite against an ALREADY-LOADED ``root`` into ``out_dir``.

    Split out from :func:`_generate` so a single gen invocation can load the
    metadata once and run multiple passes against it (the default Python suite +
    the ``--template-spec`` pass). See :func:`_generate` for the parameter
    semantics. Returns the written paths.

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
    )
    suite = generators if generators is not None else _default_generators()
    result = run_gen(config, root, generators=suite, entity_filter=entity_filter)
    for warning in result.warnings:
        print(f"warning: {warning}")
    return [path for path, status in result.files if status != "refused"]


def _generate(
    metadata_dir: str,
    out_dir: str,
    generators: list[Generator] | None = None,
    entity_filter: list[str] | None = None,
    emit_package_init: bool = True,
    strict: bool = False,
    providers: list[object] | None = None,
) -> tuple[list[str], list[str]]:
    """Run the generator suite into ``out_dir``.

    ``generators`` defaults to the zero-config default suite; pass a registry-
    resolved subset for ``--generators``. ``entity_filter`` (the ``--entities``
    allowlist) restricts which entities are EMITTED while the WHOLE model is still
    loaded, so cross-entity references (``extends`` bases, ``@objectRef`` VOs)
    resolve — emit a subset without splitting the metadata. ``emit_package_init``
    is ``False`` for the format-agnostic ``--template-spec`` generators (whose
    output is text/markdown/csv/json/xml/html, never a Python package) so no
    spurious ``__init__.py`` is scattered through their output tree. Returns
    ``(written_paths, errors)``. On a load error, ``errors`` is non-empty and no
    files are written. ``strict`` (ADR-0023, #96) is threaded to the load — the
    ``verify --codegen`` caller passes True; ``gen`` keeps the default False.
    """
    root, errors = _load_root(metadata_dir, strict=strict, providers=providers)
    if root is None:
        return [], errors
    # The project root is the metadata dir's parent — the directory holding
    # `metaobjects/`, which is where `.metaobjects/` belongs beside it.
    # verify --codegen is the ONLY caller of _generate, and it regenerates into a
    # throwaway temp dir purely to diff. It must NOT record a manifest: that would
    # mutate the user's project from a read-only drift check, with keys relative to a
    # directory deleted seconds later. The real gen paths anchor their own manifest via
    # gen_state_dir_for().
    return (
        _run_suite(root, out_dir, generators, entity_filter, emit_package_init, None),
        [],
    )


def gen_state_dir_for(metadata_dir: str) -> str:
    """Where a project's codegen hash manifest lives.

    Anchored on the project — the metadata dir's parent, i.e. the directory holding
    ``metaobjects/`` — never on ``Path.cwd()``, which is whatever directory the process
    happens to sit in and would scatter ``.metaobjects/`` into any package that merely
    runs a generator.
    """
    return str(Path(metadata_dir).resolve().parent / ".metaobjects" / ".gen-state")


#: The default api-surface subdir (the cross-port contract's ``api/python``).
_DOCS_DEFAULT_API_SUBDIR = "api/python"


def _cmd_docs(args: argparse.Namespace) -> int:
    """``docs`` — emit the generated Python SDK api surface (the ``api/python``
    surface of the cross-port SDK-docs contract) under ``--out``.

    Wiring only: every symbol name comes from the ``PythonApiModelBuilder`` (which
    keys off the naming seam + each generator's applies-predicate) and every path
    comes from :mod:`metaobjects.apidocs.paths` — nothing is re-derived here. Output
    paths are collision-checked (duplicate page path → failure) BEFORE anything is
    written, mirroring the C# ``DocsCommand`` / the Java Mojo. Layout is ``package``
    (the cross-port contract). ``--model-base-url`` federates the model back-links
    when set."""
    from metaobjects.apidocs import (
        Layout,
        PythonApiDocsRenderer,
        PythonApiModelBuilder,
        doc_page_output_path,
        model_cross_href,
    )

    providers, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1
    root, errors = _load_root(args.metadata_dir, providers=providers)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return 1

    api_subdir = args.api_subdir or _DOCS_DEFAULT_API_SUBDIR
    project = args.project or Path(args.metadata_dir).resolve().name
    model_base_url = getattr(args, "model_base_url", None)

    model = PythonApiModelBuilder().build(root, project)
    renderer = PythonApiDocsRenderer()
    layout = Layout.PACKAGE

    # Collect rel-path → content first so a duplicate page path fails BEFORE any write.
    emitted: dict[str, str] = {}

    def _put(path: str, content: str) -> None:
        if path in emitted:
            raise ValueError(f"docs — duplicate api page output path: {path}")
        emitted[path] = content

    try:
        for unit in model.units:
            page_path = doc_page_output_path(layout, unit.package, unit.node)
            api_page_path_from_docs_root = f"{api_subdir}/{page_path}"
            href = model_cross_href(api_page_path_from_docs_root, page_path, model_base_url)
            _put(page_path, renderer.render_unit_page(unit, href))
        _put("README.md", renderer.render_index(model, layout))
        _put("AGENT-API.md", renderer.render_agent_api(model))
    except ValueError as exc:
        # A duplicate output path (e.g. two units that resolve to the same page) is a
        # clean user-facing failure, not a stack trace.
        print(f"error: {exc}", file=sys.stderr)
        return 1

    api_root = Path(args.out) / api_subdir
    written: list[str] = []
    for rel, content in emitted.items():
        dest = api_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        written.append(f"{api_subdir}/{rel}")

    for path in sorted(written):
        print(path)
    print(f"metaobjects docs: wrote {len(written)} file(s) to {args.out}")
    return 0


def _cmd_list(_args: argparse.Namespace) -> int:
    """Print each registered generator ``<stable-name> — <description>`` and exit 0.

    Does NOT run codegen — pure discoverability (ADR-0021 D3).
    """
    for entry in list_generators():
        print(f"{entry.name} — {entry.description}")
    return 0


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
    # `--list` is a pure discoverability path: print the registry and exit, no codegen.
    if getattr(args, "list", False):
        return _cmd_list(args)

    _warn_if_agent_context_stale()

    # #267: config mode ⇔ no positional <metadata_dir>. The explicit
    # <metadata_dir> + --out flag path below is untouched (byte-identical).
    if args.metadata_dir is None:
        return _cmd_gen_config(args)
    if args.out is None:
        print(
            "error: gen requires <metadata_dir> and --out "
            "(or a metaobjects.config.yaml / --list).",
            file=sys.stderr,
        )
        return 2

    generators: list[Generator] | None = None
    if args.generators:
        generators, gen_errors = _resolve_generators(args.generators)
        if gen_errors:
            print("error: invalid --generators selection:", file=sys.stderr)
            for msg in gen_errors:
                print(f"  {msg}", file=sys.stderr)
            return 1

    # SP-1: declarative Mustache generators from a JSON template-spec. Their output
    # is format-agnostic (text/markdown/csv/json/xml/html), so they run as a SECOND,
    # SEPARATE pass with emit_package_init=False — no Python __init__.py is injected
    # into their (possibly non-Python) output tree. Templates resolve under
    # --templates via a FilesystemProvider.
    spec_gens: list[Generator] = []
    if getattr(args, "template_spec", None):
        from metaobjects.codegen.template_codegen.template_spec import (
            parse_template_spec,
            template_spec_to_generators,
        )

        try:
            spec = parse_template_spec(json.loads(Path(args.template_spec).read_text(encoding="utf-8")))
        except (OSError, ValueError) as exc:
            print(f"error: invalid --template-spec: {exc}", file=sys.stderr)
            return 1
        provider = FilesystemProvider(args.templates)
        spec_gens = template_spec_to_generators(spec, provider)

    entities = _parse_entities(getattr(args, "entities", None))
    providers, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1
    # Load the metadata ONCE; both the default suite and the (optional)
    # --template-spec pass run against this single loaded root.
    root, load_errors = _load_root(args.metadata_dir, providers=providers)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        return 1
    gen_state = gen_state_dir_for(args.metadata_dir)
    written = _run_suite(root, args.out, generators, entities, gen_state_dir=gen_state)
    if spec_gens:
        # The template-spec pass renders user-supplied templates: a bad ref or a
        # wrong --templates dir raises RenderError (not OSError/ValueError, so it
        # escapes the parse-time guard above). Report it as a clean error.
        from metaobjects.render.renderer import RenderError

        try:
            spec_written = _run_suite(
                root, args.out, spec_gens, entities, emit_package_init=False,
                gen_state_dir=gen_state,
            )
        except RenderError as exc:
            print(
                f"error: --template-spec render failed (check the template refs and "
                f"--templates dir {args.templates!r}): {exc}",
                file=sys.stderr,
            )
            return 1
        written = list(written) + spec_written
    for path in written:
        print(path)
    print(f"metaobjects gen: wrote {len(written)} file(s) to {args.out}")
    return 0


def _run_gen_targets(
    config: ProjectConfig,
    targets: list[TargetConfig],
    root: MetaData,
    *,
    gen_state_dir: str | None = None,
) -> tuple[list[str], list[str]]:
    """Run each target's suite into its ``outDir``. Returns (all_written, errors).

    Cross-target duplicate-output-path guard (#267): ``run_gen``'s collision guard
    is per-pass, so two targets writing the same full path would silently clobber
    (generated files carry the @generated header). We accumulate every written full
    path across targets and record an error when two targets emit the same one.
    (Detection is post-write — the colliding file may already be on disk — but the
    command still fails, so a misconfigured gate is caught in CI.)
    """
    all_written: list[str] = []
    seen: dict[str, str] = {}  # full path -> target name
    errors: list[str] = []
    for t in targets:
        gens: list[Generator] | None = None
        if t.generators is not None:
            gens, gen_errors = _resolve_generators(",".join(t.generators))
            if gen_errors:
                errors.extend(f"target '{t.name}': {m}" for m in gen_errors)
                continue
        out_dir = config.out_dir_for(t)
        try:
            written = _run_suite(
                root, out_dir, gens, t.entities, gen_state_dir=gen_state_dir
            )
        except ValueError as exc:  # intra-target run_gen collision → clean error
            errors.append(f"target '{t.name}': {exc}")
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
    """``gen`` with no positional ``metadata_dir`` → declarative-config mode (#267).

    Load ``metaobjects.config.yaml``, load metadata ONCE, and run every target
    (or ``--target``) into its own ``outDir`` with a cross-target duplicate-path
    guard. Providers resolve relative to the config file (no ``PYTHONPATH=``).
    """
    config_path = _find_config(args)
    if config_path is None:
        print(
            "error: no <metadata_dir> given and no metaobjects.config.yaml found. "
            "Either pass <metadata_dir> --out (flag mode) or create a "
            "metaobjects.config.yaml (or pass --config <path>).",
            file=sys.stderr,
        )
        return 2
    try:
        config = load_project_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    targets, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1

    providers, providers_ok = _config_providers(config)
    if not providers_ok:
        return 1

    root, load_errors = _load_root(
        config.metadata_dir(), providers=providers, libraries=config.libraries
    )
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        return 1

    written, errors = _run_gen_targets(
        config, targets, root, gen_state_dir=gen_state_dir_for(config.metadata_dir())
    )
    if errors:
        for msg in errors:
            print(f"error: {msg}", file=sys.stderr)
        return 1
    for path in written:
        print(path)
    print(
        f"metaobjects gen: wrote {len(written)} file(s) across {len(targets)} target(s)."
    )
    return 0


def _relative_set(root: Path) -> dict[str, str]:
    """Map every ``*.py`` file under ``root`` to its content, keyed by rel path.

    Scoped to ``*.py`` because the Python codegen suite emits only Python sources;
    if a generator ever emits a non-``.py`` artifact, broaden this glob so ``verify``
    drift-checks it too.
    """
    files: dict[str, str] = {}
    if root.exists():
        for p in sorted(root.rglob("*.py")):
            files[str(p.relative_to(root))] = p.read_text()
    return files


def _verify_codegen(args: argparse.Namespace) -> int:
    """``verify --codegen`` — regenerate to a temp dir + diff vs committed ``--out``.

    Python's historical ``verify`` behavior, unchanged. Reuses the exact ``gen``
    code path (gen-to-temp + diff), so drift can never be a generator-wiring
    divergence between the two commands.
    """
    # #267: config mode ⇔ no positional <metadata_dir>. The legacy
    # <metadata_dir> + --out diff below is untouched.
    if args.metadata_dir is None:
        return _verify_codegen_config(args)
    if args.out is None:
        print(
            "error: verify --codegen requires --out (the committed output dir).",
            file=sys.stderr,
        )
        return 2

    # Reuse the exact gen code path — regenerate into a throwaway temp dir. The
    # --entities filter must match the `gen` that produced --out, or the diff
    # reports the un-emitted entities as spurious drift.
    # ADR-0023 strict-by-default (#96): verify loads strict unless --lax is given,
    # so an undeclared/typo'd own @attr fails verify (matching Java's Maven goal).
    strict = not getattr(args, "lax", False)
    providers, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        entities = _parse_entities(getattr(args, "entities", None))
        written, errors = _generate(
            args.metadata_dir, tmp, None, entities, strict=strict, providers=providers
        )
        if errors:
            print("error: failed to load metadata:", file=sys.stderr)
            for msg in errors:
                print(f"  {msg}", file=sys.stderr)
            if strict and any("ERR_UNKNOWN_ATTR" in m for m in errors):
                print(_strict_load_hint(), file=sys.stderr)
            return 1

        expected = _relative_set(Path(tmp))
        committed = _relative_set(Path(args.out))

    changed = sorted(
        k for k in expected if k in committed and expected[k] != committed[k]
    )
    missing = sorted(k for k in expected if k not in committed)  # not yet committed
    extra = sorted(k for k in committed if k not in expected)  # stale committed file

    if not changed and not missing and not extra:
        print(f"metaobjects verify: in sync ({len(expected)} file(s)).")
        return 0

    print("error: generated code is out of sync with metadata.", file=sys.stderr)
    for k in changed:
        print(f"  drifted: {k}", file=sys.stderr)
    for k in missing:
        print(f"  missing: {k}", file=sys.stderr)
    for k in extra:
        print(f"  extra:   {k}", file=sys.stderr)
    print(
        "regenerate (metaobjects gen) and commit the result.",
        file=sys.stderr,
    )
    return 1


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
    """
    config_path = _find_config(args)
    if config_path is None:
        print(
            "error: verify --codegen with no <metadata_dir> requires a "
            "metaobjects.config.yaml (or --config <path>).",
            file=sys.stderr,
        )
        return 2
    try:
        config = load_project_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    selected, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1

    # Widen to the outDir-sharing closure: a shared outDir is verified as a unit,
    # so --target a (whose outDir b also writes) pulls b in.
    selected_outdirs = {config.out_dir_for(t) for t in selected}
    closure = [t for t in config.targets if config.out_dir_for(t) in selected_outdirs]
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

    root, load_errors = _load_root(
        config.metadata_dir(), strict=strict, providers=providers, libraries=config.libraries
    )
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        if strict and any("ERR_UNKNOWN_ATTR" in m for m in load_errors):
            print(_strict_load_hint(), file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as temp_root:
        # Map each unique real outDir to ONE temp slot (shared real dir => shared slot).
        temp_for: dict[str, str] = {}
        for t in closure:
            real = config.out_dir_for(t)
            if real not in temp_for:
                temp_for[real] = _temp_slot_for(Path(temp_root), real, config.config_dir)
        remapped = [
            dataclasses.replace(t, out_dir=temp_for[config.out_dir_for(t)]) for t in closure
        ]

        # The exact gen pipeline into the temp tree — verify now rejects exactly
        # what gen rejects (incl. the cross-target duplicate-output-path guard).
        # gen_state_dir stays None: this regenerates into a temp tree purely to
        # diff, so recording a manifest would mutate the user's project from a
        # read-only drift check, keyed to a directory deleted seconds later.
        _written, errors = _run_gen_targets(config, remapped, root)
        if errors:
            for msg in errors:
                print(f"error: {msg}", file=sys.stderr)
            return 1

        exit_code = 0
        for real_outdir in sorted(temp_for):
            tmp_slot = temp_for[real_outdir]
            expected = _relative_set(Path(tmp_slot))
            committed = _relative_set(Path(real_outdir))

            changed = sorted(
                k for k in expected if k in committed and expected[k] != committed[k]
            )
            missing = sorted(k for k in expected if k not in committed)
            extra = sorted(k for k in committed if k not in expected)

            names = "+".join(
                t.name for t in closure if config.out_dir_for(t) == real_outdir
            )
            if not changed and not missing and not extra:
                print(
                    f"metaobjects verify [{names}]: in sync ({len(expected)} file(s))."
                )
                continue
            exit_code = max(exit_code, 1)
            print(
                f"error: [{names}] generated code is out of sync with metadata.",
                file=sys.stderr,
            )
            for k in changed:
                print(f"  drifted: {k}", file=sys.stderr)
            for k in missing:
                print(f"  missing: {k}", file=sys.stderr)
            for k in extra:
                print(f"  extra:   {k}", file=sys.stderr)
            print("regenerate (metaobjects gen) and commit the result.", file=sys.stderr)
        return exit_code


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
    if args.metadata_dir is None:
        print(
            "error: verify --templates requires <metadata_dir> (it is not "
            "config-driven; the config's targets registry drives --codegen only).",
            file=sys.stderr,
        )
        return 2

    template_root = getattr(args, "templates_root", None)
    if not template_root:
        print(
            "error: verify --templates requires --templates-root (the on-disk "
            "template/prompt dir).",
            file=sys.stderr,
        )
        return 2

    # ADR-0023 strict-by-default (#96) — same as --codegen: an undeclared @attr
    # fails verify unless --lax is passed.
    strict = not getattr(args, "lax", False)
    providers, providers_ok = _providers_from_args(args)
    if not providers_ok:
        return 1
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
        vo = _resolve_payload_vo(root, payload_ref, _pkg_of(tmpl))
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


def _cmd_verify(args: argparse.Namespace) -> int:
    """Subverb dispatch (ADR-0021 D2). Run each requested mode; aggregate exit =
    max (non-zero if ANY mode drifts). Bare ``verify`` (no subverb) keeps the
    historical default = ``--codegen`` + a one-line note advertising the subverbs.
    """
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
    if run_db:
        exit_code = max(exit_code, _verify_db(args))
    if run_codegen:
        exit_code = max(exit_code, _verify_codegen(args))
    if run_templates:
        exit_code = max(exit_code, _verify_templates(args))
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
    )
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("gen", help="run codegen, writing files under --out")
    # metadata_dir / --out are optional so `gen --list` works without them.
    gen.add_argument(
        "metadata_dir",
        nargs="?",
        default=None,
        help="directory of metadata JSON/YAML files",
    )
    gen.add_argument("--out", default=None, help="output directory for generated code")
    gen.add_argument(
        "--generators",
        default=None,
        help=(
            "comma-separated STABLE generator names to run (e.g. entity,routes). "
            "Resolved via the registry; omit to run the default suite. "
            "See `gen --list`."
        ),
    )
    gen.add_argument(
        "--list",
        action="store_true",
        help="list registered generators (stable name + description) and exit",
    )
    gen.add_argument(
        "--template-spec",
        dest="template_spec",
        default=None,
        help=(
            "path to a JSON template-spec ({\"generators\":[{name,template,scope,"
            "outputPattern,format?}]}) — declarative Mustache generators appended "
            "to the suite (SP-1). Templates resolve under --templates. For output "
            "to be regenerable, the template must emit the @generated header itself "
            "(the codegen write path refuses to overwrite files lacking it)."
        ),
    )
    gen.add_argument(
        "--templates",
        default="templates",
        help="templates root for --template-spec (default: templates)",
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
            "path to a metaobjects.config.yaml (declarative targets registry). "
            "Config mode runs when no <metadata_dir> is given; default lookup is "
            "./metaobjects.config.yaml in cwd."
        ),
    )
    gen.add_argument(
        "--target",
        default=None,
        help="run only this named target from the config (default: every target)",
    )
    gen.set_defaults(func=_cmd_gen)

    docs = sub.add_parser(
        "docs",
        help=(
            "emit the native Python SDK api-reference docs (the api/python "
            "surface of the cross-port SDK-docs contract) under --out"
        ),
    )
    docs.add_argument("metadata_dir", help="directory of metadata JSON/YAML files")
    docs.add_argument(
        "--out",
        required=True,
        help="docs output root; pages land under <out>/api/python",
    )
    docs.add_argument(
        "--api-subdir",
        dest="api_subdir",
        default=None,
        help="api-surface subdir under --out (default: api/python)",
    )
    docs.add_argument(
        "--project",
        default=None,
        help="project name shown in the docs (default: the metadata dir name)",
    )
    docs.add_argument(
        "--model-base-url",
        dest="model_base_url",
        default=None,
        help="federate the model back-links to an absolute base URL (default: relative)",
    )
    docs.add_argument(
        "--provider",
        action="append",
        metavar="module:symbol",
        help="load a consumer metadata Provider as 'module:symbol' (repeatable; #158)",
    )
    docs.set_defaults(func=_cmd_docs)

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
            "directory of metadata JSON/YAML files. Omit to use a "
            "metaobjects.config.yaml (--codegen config mode, #267)."
        ),
    )
    verify.add_argument(
        "--codegen",
        action="store_true",
        help="codegen drift: regenerate to a temp dir + diff vs --out (default)",
    )
    verify.add_argument(
        "--templates",
        action="store_true",
        help=(
            "template drift: each template.* node's {{field}} ↔ payload-VO "
            "field tree (render verify); requires --templates-root"
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
        help="committed output directory to diff against (for --codegen)",
    )
    verify.add_argument(
        "--templates-root",
        dest="templates_root",
        default=None,
        help="on-disk template/prompt dir the --templates gate resolves refs against",
    )
    verify.add_argument(
        "--entities",
        default=None,
        help="comma-separated entity allowlist for --codegen drift (match `gen --entities`)",
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
            "path to a metaobjects.config.yaml. Config mode runs when no "
            "<metadata_dir> is given; default ./metaobjects.config.yaml in cwd. "
            "Drives --codegen per-target regen+diff."
        ),
    )
    verify.add_argument(
        "--target",
        default=None,
        help="verify only this named target from the config (default: every target)",
    )
    verify.set_defaults(func=_cmd_verify)

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


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns the process exit code (does not call ``sys.exit``)."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
