"""``metaobjects fmt`` (#304) — rewrite metadata files into the canonical form
the cross-port canonical serializer already produces. ``--check`` lists files
that are not canonical and exits non-zero without changing anything.

Mirrors the TS reference (``packages/metadata/src/fmt.ts`` +
``packages/cli/src/lib/fmt-engine.ts``) and the C#/Java ports exactly:

- Each file is formatted STANDALONE — own-mode, declared-here layer only
  (ADR-0039). ``parse_document`` already builds a fresh, unmerged tree per
  document (this port's loader does parse -> merge -> super-resolve as three
  separate steps, unlike TS/C#'s accumulating-root parser) — calling it
  directly and never running ``merge_roots``/``resolve_supers`` is what makes
  a cross-file ``extends`` round-trip untouched (the raw ``super_ref`` string
  is read directly by ``canonical_serialize``, never its resolution) and an
  ``overlay: true`` node never even attempt a merge.
- An ``overlay: true`` node is tagged (``is_overlay``) by the parser but never
  resolved here — Python's overlay MERGE only happens in ``loader/merge.py``,
  which this module never calls. A file containing one anywhere in its tree
  (detected by :func:`_contains_overlay`) is reported as a skip rather than
  guessed at — the concrete shape of "overlay files stay overlays".
- YAML is always skipped: no canonical YAML emitter exists (ADR-0006).
- Before writing, the whole project is reloaded with the candidate
  substituted in via an in-memory source (never touching disk until proven
  safe) and the write is refused unless that reload has no errors AND its
  canonical form is byte-identical to the untouched baseline.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from metaobjects.errors import MetaError
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources.file_source import FileSource
from metaobjects.loader.sources.meta_data_source import InMemoryStringSource, MetaDataSource
from metaobjects.meta.meta_data import MetaData
from metaobjects.parser import parse_document
from metaobjects.registry import TypeRegistry
from metaobjects.serializer_json import canonical_serialize

#: Statuses a single file's run can report.
STATUS_FORMATTED = "formatted"
STATUS_WOULD_FORMAT = "would-format"
STATUS_UNCHANGED = "unchanged"
STATUS_SKIPPED_YAML = "skipped-yaml"
STATUS_SKIPPED_OVERLAY = "skipped-overlay"
STATUS_ERROR = "error"


@dataclass
class FormatFileResult:
    ok: bool
    overlay: bool = False
    text: str | None = None
    message: str | None = None


def _contains_overlay(node: MetaData) -> bool:
    """Whether *node* or any descendant (own children only — this tree was
    never merged, so every child already is its own) carries ``overlay: true``.
    """
    if getattr(node, "is_overlay", False):
        return True
    return any(_contains_overlay(child) for child in node.own_children())


def format_file(content: str, registry: TypeRegistry, source_id: str) -> FormatFileResult:
    """Format one file's own content. Parses *content* standalone via
    :func:`parse_document` — never merged with any other file, super
    resolution never run — and, on a clean parse with no overlay anywhere in
    the tree, returns the canonical serialization of the resulting file root.
    Never raises for a malformed file; that comes back as ``ok=False``.
    """
    # Strip a UTF-8 BOM before parsing — json.loads rejects one outright
    # ("Unexpected UTF-8 BOM (decode using utf-8-sig)"), and Java-authored
    # files often carry one.
    normalized = content[1:] if content.startswith("﻿") else content
    try:
        doc = json.loads(normalized)
    except json.JSONDecodeError as exc:
        return FormatFileResult(ok=False, message=f"invalid JSON: {exc}")

    try:
        result = parse_document(doc, registry, source_id)
    except Exception as exc:  # a few structural failures raise rather than record
        return FormatFileResult(ok=False, message=str(exc))

    if result.errors:
        message = "; ".join(e.message for e in result.errors)
        return FormatFileResult(ok=False, message=message)

    if _contains_overlay(result.root):
        return FormatFileResult(
            ok=False,
            overlay=True,
            message="this file declares an overlay fmt cannot resolve standalone",
        )

    return FormatFileResult(ok=True, text=canonical_serialize(result.root))


@dataclass
class FileReport:
    path: Path
    status: str
    detail: str | None = None


@dataclass
class RunResult:
    files: list[FileReport] = field(default_factory=list)
    fatal: str | None = None


def run(
    all_files: list[Path],
    target_files: list[Path],
    file_ids: dict[Path, str],
    registry: TypeRegistry,
    lib_sources: list[MetaDataSource],
    check: bool,
    providers: list[object] | None = None,
) -> RunResult:
    """Run fmt over *target_files* (a subset of *all_files* — the project's
    FULL resolved file set, needed for the whole-project safety-check reload
    regardless of which files are in scope to format).

    *providers* must be the SAME provider list *registry* (used for every
    standalone per-file parse) was composed from — the whole-project baseline
    and safety-check reloads build their own `MetaDataLoader`, which recomposes
    a registry from *providers* itself rather than taking `registry` directly,
    so passing a different set here would silently check two vocabularies
    against each other.
    """

    def source_id(path: Path) -> str:
        return file_ids.get(path) or path.name

    def build_sources(
        override_path: Path | None = None, override_text: str | None = None
    ) -> list[MetaDataSource]:
        sources: list[MetaDataSource] = list(lib_sources)
        for p in all_files:
            if override_path is not None and p == override_path:
                sources.append(InMemoryStringSource(override_text or "", id=source_id(p)))
            else:
                sources.append(FileSource(p, id=source_id(p)))
        return sources

    baseline = MetaDataLoader(providers=providers, strict=False).load(build_sources())
    if baseline.errors:
        detail = "\n".join(f"  {e.code}: {e.message}" for e in baseline.errors)
        return RunResult(
            fatal=(
                "this project's metadata does not currently load cleanly — fix the "
                f"error(s) below, then re-run fmt:\n{detail}"
            )
        )
    baseline_canonical = canonical_serialize(baseline.root)

    reports: list[FileReport] = []
    for path in target_files:
        ext = path.suffix.lower()
        if ext in (".yaml", ".yml"):
            reports.append(
                FileReport(
                    path,
                    STATUS_SKIPPED_YAML,
                    "no canonical YAML emitter exists (ADR-0006: JSON is the canonical "
                    "interchange form) — left untouched",
                )
            )
            continue

        content = path.read_text(encoding="utf-8")
        formatted = format_file(content, registry, source_id(path))
        if not formatted.ok:
            reports.append(
                FileReport(
                    path,
                    STATUS_SKIPPED_OVERLAY if formatted.overlay else STATUS_ERROR,
                    formatted.message,
                )
            )
            continue

        if formatted.text == content:
            reports.append(FileReport(path, STATUS_UNCHANGED))
            continue

        test_load = MetaDataLoader(providers=providers, strict=False).load(
            build_sources(path, formatted.text)
        )
        safe = not test_load.errors and canonical_serialize(test_load.root) == baseline_canonical
        if not safe:
            reports.append(
                FileReport(
                    path,
                    STATUS_ERROR,
                    "formatting this file would change the loaded model's meaning — left unchanged",
                )
            )
            continue

        if check:
            reports.append(FileReport(path, STATUS_WOULD_FORMAT))
        else:
            path.write_text(formatted.text, encoding="utf-8")
            reports.append(FileReport(path, STATUS_FORMATTED))

    return RunResult(files=reports)
