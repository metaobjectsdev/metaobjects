"""ADR-0021 D3 — stable-name generator registry (Python port).

Generators are identified by a STABLE string id (e.g. ``entity``, ``routes``,
``render-helper``) rather than by a language-specific factory import. The id is
the cross-port contract: the same logical generator carries the same stable name
in every port. This module is the discoverability + identity surface behind
``metaobjects gen --list`` and the ``--generators a,b`` selection path.

It is the ONLY name-based door. ADR-0034 Amendment 2 made codegen opt-in and DELETED
the default suite this note used to name (``cli._default_generators``): a run that
selects no generator generates nothing and raises ``NoGeneratorsSelectedError``. The
``run_gen(..., generators=[...])`` factory-array path remains for in-process callers,
where ``generators`` is likewise required.

The registry's name set is conformance-tested for SET EQUALITY against the Python
slice of the canonical manifest
(``fixtures/generator-registry-conformance/registry.json``): exactly the manifest
entries whose ``ports`` array includes ``python``. All Python entries are
``tier: native``.
"""
from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Mapping

from metaobjects.codegen.generator import Generator
from metaobjects.codegen.project_config import DEFAULT_REQUIREMENT_WITNESS_MODULE, ApiDocsConfig
from metaobjects.codegen.generators.api_docs_generator import api_docs_generator
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
from metaobjects.codegen.generators.render_helper_generator import (
    render_helper_generator,
)
from metaobjects.codegen.generators.report_export_generator import report_export_generator
from metaobjects.codegen.generators.requirement_tests_generator import (
    requirement_tests_generator,
)
from metaobjects.codegen.generators.router_generator import (
    EXPORT_RUNTIME_MODULE as _EXPORT_RUNTIME,
    RUNTIME_MODULES as _ROUTER_RUNTIME,
    router_generator,
)
from metaobjects.codegen.generators.shared_model_generator import shared_model_generator
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.codegen.generators.trace_helper_generator import trace_helper_generator
from metaobjects.render.verify import InMemoryProvider

GeneratorTier = str  # "native" | "neutral"

#: The six layers a generator can belong to — the axis an adopter SELECTS BY, gated
#: cross-port against the manifest exactly as ``tier`` is. Six, not ten: an earlier
#: draft split ``capability`` four ways, each with ONE member, and a layer with one
#: member does no grouping work. ``capability`` holds the generators the MODEL has
#: already chosen (you declared a ``template.prompt``), which is why they are found
#: by probing a real model rather than by browsing a taxonomy.
GENERATOR_LAYERS: tuple[str, ...] = (
    "model",
    "persistence",
    "api",
    "client",
    "docs",
    "capability",
)

GeneratorLayer = str  # one of GENERATOR_LAYERS


@dataclass(frozen=True)
class GeneratorOption:
    """One setting a packaged generator takes in ``options:`` on its ``generators`` entry.

    ``name`` is the camelCase key the config file uses (every key in that file is camelCase);
    the generator receives it as the snake_case keyword argument :attr:`kwarg`. ``kind`` is
    ``integer``, ``boolean``, ``string`` or ``stringList`` (a list of non-empty strings);
    ``choices`` closes a string, ``minimum`` bounds an integer."""

    name: str
    kind: str
    description: str
    choices: tuple[str, ...] | None = None
    minimum: int | None = None
    #: A generator that cannot run without it: ``resolve_options`` refuses an entry that
    #: leaves it out, naming it, instead of the run failing (or doing nothing) later.
    required: bool = False

    @property
    def kwarg(self) -> str:
        return snake_case_option(self.name)

    def coerce(self, value: object) -> tuple[object, str | None]:
        """``(value, None)`` when ``value`` is acceptable, else ``(None, why)``."""
        if self.kind == "boolean":
            if isinstance(value, bool):
                return value, None
            return None, "must be true or false"
        if self.kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                return None, "must be a whole number"
            if self.minimum is not None and value < self.minimum:
                return None, f"must be at least {self.minimum}"
            return value, None
        if self.kind == "stringList":
            if (
                not isinstance(value, list)
                or not all(isinstance(v, str) and v for v in value)
            ):
                return None, "must be a list of non-empty strings"
            return tuple(value), None
        if not isinstance(value, str) or not value:
            return None, "must be a non-empty string"
        if self.choices is not None and value not in self.choices:
            return None, f"must be one of {', '.join(self.choices)}"
        return value, None


_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])([A-Z])")


def snake_case_option(name: str) -> str:
    """``maxRows`` -> ``max_rows``: how an option key of the config file becomes the keyword
    argument a generator takes. A key with no capital is returned as it is."""
    return _CAMEL_BOUNDARY.sub(r"_\1", name).lower()


def resolve_options(
    generator: str, accepted: tuple[GeneratorOption, ...], raw: Mapping[str, object]
) -> tuple[dict[str, object], list[str]]:
    """Check a ``generators`` entry's ``options`` against what the packaged generator takes.

    Returns ``(keyword arguments, errors)``. A name the generator does not take is an error
    that lists the names it does, so a misspelling names its own fix."""
    errors: list[str] = []
    known = {o.name: o for o in accepted}
    kwargs: dict[str, object] = {}
    for key, value in raw.items():
        option = known.get(key)
        if option is None:
            takes = ", ".join(sorted(known)) if known else "none"
            errors.append(f"generator {generator!r} takes no option {key!r}; options: {takes}")
            continue
        coerced, why = option.coerce(value)
        if why is not None:
            errors.append(f"generator {generator!r} option {key!r} {why}, got {value!r}")
            continue
        kwargs[option.kwarg] = coerced
    for option in accepted:
        if option.required and option.name not in raw:
            errors.append(f"generator {generator!r} needs the option {option.name!r}: {option.description}")
    return kwargs, errors


@dataclass(frozen=True)
class RequirementTestsOptions:
    """The ``requirementTests`` config block, RESOLVED: ``renderer`` and ``filter`` are the
    callables their ``module:symbol`` strings named. The CLI resolves them against the config
    directory (the way ``providers`` are) so a generator factory, packaged or owned, only
    reads attributes."""

    witness_module: str = DEFAULT_REQUIREMENT_WITNESS_MODULE
    grain: str = "concern"
    renderer: Callable[..., object] | None = None
    filter: Callable[..., bool] | None = None
    warn_uncovered: bool = True


@dataclass(frozen=True)
class GeneratorBuildContext:
    """Extra inputs a factory may need to construct a generator.

    Today only the on-disk template root, required by ``render-helper``'s build-time
    drift gate and used by the ``template`` primitive. Optional so ``--list`` can
    construct every entry without supplying one — a factory must never throw.

    Ported from the C# port's ``GeneratorBuildContext`` rather than invented here, so
    the two registries answer "what does a factory need" the same way. Before this, the
    Python factory took no arguments at all and ``_render_helper_default`` hardcoded
    ``template_root="templates"``: the CLI's ``--templates`` never reached the
    generator, so ``metaobjects gen --generators render-helper`` resolved templates from
    a directory the user had not named and, in a project that keeps them anywhere else,
    from a directory that does not exist.
    """

    #: The on-disk directory template refs resolve under. ``None`` = not supplied
    #: (``--list``, registry identity), which every factory must tolerate.
    template_root: str | None = None
    #: The ``requirementTests`` block of ``metaobjects.config.yaml``, resolved. ``None`` =
    #: no block (or ``--list``): the ``requirement-tests`` generator uses its defaults.
    requirement_tests: RequirementTestsOptions | None = None
    #: The ``apiDocs`` block of ``metaobjects.config.yaml``. ``None`` = no block (or
    #: ``--list``): the ``api-docs`` generator uses its defaults.
    api_docs: ApiDocsConfig | None = None
    #: The ``options`` of the ``generators`` entry being built, already checked and renamed to
    #: the keyword arguments the generator takes (``maxRows`` -> ``max_rows``). Empty when the
    #: entry has none, and for ``--list``. A team's own factory that takes this context reads
    #: the entry's options here exactly as written.
    options: Mapping[str, object] = field(default_factory=dict)
    #: The project directory (the one holding ``.metaobjects/``), absolute. ``None`` for
    #: ``--list``. A generator that reads a file the model does not name (the shared-model
    #: publisher's ``files`` and version) resolves it here.
    project_root: str | None = None
    #: The project's OWN metadata files, absolute (never a dependency's artifact). ``None``
    #: for ``--list``. The shared-model publisher's default ``files``.
    source_files: tuple[str, ...] | None = None
    #: The consumer providers the run loaded the project with (``providers:`` of the config and
    #: ``--provider``), so a generator that loads files of its own sees the same vocabulary.
    providers: tuple[object, ...] = ()


@dataclass(frozen=True)
class GeneratorEntry:
    """A registry entry: stable name + one-line description + tier + layer + factory."""

    #: Stable, cross-port-consistent id. Equals the registry map key.
    name: str
    #: One-line (no newline) human description for ``--list``.
    description: str
    #: "native" = recommended ``metaobjects gen`` suite; "neutral" = ``meta docs``-owned.
    tier: GeneratorTier
    #: The selection axis — one of :data:`GENERATOR_LAYERS`. Gated cross-port.
    layer: GeneratorLayer
    #: Constructs the generator. Calling it — even with an empty
    #: :class:`GeneratorBuildContext` — must not throw; ``--list`` relies on that.
    factory: Callable[[GeneratorBuildContext], Generator]
    #: Stable names of the generators whose output this one imports. ADR-0056: the template
    #: tier imports a value object's model from the ``entity`` generator's module and
    #: declares none of its own, so wiring it without ``entity`` emits a dangling import.
    #: Not gated cross-port (the manifest carries no such column); surfaced by ``--list``
    #: and warned about by :func:`unsatisfied_requires`.
    requires: tuple[str, ...] = ()
    #: The settings an ``options:`` mapping on this generator's ``generators`` entry may carry.
    #: A generator that lists none refuses any.
    options: tuple[GeneratorOption, ...] = ()
    #: The packaged factory an adopter copies with ``metaobjects eject`` (ADR-0034
    #: Amendment 3). Its module is the file copied; its name is the ``module:symbol``
    #: symbol the copy is wired by. ``None`` = not ejectable (the ``template`` primitive
    #: has no emit logic of its own to own).
    source: Callable[..., Generator] | None = None
    #: Helper modules (under ``metaobjects.codegen.runtime``) handed over with the
    #: generator: the runtime its OUTPUT imports, and the emit rules the generator ITSELF
    #: imports from its ``runtime`` sibling (``shared_predicates``). ``metaobjects eject``
    #: copies their source into the adopter's ``codegen/runtime/`` beside the owned
    #: generator, which then reads that copy instead of the installed package (ADR-0034
    #: Amendment 3: the adopter owns every helper line the generator and its generated code
    #: depend on). Core modules — loader, registry, render, extract, ``ObjectManager`` — are
    #: never listed here: they stay package imports.
    runtime: tuple[str, ...] = ()

    @property
    def source_module(self) -> str | None:
        """Dotted module path of the file ``eject`` copies, or ``None``."""
        return self.source.__module__ if self.source is not None else None

    @property
    def symbol(self) -> str | None:
        """The factory name an owned copy exports, or ``None``."""
        return self.source.__name__ if self.source is not None else None


def _template_primitive(_ctx: GeneratorBuildContext) -> Generator:
    """A no-op default for the ``template`` PRIMITIVE generator.

    ``template_generator`` requires caller-supplied ``template`` / ``walk`` /
    ``provider`` (it is not a zero-config per-entity emitter). For registry
    identity + ``--list`` we expose a default that constructs a valid Generator
    without throwing and walks to zero outputs; real use passes opts via the
    factory-array config path. Mirrors the TS ``templatePrimitive()``.
    """
    return template_generator(
        name="template",
        template="",
        walk=lambda _root: [],
        provider=InMemoryProvider(),
    )


def _render_helper_default(ctx: GeneratorBuildContext) -> Generator:
    """Construct ``render-helper`` against the caller's on-disk template root.

    The ctor requires ``template_root`` to be non-empty for its build-time drift gate
    (it builds a ``FilesystemProvider`` lazily; no disk access at construction). With
    no root supplied — ``--list``, registry identity — we hand it a harmless temp dir
    so construction never throws, exactly as the C# registry does.

    It used to hardcode ``"templates"`` here and the CLI never passed anything, so the
    generator was effectively unreachable: selecting it resolved templates from a
    directory the user had not named, whatever ``--templates`` said.
    """
    return render_helper_generator(
        template_root=ctx.template_root or tempfile.gettempdir())


#: The emit rules several generators share, handed over with each of them so owned copies
#: agree with each other (see ``runtime/shared_predicates.py``).
_SHARED_PREDICATES: tuple[str, ...] = ("shared_predicates",)

#: The emitters a generator writes its output THROUGH, handed over with it: the helper modules
#: that return emitted text, which an owned copy therefore owns instead of calling the
#: packaged copy. Eject copies them next to the generator (``codegen/runtime/``) and the
#: generator imports them relatively. Naming and type-mapping tables, the model walks and the
#: generator base stay in the package as the engine. See ``tests/conformance/test_eject_contract.py``.
_FR010_FIELD_MAPPING = "fr010_field_mapping"
_M2M_CODEGEN = "m2m_codegen"
_FR019_SHARED_ENUM = "fr019_shared_enum"
#: The field.duration codec the entity tier emits as the generated package's ``_duration_wire.py``.
_DURATION_WIRE = "duration_wire"
_EXTRACT_DELEGATE = "extract_delegate_emitter"
_EXTRACT_SCHEMA = "extract_schema_emitter"
_OUTPUT_FORMAT_SPEC = "output_format_spec_emitter"
#: The api reference's page IR, builder, renderer and path math.
_API_DOCS_RUNTIME: tuple[str, ...] = (
    "api_docs_model",
    "api_docs_builder",
    "api_docs_renderer",
    "api_docs_paths",
)

#: Stable name -> GeneratorEntry. The 12 native generators whose manifest `ports`
#: include `python` (ADR-0021 D3). Set equality, tier AND layer are conformance-tested
#: against the manifest.
GENERATOR_REGISTRY: dict[str, GeneratorEntry] = {
    "entity": GeneratorEntry(
        name="entity",
        description=(
            "Per-entity model/class — the entity module (table-backed or value object). "
            "[A field with @stringFormat email is typed pydantic EmailStr, which imports "
            "email-validator when the class is defined, so the consuming project needs "
            "`pydantic[email]` — without it the generated module fails at import.]"
        ),
        tier="native",
        layer="model",
        factory=lambda _ctx: entity_model(),
        source=entity_model,
        runtime=_SHARED_PREDICATES + (_FR019_SHARED_ENUM, _M2M_CODEGEN, _DURATION_WIRE),
    ),
    "routes": GeneratorEntry(
        name="routes",
        description="Per-entity REST endpoint surface (controllers / routes / router).",
        tier="native",
        layer="api",
        factory=lambda ctx: router_generator(**ctx.options),
        options=(
            GeneratorOption(
                "reportMaxRows", "integer", minimum=1,
                description="The row cap of a served report's list route.",
            ),
        ),
        # The router imports <Entity>Create/Patch from the entity module and the
        # FIELDS/OPS constants from <entity>_filter_allowlist; without either the
        # generated package fails at import (ModuleNotFoundError).
        requires=("entity", "filter-allowlist"),
        source=router_generator,
        runtime=_ROUTER_RUNTIME + (_EXPORT_RUNTIME,) + _SHARED_PREDICATES + (_FR010_FIELD_MAPPING, _M2M_CODEGEN),
    ),
    "report-export": GeneratorEntry(
        name="report-export",
        description=(
            "Per-report CSV and XML export writers over a served object.report plus one shared "
            "writer module; wires the ?format=csv|json|xml branch into the report list routes "
            "(options: max_rows, xml_nulls, csv_bom)."
        ),
        tier="native",
        layer="api",
        factory=lambda ctx: report_export_generator(**ctx.options),
        options=(
            GeneratorOption(
                "maxRows", "integer", minimum=1,
                description="The most rows one export holds (default 100000).",
            ),
            GeneratorOption(
                "xmlNulls", "string", choices=("empty", "nil"),
                description="How XML writes a null: an empty element, or xsi:nil.",
            ),
            GeneratorOption(
                "csvBom", "boolean", description="Start a CSV with a byte order mark (default false).",
            ),
        ),
        source=report_export_generator,
    ),
    "shared-model": GeneratorEntry(
        name="shared-model",
        description="A publisher's flattened shared-model artifact plus the manifest that pins it, for a consumer's `deps sync` (FR-023).",
        tier="native",
        layer="capability",
        factory=shared_model_generator,
        options=(
            GeneratorOption("name", "string", required=True, description="The dependency key a consumer syncs under; also the artifact's basename."),
            GeneratorOption("include", "stringList", required=True, description="Scope patterns of the top-level nodes to publish, e.g. acme::common::**."),
            GeneratorOption("exclude", "stringList", description="Scope patterns removed from the selection after include."),
            GeneratorOption("requirements", "boolean", description="Also publish the selected requirement.* nodes (default false)."),
            GeneratorOption("files", "stringList", description="Which of the project's metadata files may contribute, relative to the project root (default: all of them)."),
            GeneratorOption("version", "string", description="The published version (default: the nearest pyproject.toml or package.json version)."),
        ),
        source=shared_model_generator,
    ),
    "output-parser": GeneratorEntry(
        name="output-parser",
        description="Per-template response parser: a strict parse that rejects a reply not matching the @responseRef shape, plus a tolerant, never-raising extract_lenient.",
        tier="native",
        layer="capability",
        factory=lambda _ctx: output_parser_generator(),
        requires=("entity",),
        source=output_parser_generator,
        runtime=(_EXTRACT_DELEGATE, _FR010_FIELD_MAPPING),
    ),
    "output-prompt": GeneratorEntry(
        name="output-prompt",
        description="Per-template output-format prompt fragment generator.",
        tier="native",
        layer="capability",
        factory=lambda _ctx: output_prompt_generator(),
        source=output_prompt_generator,
        runtime=(_OUTPUT_FORMAT_SPEC, _FR010_FIELD_MAPPING),
    ),
    "render-helper": GeneratorEntry(
        name="render-helper",
        description="Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).",
        tier="native",
        layer="capability",
        factory=_render_helper_default,
        requires=("entity",),
        source=render_helper_generator,
    ),
    "extractor": GeneratorEntry(
        name="extractor",
        description="Per-template typed extract<Name> helper: tolerant recovery of the typed response from dirty model text; raises only when a @required field is lost.",
        tier="native",
        layer="capability",
        factory=lambda _ctx: extractor_generator(),
        requires=("entity",),
        source=extractor_generator,
        runtime=_SHARED_PREDICATES + (_EXTRACT_DELEGATE, _FR010_FIELD_MAPPING),
    ),
    "requirement-tests": GeneratorEntry(
        name="requirement-tests",
        description="Per-package pytest tests, one per tested requirement, each calling a project-owned witness function looked up by name in the witness module; a live test with no witness fails and a planned or retired one is skipped.",
        tier="native",
        layer="capability",
        factory=requirement_tests_generator,
        source=requirement_tests_generator,
    ),
    "template": GeneratorEntry(
        name="template",
        description="Generic Mustache template primitive (walk + template -> files).",
        tier="native",
        layer="capability",
        factory=_template_primitive,
    ),
    "filter-allowlist": GeneratorEntry(
        name="filter-allowlist",
        description="Per-entity REST filter allowlist (queryable-field guard).",
        tier="native",
        layer="api",
        factory=lambda _ctx: filter_allowlist_generator(),
        source=filter_allowlist_generator,
        runtime=_SHARED_PREDICATES + (_M2M_CODEGEN,),
    ),
    "names": GeneratorEntry(
        name="names",
        description="Per-entity physical database name constants (table/view name, schema, column names).",
        tier="native",
        layer="model",
        factory=lambda _ctx: names_generator(),
        source=names_generator,
    ),
    "trace-helper": GeneratorEntry(
        name="trace-helper",
        description="Per-entity typed record<Entity> LLM-trace helper (extract + buildLlmCallRow + persist).",
        tier="native",
        layer="capability",
        factory=lambda _ctx: trace_helper_generator(),
        source=trace_helper_generator,
        runtime=(_EXTRACT_SCHEMA, _FR010_FIELD_MAPPING),
    ),
    "api-docs": GeneratorEntry(
        name="api-docs",
        description=(
            "Per-entity/template SDK API reference (generated-code API; human + agent forms). "
            "Writes under its target's outDir; options in the top-level `apiDocs` block."
        ),
        tier="native",
        layer="docs",
        factory=api_docs_generator,
        source=api_docs_generator,
        runtime=_API_DOCS_RUNTIME + _SHARED_PREDICATES + (_M2M_CODEGEN,),
    ),
}


def list_generators() -> list[GeneratorEntry]:
    """All registry entries, sorted by stable name."""
    return sorted(GENERATOR_REGISTRY.values(), key=lambda e: e.name)


def get_generator(name: str) -> GeneratorEntry | None:
    """Resolve a generator entry by its stable id, or ``None`` if unknown."""
    return GENERATOR_REGISTRY.get(name)


def unsatisfied_requires(names: list[str]) -> list[str]:
    """One warning per selected generator whose ``requires`` is not also selected.

    Advisory, never an error: an adopter may keep a hand-written module at the path the
    missing generator would have emitted. Mirrors the TS ``warnUnsatisfiedRequires``."""
    selected = set(names)
    warnings: list[str] = []
    for name in names:
        entry = GENERATOR_REGISTRY.get(name)
        if entry is None:
            continue
        missing = [dep for dep in entry.requires if dep not in selected]
        if not missing:
            continue
        listed = ", ".join(f'"{m}"' for m in missing)
        warnings.append(
            f'"{name}" is selected but {listed} {"is" if len(missing) == 1 else "are"} not. '
            f'The code "{name}" emits imports the modules {listed} would have emitted, so '
            f"importing it will fail. Add {listed} to --generators, or keep your own "
            "hand-written modules at those paths."
        )
    return warnings
