"""The ``metaobjects`` console-script — codegen `gen` + drift `verify` (SP-E Unit 2).

Two subcommands:

  metaobjects gen    <metadataDir> --out <dir> [--package <pkg>]
      Load metadata, run the Python codegen generator suite, and write files
      under ``--out`` (guarded by the @generated header). Prints each written
      file. Non-zero exit on a load error.

  metaobjects verify <metadataDir> --out <dir>
      Regenerate into a temp dir and diff against the committed ``--out`` tree
      (content + file set). Any drift — changed / missing / extra file — prints
      a report plus a "regenerate (metaobjects gen) and commit" message and
      returns 1. In sync → 0.

Named ``metaobjects``, NOT ``meta``: ``meta`` is the Node schema CLI. This CLI
intentionally has NO ``migrate`` subcommand — schema is owned by the Node
toolchain (ADR-0015). ``verify`` shares the exact same generation code path as
``gen`` (verify = gen-to-temp + diff), so drift can never be a generator-wiring
divergence between the two commands.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
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


def _generate(
    metadata_dir: str, out_dir: str, generators: list[Generator] | None = None
) -> tuple[list[str], list[str]]:
    """Run the generator suite into ``out_dir``.

    ``generators`` defaults to the zero-config default suite; pass a registry-
    resolved subset for ``--generators``. Returns ``(written_paths, errors)``. On
    a load error, ``errors`` is non-empty and no files are written.
    """
    root, errors = _load_root(metadata_dir)
    if root is None:
        return [], errors
    config = GenConfig(out_dir=out_dir)
    suite = generators if generators is not None else _default_generators()
    result = run_gen(config, root, generators=suite)
    written = [path for path, status in result.files if status != "refused"]
    return written, []


def _cmd_list(_args: argparse.Namespace) -> int:
    """Print each registered generator ``<stable-name> — <description>`` and exit 0.

    Does NOT run codegen — pure discoverability (ADR-0021 D3).
    """
    for entry in list_generators():
        print(f"{entry.name} — {entry.description}")
    return 0


def _cmd_gen(args: argparse.Namespace) -> int:
    # `--list` is a pure discoverability path: print the registry and exit, no codegen.
    if getattr(args, "list", False):
        return _cmd_list(args)

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

    written, errors = _generate(args.metadata_dir, args.out, generators)
    if errors:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return 1
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


def _cmd_verify(args: argparse.Namespace) -> int:
    # Reuse the exact gen code path — regenerate into a throwaway temp dir.
    with tempfile.TemporaryDirectory() as tmp:
        written, errors = _generate(args.metadata_dir, tmp)
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
    gen.add_argument(
        "--out", default=None, help="output directory for generated code"
    )
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
        "--package",
        default=None,
        help="(reserved) package hint; Python derives package from metadata",
    )
    gen.set_defaults(func=_cmd_gen)

    verify = sub.add_parser(
        "verify",
        help="regenerate to a temp dir and fail on drift vs --out",
    )
    verify.add_argument("metadata_dir", help="directory of metadata JSON/YAML files")
    verify.add_argument(
        "--out", required=True, help="committed output directory to diff against"
    )
    verify.set_defaults(func=_cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns the process exit code (does not call ``sys.exit``)."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
