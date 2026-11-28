"""``docs-site`` -- the model explorer: one browser app over the project's docs view, written
with no Node on the path (the Python side of TypeScript's ``docsSiteFile()``, ``output: "app"``).

It builds the docs view from the loaded model (:func:`metaobjects.docs_view.build_docs_view`),
lists the files generated for each node (``generatedBy`` and ``sourceNode``: this run's output,
laid over what the committed hash manifest already records), and writes under ``site/``:

    index.html, assets/explorer-app.js,          the app: the same bytes in every port, from the
    assets/cytoscape.min.js,                     package data ``documentation/explorer_app/``
    assets/3d-force-graph.min.js                 (``scripts/sync-explorer-app.sh`` refreshes it)
    assets/explorer.css, assets/explorer.js      the theme, or the project's owned copy
    explorer-model.js                            the docs view, the prompt texts, the title, the
                                                 footer and any owned templates, as one script
    explorer-stamp.js                            the model's hash, which the open app polls
    explorer.json                                the docs view itself, byte for byte

The runner runs it after every other generator (``reads_run_output``), so it sees the whole
run's output. A project that owns the explorer's theme (``meta eject docs-site`` copies it into
``codegen/docs-site/``) has its ``assets/explorer.css``, ``assets/explorer.js`` and
``templates/explorer-*.mustache`` used in place of the packaged ones. The page-per-screen static
export (``output: "static"``) draws its pages with the TypeScript page code and stays there.

Options (``options:`` on the ``generators`` entry): ``subDir`` (default ``site``; empty writes at
the target's root), ``title`` (default: the project directory's name), ``stamp`` (footer text,
default none, so the site depends on the model alone), ``prompts`` (a directory, relative to the
project, holding prompt ``.mustache`` sources outside the metadata directories and ``templates/``),
``verifyFile`` (a ``verify --format json`` payload whose requirement rows the explorer shows) and
``routesFile`` (the routes the application mounts, ``[{ node, method, path }]``, ``node`` a
resolution key).
"""
from __future__ import annotations

import json
import os
from importlib import resources
from pathlib import Path
from typing import Any

from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.overwrite_policy import _read_union
from metaobjects.docs_view import (
    build_docs_view,
    explorer_model_script,
    explorer_stamp_script,
    serialize_docs_view,
)
from metaobjects.meta.template.template_constants import TEMPLATE_ATTR_TEXT_REF

DEFAULT_SUB_DIR = "site"
#: Where an owned explorer theme lives, under the project (TypeScript's ``OWNED_DOCS_SITE_DIR``).
OWNED_DOCS_SITE_DIR = "codegen/docs-site"

MODEL_FILE = "explorer-model.js"
STAMP_FILE = "explorer-stamp.js"
VIEW_FILE = "explorer.json"

#: The app's files: every port ships the same bytes (TypeScript's ``EXPLORER_APP_FILES``).
APP_FILES = (
    "index.html",
    "assets/explorer-app.js",
    "assets/explorer.css",
    "assets/explorer.js",
    "assets/cytoscape.min.js",
    "assets/3d-force-graph.min.js",
)
#: The theme pair a project may own (``assets/`` under the owned docs-site directory).
THEME_ASSETS = ("explorer.css", "explorer.js")
#: The templates an owned theme may replace; the app uses an owned one in place of its own.
TEMPLATE_NAMES = (
    "explorer-head.mustache",
    "explorer-foot.mustache",
    "explorer-card.mustache",
    "explorer-overview.html.mustache",
    "explorer-map.html.mustache",
    "explorer-object.html.mustache",
    "explorer-node.html.mustache",
    "explorer-prompt.html.mustache",
    "explorer-prompts.html.mustache",
    "explorer-requirements.html.mustache",
    "explorer-requirement.html.mustache",
    "explorer-matrix.html.mustache",
    "explorer-trace.html.mustache",
    "explorer-gaps.html.mustache",
    "explorer-api.html.mustache",
    "explorer-model.html.mustache",
    "explorer-package.html.mustache",
)


def _app_resource(rel: str) -> str:
    node = resources.files("metaobjects.documentation").joinpath("explorer_app")
    for part in rel.split("/"):
        node = node.joinpath(part)
    return node.read_text(encoding="utf-8")


def _read_if_present(directory: Path | None, name: str) -> str | None:
    if directory is None:
        return None
    p = directory / name
    return p.read_text(encoding="utf-8") if p.is_file() else None


def read_prompt_texts(view: dict[str, Any], dirs: list[Path]) -> dict[str, str]:
    """Each prompt's ``.mustache`` text from the directories its ``@textRef`` resolves in, by
    template node id. A ref that is absolute or climbs out with ``..`` is not read, so a model
    cannot pull an arbitrary file into a published page."""
    out: dict[str, str] = {}
    for n in view["nodes"]:
        ref: str | None = None
        for a in n["attrs"]:
            if a["name"] == TEMPLATE_ATTR_TEXT_REF and isinstance(a["value"], str):
                ref = a["value"]
        if ref is None:
            continue
        segments = ref.replace("\\", "/").split("/")
        if ref.startswith(("/", "\\")) or os.path.isabs(ref) or any(s in ("", "..") for s in segments):
            continue
        for d in dirs:
            p = d.joinpath(*segments[:-1], segments[-1] + ".mustache")
            if p.is_file():
                out[n["id"]] = p.read_text(encoding="utf-8")
                break
    return dict(sorted(out.items()))


def emit_site(
    view: dict[str, Any],
    title: str,
    footer: str,
    texts: dict[str, str],
    assets_dir: Path | None,
    templates_dir: Path | None,
) -> dict[str, str]:
    """Every file of the site, site-relative, in write order."""
    files: dict[str, str] = {}
    for f in APP_FILES:
        if f.startswith("assets/") and f[len("assets/"):] in THEME_ASSETS:
            continue
        files[f] = _app_resource(f)
    for a in THEME_ASSETS:
        owned = _read_if_present(assets_dir, a)
        files["assets/" + a] = owned if owned is not None else _app_resource("assets/" + a)
    templates: dict[str, str] = {}
    for name in TEMPLATE_NAMES:
        owned = _read_if_present(templates_dir, name)
        if owned is not None:
            templates[name] = owned
    script, stamp = explorer_model_script(title, footer, texts, templates, view)
    files[MODEL_FILE] = script
    files[STAMP_FILE] = explorer_stamp_script(stamp)
    files[VIEW_FILE] = serialize_docs_view(view)
    return files


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise ValueError(f"docs-site: could not read {path}: {e}") from e


class DocsSiteGenerator:
    """Writes the model explorer site."""

    name = "docs-site"
    #: The runner runs a generator that reads the run's output after every other one.
    reads_run_output = True

    def __init__(
        self,
        sub_dir: str = DEFAULT_SUB_DIR,
        title: str | None = None,
        stamp: str = "",
        prompts: str | None = None,
        verify_file: str | None = None,
        routes_file: str | None = None,
    ) -> None:
        self.sub_dir = sub_dir.strip("/")
        self.title = title
        self.stamp = stamp
        self.prompts = prompts
        self.verify_file = verify_file
        self.routes_file = routes_file
        #: The owned theme, the prompts directory and the verify and routes files are read beside
        #: the model (ADR-0064): editing one regenerates. The hash manifest is not an input: the
        #: files the site lists are this run's and the manifest's, and the whole-run skip already
        #: re-runs when the manifest gains, loses or changes a file.
        self.declared_extra_inputs: tuple[str, ...] = tuple(
            p for p in (OWNED_DOCS_SITE_DIR, prompts, verify_file, routes_file) if p
        )

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        config = ctx.config
        # A run that names no project finds no owned theme or templates through the process's
        # working directory, which may change between gen and verify; paths the options name
        # explicitly still resolve against it.
        known = bool(config.project_root)
        project = Path(config.project_root or os.getcwd()).resolve()
        verify = _read_json(project / self.verify_file) if self.verify_file else None
        routes = _read_json(project / self.routes_file) if self.routes_file else None
        generated = self._provenance(ctx)
        root = ctx.loaded_root
        if root is None:
            raise ValueError("docs-site: needs a loaded model")
        view = build_docs_view(root, verify, generated, routes)

        owned = project / OWNED_DOCS_SITE_DIR
        files = emit_site(
            view,
            self.title if self.title is not None else ((project.name if known else "") or "Metadata"),
            self.stamp,
            read_prompt_texts(view, self._prompt_dirs(root, project, known)),
            owned / "assets" if known and (owned / "assets").is_dir() else None,
            owned / "templates" if known and (owned / "templates").is_dir() else None,
        )
        prefix = f"{self.sub_dir}/" if self.sub_dir else ""
        return [EmittedFile(path=prefix + rel, content=content) for rel, content in files.items()]

    @staticmethod
    def _provenance(ctx: GenContext) -> dict[str, Any] | None:
        """``path -> { generatedBy, sourceNode }`` as the docs view reads it. In a run, the
        runner's list (this run's files, after the committed ones its orphan sweep leaves alone),
        even when empty; outside a run, what the committed hash manifest records. ``None`` with
        no manifest."""
        out: dict[str, Any] = {}
        if ctx.run_provenance is not None:
            for path, (by, node) in ctx.run_provenance.items():
                if node is not None:
                    out[path] = {"generatedBy": by, "sourceNode": node}
            return out
        gen_state = ctx.config.committed_gen_state_dir()
        if gen_state is None:
            return None
        raw, _where = _read_union(gen_state)
        for path, entry in raw.items():
            if isinstance(entry, dict) and isinstance(entry.get("sourceNode"), str):
                out[path] = {"generatedBy": entry.get("generatedBy", ""), "sourceNode": entry["sourceNode"]}
        return out if raw else None

    def _prompt_dirs(self, root: Any, project: Path, config_known: bool = True) -> list[Path]:
        """Where prompt ``.mustache`` sources are looked for: the directories the model was
        loaded from, the project's ``templates/`` and the ``prompts`` directory, each once."""
        dirs: dict[Path, None] = {}
        for node in root.children():
            for f in getattr(node.source, "files", ()) or ():
                parent = Path(f).resolve().parent
                dirs.setdefault(parent, None)
        templates = project / "templates"
        if config_known and templates.is_dir():
            dirs.setdefault(templates, None)
        if self.prompts:
            p = (project / self.prompts).resolve()
            if p.is_dir():
                dirs.setdefault(p, None)
        return list(dirs)


def docs_site_generator(**options: Any) -> Generator:
    """The registry's ``source=``, and so the symbol an ejected copy is wired by. Takes the
    entry's options as keyword arguments (``verifyFile`` -> ``verify_file``)."""
    return DocsSiteGenerator(**options)
