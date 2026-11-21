"""Codegen plugin engine — Generator protocol + per-entity/once-per-run helpers.
Mirrors server/typescript/packages/codegen-ts/src/generator.ts."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from .config import GenConfig
from .name_claims import NameClaims


@dataclass
class EmittedFile:
    path: str            # relative to GenConfig.out_dir
    content: str         # final, formatted Python source
    generated_by: str = ""  # set by the runner from Generator.name


#: The default api-surface subdirectory (the cross-port contract's ``api/python``).
DEFAULT_API_SUBDIR = "api/python"


@dataclass
class GenContext:
    entities: list[MetaObject]
    loaded_root: MetaData | None
    matches: Callable[[MetaObject], bool]
    config: GenConfig
    warn: Callable[[str], None]
    #: The stable names of every generator in this run, so one generator can tell that a
    #: sibling is wired (the router emits the ``?format=`` branch only beside ``report-export``).
    generators: tuple[str, ...] = ()
    #: FR-023 — is the requirement at ``<package>::<dotted path>`` this project's ledger
    #: (``Collection.in_ledger``)? A dependency's requirement the project did not inherit
    #: gets no generated test. ``None``: every loaded requirement is the project's.
    in_ledger: Callable[[str], bool] | None = None
    #: The run's one claim registry : a generator claims each module it emits in
    #: its generated package directory, and a second claimant is refused with
    #: ``ERR_NAME_COLLISION``. ``run_gen`` shares one across every generator of the run.
    claims: NameClaims = field(default_factory=NameClaims)
    #: ``gen --entities``: whether an entity in ``entities`` was selected. ``entities`` is
    #: always the WHOLE model in scope, so a whole-model file renders the same on a narrowed
    #: run; a per-entity file honours this as well (``per_entity`` applies it). ``None``:
    #: every entity is selected.
    selected: Callable[[MetaObject], bool] | None = None

    def is_selected(self, entity: MetaObject) -> bool:
        return self.selected is None or self.selected(entity)

    def claim(self, scope: str, name: str, claimant: str, remedy: str) -> None:
        """Claim *name* in *scope* for the metadata node *claimant* (its ``resolution_key()``)."""
        self.claims.claim(scope, name, claimant, remedy)


class Generator(Protocol):
    """A generator has a ``name`` and a ``generate`` method.

    It may also carry two optional attributes that ADR-0064's whole-run skip reads (both
    default as below when absent, so no existing generator changes):

    - ``cacheable: bool`` (default ``True``). ``False`` means the generator reads something
      nobody can declare; a run that includes it never skips.
    - ``declared_extra_inputs: tuple[str, ...]`` (default ``()``). Project-relative paths
      the generator reads beyond the model, the config and the template roots; their
      content is part of the run's key.
    """

    name: str

    def generate(self, ctx: GenContext) -> list[EmittedFile]: ...


class SelectedGenerator:
    """A generator limited to some packages and objects: the ``packages`` / ``entities`` of its
    ``generators`` entry in ``metaobjects.config.yaml``.

    It is the wrapped generator with one thing changed, its ``filter`` (the predicate the
    runner reads into ``ctx.matches``): the wrapped generator's own filter, if it has one,
    AND-ed with the selection. So the selection can only narrow, and it narrows a whole-model
    file the generator writes (shared enums, a report writer) the same way as a per-object
    one: the file is built from the objects the generator is selected for. Every other
    attribute (``name``, ``cacheable``, ``declared_extra_inputs``, whatever an owned
    generator adds) is the wrapped generator's.
    """

    def __init__(
        self,
        inner: "Generator",
        packages: frozenset[str] | None,
        entities: frozenset[str] | None,
    ) -> None:
        self._inner = inner
        self._packages = packages
        self._entities = entities

    def __getattr__(self, attr: str) -> object:
        # Only reached for what this class does not define: delegate to the wrapped generator.
        return getattr(self._inner, attr)

    @property
    def inner(self) -> "Generator":
        return self._inner

    def selects(self, entity: MetaObject) -> bool:
        from metaobjects.codegen.value_objects import pkg_of

        return (self._entities is None or entity.name in self._entities) and (
            self._packages is None or pkg_of(entity) in self._packages
        )

    def filter(self, entity: MetaObject) -> bool:
        inner_filter = getattr(self._inner, "filter", None)
        return self.selects(entity) and (not callable(inner_filter) or bool(inner_filter(entity)))

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        return self._inner.generate(ctx)


def generator_cacheable(gen: object) -> bool:
    """Whether a run that includes ``gen`` may be skipped when nothing changed."""
    return bool(getattr(gen, "cacheable", True))


def generator_extra_inputs(gen: object) -> tuple[str, ...]:
    """The project-relative paths ``gen`` declared as extra inputs."""
    return tuple(getattr(gen, "declared_extra_inputs", ()) or ())


def per_entity(
    fn: Callable[[MetaObject, GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """One-file-per-entity convenience; selects via ctx.matches."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        out: list[EmittedFile] = []
        for e in ctx.entities:
            if not ctx.matches(e) or not ctx.is_selected(e):
                continue
            r = fn(e, ctx)
            out.extend(r if isinstance(r, list) else [r])
        return out

    return run


def once_per_run(
    fn: Callable[[list[MetaObject], GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """Called once with all matching entities (barrels / cross-entity files) — the whole
    model, even on a ``gen --entities`` run."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        matched = [e for e in ctx.entities if ctx.matches(e)]
        r = fn(matched, ctx)
        return r if isinstance(r, list) else [r]

    return run


def per_package(
    fn: Callable[[str, list[MetaObject], GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """One-file-per-package convenience. Groups matched entities by effective
    package, runs ``fn(pkg, entities, ctx)`` once per package (packages ascending,
    entities keeping ``ctx.entities`` order). The package scope from
    codegen-concepts §10 (object + model already exist via per_entity + per_model)."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        # Local import avoids a module cycle (template_data imports nothing from here).
        from metaobjects.codegen.template_codegen.template_data import package_of

        by_pkg: dict[str, list[MetaObject]] = {}
        for e in ctx.entities:
            if not ctx.matches(e):
                continue
            by_pkg.setdefault(package_of(e), []).append(e)
        out: list[EmittedFile] = []
        for pkg in sorted(by_pkg):
            r = fn(pkg, by_pkg[pkg], ctx)
            out.extend(r if isinstance(r, list) else [r])
        return out

    return run


#: App-scope alias — run once over the whole model. The canonical name for the
#: one-shot scope (``once_per_run`` stays as a soft-deprecated alias; "run" is
#: ambiguous under multi-target output, ``per_model`` names the data scope).
per_model = once_per_run
