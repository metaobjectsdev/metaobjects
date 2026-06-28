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
import json
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


def _load_root(metadata_dir: str) -> tuple[MetaData | None, list[str]]:
    """Load metadata; return ``(root, error_messages)``. ``root`` is None on error."""
    result = MetaDataLoader.from_directory(metadata_dir)
    if result.errors:
        msgs = [f"{e.code}: {e.message}" for e in result.errors]
        return None, msgs
    return result.root, []


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
    config = GenConfig(out_dir=out_dir, emit_package_init=emit_package_init)
    suite = generators if generators is not None else _default_generators()
    result = run_gen(config, root, generators=suite, entity_filter=entity_filter)
    return [path for path, status in result.files if status != "refused"]


def _generate(
    metadata_dir: str,
    out_dir: str,
    generators: list[Generator] | None = None,
    entity_filter: list[str] | None = None,
    emit_package_init: bool = True,
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
    files are written.
    """
    root, errors = _load_root(metadata_dir)
    if root is None:
        return [], errors
    return _run_suite(root, out_dir, generators, entity_filter, emit_package_init), []


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

    root, errors = _load_root(args.metadata_dir)
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

    if args.metadata_dir is None or args.out is None:
        print(
            "error: gen requires <metadata_dir> and --out (or use --list).",
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
    # Load the metadata ONCE; both the default suite and the (optional)
    # --template-spec pass run against this single loaded root.
    root, load_errors = _load_root(args.metadata_dir)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        return 1
    written = _run_suite(root, args.out, generators, entities)
    if spec_gens:
        # The template-spec pass renders user-supplied templates: a bad ref or a
        # wrong --templates dir raises RenderError (not OSError/ValueError, so it
        # escapes the parse-time guard above). Report it as a clean error.
        from metaobjects.render.renderer import RenderError

        try:
            spec_written = _run_suite(
                root, args.out, spec_gens, entities, emit_package_init=False
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
    if args.out is None:
        print(
            "error: verify --codegen requires --out (the committed output dir).",
            file=sys.stderr,
        )
        return 2

    # Reuse the exact gen code path — regenerate into a throwaway temp dir. The
    # --entities filter must match the `gen` that produced --out, or the diff
    # reports the un-emitted entities as spurious drift.
    with tempfile.TemporaryDirectory() as tmp:
        entities = _parse_entities(getattr(args, "entities", None))
        written, errors = _generate(args.metadata_dir, tmp, None, entities)
        if errors:
            print("error: failed to load metadata:", file=sys.stderr)
            for msg in errors:
                print(f"  {msg}", file=sys.stderr)
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
    template_root = getattr(args, "templates_root", None)
    if not template_root:
        print(
            "error: verify --templates requires --templates-root (the on-disk "
            "template/prompt dir).",
            file=sys.stderr,
        )
        return 2

    root, errors = _load_root(args.metadata_dir)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return 1

    provider = FilesystemProvider(template_root)
    # Toolcall templates have no renderable text body (the body IS the schema) —
    # skip them; there is no {{field}} drift to check.
    templates = [
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
        payload_ref = tmpl.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
        if not isinstance(payload_ref, str) or not payload_ref:
            print(f"error: [{tmpl.name}] missing @payloadRef.", file=sys.stderr)
            error_count += 1
            continue
        vo = _resolve_payload_vo(root, payload_ref)
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
            if isinstance(val := tmpl.attr(a), str) and val
        ]
        if not refs:
            print(
                f"error: [{tmpl.name}] declares no resolvable text-ref "
                "(@textRef / @subjectRef / @htmlBodyRef / @textBodyRef).",
                file=sys.stderr,
            )
            error_count += 1
            continue

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
            for e in render_verify(text, fields, provider=provider):
                if e.code == ERR_REQUIRED_SLOT_UNUSED:
                    continue  # warning, not drift
                print(
                    f"error: [{tmpl.name}] ref '{ref}' — {e.code}: "
                    f"{{{{{e.path}}}}} not on payload VO '{payload_ref}'.",
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
    docs.set_defaults(func=_cmd_docs)

    verify = sub.add_parser(
        "verify",
        help=(
            "drift gate — explicit subverbs --codegen / --templates / --db "
            "(ADR-0021 D2); bare verify defaults to --codegen"
        ),
    )
    verify.add_argument("metadata_dir", help="directory of metadata JSON/YAML files")
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
