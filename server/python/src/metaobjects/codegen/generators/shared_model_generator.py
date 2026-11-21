"""``shared-model``: a publisher's flattened shared-model artifact and the manifest that pins it
(FR-023 §4.3), the pair a consumer's ``deps sync`` copies into its own repo and verifies.

Emits two files into the target's out dir: ``<name>.metaobjects.json`` (one canonical-JSON
``metadata.root`` document holding the selected top-level nodes) and ``metaobjects.pkg.json``
(the manifest: name, version, ``metamodelVersion``, the artifact's file name and sha256, and the
sorted packages and nodes). The selection, the closure check and both files' bytes are
:mod:`metaobjects.shared_model`'s; this module only decides which files may contribute and
which version is published, which is why an owned copy changes those and nothing a consumer
checks. The bytes are pinned by ``fixtures/shared-model-conformance`` and identical across ports.

Options (``options:`` of the ``generators`` entry; the generator receives them as keyword
arguments):

* ``name`` (required): the dependency key a consumer syncs under, and the artifact's basename.
* ``include`` (required): scope patterns (``acme::platform::**``) of the top-level nodes to
  publish. ``exclude`` is applied after it. ``template.*`` is never published.
* ``requirements`` (default ``False``): also publish the selected ``requirement.*`` nodes, so a
  consumer can inherit them.
* ``files``: which of the project's own metadata files may contribute, relative to the project
  root. Default: every metadata file of the project (a dependency's artifact is never one).
* ``version``: the published version. Default: the ``version`` of the nearest ``pyproject.toml``
  ``[project]`` table or ``package.json`` at or above the project root.

The files load on their own, as a consumer loads the artifact, so a file that extends a
shipped library's node cannot be among them: name the files that stand alone in ``files``.

A selection that cannot be published (empty, not closed under references, or needing
vocabulary a consumer's toolchain does not ship) fails the run naming why.
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

from metaobjects.codegen.generator import EmittedFile, GenContext
from metaobjects.shared_model import (
    SharedModelError,
    build_shared_model,
    render_shared_model_files,
)

if TYPE_CHECKING:  # the registry imports this module; the context is only an annotation here
    from metaobjects.codegen.generator_registry import GeneratorBuildContext


def _nearest_version(start: Path) -> tuple[str, Path] | None:
    """``(version, file it came from)`` for the nearest ``pyproject.toml`` ``[project]`` version
    or ``package.json`` ``version`` walking up from *start*; ``None`` when there is none."""
    for directory in (start, *start.parents):
        pyproject = directory / "pyproject.toml"
        if pyproject.is_file():
            try:
                version = tomllib.loads(pyproject.read_text(encoding="utf-8")).get("project", {}).get("version")
            except (tomllib.TOMLDecodeError, OSError):
                version = None  # not a version source: keep walking up
            if isinstance(version, str):
                return version, pyproject
        package_json = directory / "package.json"
        if package_json.is_file():
            try:
                version = json.loads(package_json.read_text(encoding="utf-8")).get("version")
            except (ValueError, OSError, AttributeError):
                version = None
            if isinstance(version, str):
                return version, package_json
    return None


class SharedModelGenerator:
    """Emits the shared-model artifact and manifest once per run."""

    name = "shared-model"

    def __init__(
        self,
        name: str | None = None,
        include: Sequence[str] = (),
        exclude: Sequence[str] = (),
        requirements: bool = False,
        files: Sequence[str] | None = None,
        version: str | None = None,
        project_root: str | None = None,
        source_files: Sequence[str] | None = None,
        providers: Sequence[object] = (),
    ) -> None:
        self.model_name = name
        self.include = tuple(include)
        self.exclude = tuple(exclude)
        self.requirements = requirements
        self.files = tuple(files) if files is not None else None
        self.version = version
        self.project_root = Path(project_root) if project_root else None
        self.source_files = tuple(source_files) if source_files is not None else None
        self.providers = tuple(providers)

    @property
    def declared_extra_inputs(self) -> tuple[str, ...]:
        """The files this generator reads that the model does not name (ADR-0064): the
        configured ``files`` and the file the version comes from, project-relative."""
        if self.project_root is None:
            return ()
        paths = [self.project_root / f for f in self.files or ()]
        if self.version is None:
            found = _nearest_version(self.project_root)
            if found is not None:
                paths.append(found[1])
        out: list[str] = []
        for p in paths:
            try:
                out.append(p.resolve().relative_to(self.project_root.resolve()).as_posix())
            except ValueError:
                continue  # outside the project: not a project-relative input
        return tuple(out)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        if not self.model_name or not self.include:
            # Built with no settings (the registry sweeps every generator this way): nothing
            # to publish. A config entry that leaves `name` or `include` out never gets here,
            # because `resolve_options` refuses it first (both options are required).
            return []
        if self.files is not None:
            if self.project_root is None:
                raise ValueError(f"shared-model({self.model_name!r}): 'files' needs a project root to resolve against")
            files = [self.project_root / f for f in self.files]
        else:
            files = [Path(f) for f in self.source_files or ()]
        if not files:
            raise ValueError(
                f"shared-model({self.model_name!r}): no source files to load; pass option 'files' "
                "or run through `metaobjects gen`, which supplies the project's own files."
            )
        model = build_shared_model(
            self.model_name,
            files,
            self.include,
            self.exclude,
            requirements=self.requirements,
            providers=self.providers,
        )
        version = self.version
        if version is None:
            found = _nearest_version(self.project_root or Path.cwd())
            if found is None:
                raise ValueError(
                    f"shared-model({self.model_name!r}): no version available; pass option 'version', "
                    "or run in a project with a pyproject.toml or package.json version at or above "
                    "the project root."
                )
            version = found[0]
        rendered = render_shared_model_files(model, version)
        return [EmittedFile(path=p, content=c) for p, c in (rendered.artifact, rendered.manifest)]


def shared_model_generator(ctx: GeneratorBuildContext) -> SharedModelGenerator:
    """Generator factory for ``shared-model``: takes the build context, which carries the
    entry's options, the project root, the project's own files and the run's providers. See the
    module docstring for the options."""
    options = ctx.options
    return SharedModelGenerator(
        name=options.get("name"),  # type: ignore[arg-type]
        include=options.get("include", ()),  # type: ignore[arg-type]
        exclude=options.get("exclude", ()),  # type: ignore[arg-type]
        requirements=bool(options.get("requirements", False)),
        files=options.get("files"),  # type: ignore[arg-type]
        version=options.get("version"),  # type: ignore[arg-type]
        project_root=ctx.project_root,
        source_files=ctx.source_files,
        providers=ctx.providers,
    )


__all__ = ["SharedModelError", "SharedModelGenerator", "shared_model_generator"]
