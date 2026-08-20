"""Builds the Python SDK api-surface IR (:class:`ApiModel`) from a loaded MetaRoot.

This is the ACCURATE-BY-CONSTRUCTION half of the api-docs pipeline: every
documented symbol name comes from the :mod:`metaobjects.apidocs.naming` seam (never
re-concatenated here — the SAME seam the real generators delegate to), and every
inclusion decision comes from an applies-predicate that REUSES the corresponding
generator's own gate helpers (``emits_instance_artifacts`` / ``_primary_source_rdb``
+ source kind / ``resolve_payload_vo`` / format check / ``is_tph_subtype``) rather
than re-implementing the gate. The result is that what this builder documents ==
what the generators emit, by SHARING the single source of truth.

Per-category enumeration (mirrors the Java ``JavaApiModelBuilder`` / C#
``CSharpApiModelBuilder``, Python/Pydantic-flavored):

* Objects (``root.own_children()`` filtered to ``object.*``): each concrete object
  → a MODEL symbol. A writable-table entity adds DATA_ACCESS (the repository
  ``Protocol``) / REST (one per FastAPI route) / VALIDATION (Pydantic field
  constraints on the create/update shape) / FILTER (the allowlist). A value object
  → MODEL only. An abstract object / a TPH subtype yields no instance artifacts.
* Templates (EVERY subtype — ADR-0052): a resolvable ``@payloadRef`` gives the
  PAYLOAD record it renders outbound, plus RENDER for a ``template.output`` (the
  only subtype the render-helper generator emits for). A ``template.prompt``
  declaring ``@responseRef`` adds the INBOUND tier — the response PAYLOAD record,
  PROMPT (the response-format fragment) and EXTRACTOR, plus OUTPUT_PARSER unless
  the reply is XML, which gets no strict tier (ADR-0053).

An object that yields no symbols (e.g. an abstract object) produces NO unit at all
(never an empty unit).
"""
from __future__ import annotations

from metaobjects.apidocs import naming
from metaobjects.apidocs.api_model import (
    ApiModel,
    ApiSymbol,
    ApiSymbolKind,
    ApiUnit,
    FieldShape,
)
from metaobjects.codegen import type_map
from metaobjects.codegen.generators.m2m_codegen import (
    build_object_index,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.find_inbound import is_xml, response_shape
from metaobjects.codegen.generators.payload_vo_generator import (
    is_field_required,
    resolve_payload_vo,
)
from metaobjects.codegen.generators.router_generator import _primary_source_rdb
from metaobjects.codegen.generators.tph_plan import is_tph_subtype
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts, is_abstract
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.persistence.source.source_constants import SOURCE_KIND_TABLE
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_TEMPLATE
from metaobjects.shared.separators import PACKAGE_SEP


def _pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the
    trailing ``::<name>`` ("" for a root-level node). Duplicated (not imported) to
    match the existing per-generator convention. Used to derive a template's
    referrer package for ``resolve_payload_vo`` (#228) — see that function's
    docstring for why this ancestor-walk-aware form is used instead of the
    loader's bare ``tpl.package or tpl.file_default_package or ""``."""
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


# ---------------------------------------------------------------------------
# Applies-predicates — each REUSES the matching generator's own gate helpers, so
# inclusion can never drift from emission. (The Python generators gate inline;
# these mirror that gate exactly via the shared helpers.)
# ---------------------------------------------------------------------------


def _is_writable_table_entity(obj: MetaObject, object_index: dict[str, MetaObject]) -> bool:
    """The shared gate for the router + filter-allowlist generators: a non-abstract
    entity with a ``source.rdb`` ``@kind="table"`` child that is NOT a TPH subtype
    (a TPH subtype is folded into its base's single table — it emits no standalone
    router/allowlist)."""
    if obj.sub_type != OBJECT_SUBTYPE_ENTITY:
        return False
    if not emits_instance_artifacts(obj):
        return False
    if is_tph_subtype(obj):
        return False
    src = _primary_source_rdb(obj)
    if src is None:
        return False
    return src.effective_kind() == SOURCE_KIND_TABLE


def _payload_resolves(tmpl: MetaData, root: MetaData) -> MetaObject | None:
    """The payload VO a template resolves to (``@payloadRef`` → ``object.value``),
    or ``None`` — the shared gate for payload / render / prompt / parser / extractor."""
    payload_ref = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    # ADR-0042 (#228): the referrer is THIS template — a bare @payloadRef resolves
    # in ITS OWN package first.
    return resolve_payload_vo(root, payload_ref, _pkg_of(tmpl))


def _is_email_kind(tmpl: MetaData) -> bool:
    kind = tmpl.get_meta_attr(tc.TEMPLATE_ATTR_KIND)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    return isinstance(kind, str) and kind.lower() == tc.TEMPLATE_KIND_EMAIL


# ---------------------------------------------------------------------------
# Builder.
# ---------------------------------------------------------------------------


class PythonApiModelBuilder:
    """Builds the :class:`ApiModel` SDK-surface IR from a loaded ``MetaRoot``."""

    def build(self, root: MetaData, project: str) -> ApiModel:
        objects = [
            # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
            c
            for c in root.own_children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        ]
        object_index = build_object_index(objects)

        units: list[ApiUnit] = []
        for obj in objects:
            unit = self._build_object_unit(obj, root, object_index)
            if unit is not None:
                units.append(unit)

        # Templates: ADR-0052 — EVERY template subtype gets a unit, not just
        # template.output. A template.prompt carries a @payloadRef record and, when it
        # declares @responseRef, the whole inbound tier — all of it generated, so all
        # of it documentable.
        # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
        for tmpl in root.own_children():
            if tmpl.type == TYPE_TEMPLATE:
                units.append(self._build_template_unit(tmpl, root))

        return ApiModel(project, units)

    # ----- objects -----------------------------------------------------------

    def _build_object_unit(
        self, obj: MetaObject, root: MetaData, object_index: dict[str, MetaObject]
    ) -> ApiUnit | None:
        entity = obj.sub_type == OBJECT_SUBTYPE_ENTITY
        module = naming.snake_case(obj.name)
        unit_kind = "entity" if entity else "value"
        symbols: list[ApiSymbol] = []

        # MODEL — only for concrete objects (an abstract object cannot be
        # instantiated → documented ⊆ generated). A value object → MODEL only.
        if not is_abstract(obj):
            model = naming.model_class_name(obj.name)
            symbols.append(
                ApiSymbol(
                    name=model,
                    kind=ApiSymbolKind.MODEL,
                    module=f"from .{module} import {model}",
                    signature=f"class {model}(BaseModel)",
                    usage=(
                        "the Pydantic v2 entity model"
                        if entity
                        else "the Pydantic v2 value-object model"
                    ),
                )
            )

        if entity and _is_writable_table_entity(obj, object_index):
            # VALIDATION — the Pydantic field constraints carried on the model
            # (required / max-length / range / pattern). Names the model class.
            model = naming.model_class_name(obj.name)
            symbols.append(
                ApiSymbol(
                    name=model,
                    kind=ApiSymbolKind.VALIDATION,
                    module=f"from .{module} import {model}",
                    signature=f"class {model}(BaseModel)",
                    usage="Pydantic field validation on the create/update shape",
                    fields=self._model_fields(obj),
                )
            )

            # DATA_ACCESS — the consumer-implemented repository ``Protocol`` seam.
            repo = naming.repository_class_name(obj.name)
            symbols.append(
                ApiSymbol(
                    name=repo,
                    kind=ApiSymbolKind.DATA_ACCESS,
                    module=f"from .{naming.router_module_name(obj.name)} import {repo}",
                    signature=f"class {repo}(Protocol)",
                    usage="data access — the repository Protocol the consumer implements",
                    returns="list / Optional / bool",
                )
            )

            # REST — one symbol per FastAPI route the router registers.
            self._add_rest_symbols(symbols, obj, module, root, object_index)

            # FILTER — the per-entity sort/filter allowlist.
            fields_const = naming.filter_fields_const(obj.name)
            symbols.append(
                ApiSymbol(
                    name=fields_const,
                    kind=ApiSymbolKind.FILTER,
                    module=(
                        f"from .{naming.filter_allowlist_module_name(obj.name)} "
                        f"import {fields_const}"
                    ),
                    signature=f"{fields_const}: frozenset[str]",
                    usage="the filterable-field + filter-operator allowlist",
                )
            )

        if not symbols:
            return None
        return ApiUnit(obj.name, _package_of(obj), unit_kind, symbols)

    def _add_rest_symbols(
        self,
        symbols: list[ApiSymbol],
        entity: MetaObject,
        module: str,
        root: MetaData,
        object_index: dict[str, MetaObject],
    ) -> None:
        router_module = naming.router_module_name(entity.name)
        base_path = "/api/" + naming.route_path(entity.name)
        # The router registers the item routes with a per-entity path param
        # (`/{<entity>_id}`, e.g. `/{customer_id}`) — document that exact name, not
        # a generic `{id}`, so the docs match the generated FastAPI routes.
        pk = naming.pk_param(entity.name)
        item = base_path + "/{" + pk + "}"

        def add(verb_path: str, usage: str) -> None:
            symbols.append(
                ApiSymbol(
                    name=verb_path,
                    kind=ApiSymbolKind.REST,
                    module=f"# {router_module}.py — FastAPI APIRouter",
                    signature=verb_path,
                    usage=usage,
                )
            )

        # The router registers GET list, GET item, POST, PATCH item, PUT item,
        # DELETE item (PATCH + PUT share a handler but are two registered routes).
        add("GET " + base_path, "list with pagination / sort / filters")
        add("GET " + item, "fetch one by id")
        add("POST " + base_path, "create")
        add("PATCH " + item, "update")
        add("PUT " + item, "update (PUT alias)")
        add("DELETE " + item, "delete")

        # M:N traversal — GET /<source-plural>/{id}/<relation>.
        for d in resolve_m2m_descriptors(entity, object_index):
            target = object_index.get(d.target_entity)
            target_name = target.name if target is not None else d.target_entity
            add(
                "GET " + base_path + "/{" + pk + "}/" + d.relation_name,
                f"M:N traversal — the related {target_name} rows",
            )

    # ----- templates ---------------------------------------------------------

    def _build_template_unit(self, tmpl: MetaData, root: MetaData) -> ApiUnit:
        name = tmpl.name
        module = naming.snake_case(name)
        symbols: list[ApiSymbol] = []
        payload_vo = _payload_resolves(tmpl, root)

        if payload_vo is not None:
            # PAYLOAD — the typed Pydantic record for the shape this template RENDERS.
            payload_class = naming.payload_class_name(name)
            symbols.append(
                ApiSymbol(
                    name=payload_class,
                    kind=ApiSymbolKind.PAYLOAD,
                    module=(
                        f"from .{naming.payload_module_name(name)} import {payload_class}"
                    ),
                    signature=f"class {payload_class}(BaseModel)",
                    usage="the typed payload projection bound to the template",
                    fields=self._payload_fields(payload_vo),
                )
            )

            # RENDER — the typed render helper wrapping the render engine. OUTBOUND
            # ONLY: render_helper_generator emits for a template.output alone, so
            # documenting it for a prompt would name a function never generated.
            if tmpl.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT:
                render_fn = naming.render_helper_fn(name)
                symbols.append(
                    ApiSymbol(
                        name=render_fn,
                        kind=ApiSymbolKind.RENDER,
                        module=f"from .{module}_render_helper import {render_fn}",
                        signature=f"def {render_fn}(payload, provider)",
                        usage="renders the output template against a typed payload",
                        returns="EmailDocument" if _is_email_kind(tmpl) else "str",
                    )
                )

        # ADR-0052 — the INBOUND symbols belong to a RESPONDING template.prompt, never
        # to an output, and the gate is @responseRef PRESENCE rather than a format
        # value. Shares `response_shape` with the generators, so the docs can never
        # claim a symbol codegen suppressed.
        inbound = response_shape(root, tmpl, _pkg_of(tmpl))
        if inbound is not None:
            # The RESPONSE record the parser actually returns — not the @payloadRef
            # request record documented above, which types what this prompt renders out.
            response_class = naming.response_class_name(name)
            symbols.append(
                ApiSymbol(
                    name=response_class,
                    kind=ApiSymbolKind.PAYLOAD,
                    module=(
                        f"from .{naming.response_module_name(name)} import {response_class}"
                    ),
                    signature=f"class {response_class}(BaseModel)",
                    usage="the typed response shape a model reply is parsed into",
                    fields=self._payload_fields(inbound.vo),
                )
            )

            # OUTPUT_PARSER — the strict ``parse_*``. ADR-0053: JSON-only, so an XML
            # reply gets no strict tier and documenting one would name a missing fn.
            if not is_xml(inbound.format):
                parse_fn = naming.output_parser_fn(name)
                symbols.append(
                    ApiSymbol(
                        name=parse_fn,
                        kind=ApiSymbolKind.OUTPUT_PARSER,
                        module=f"from .{module}_response_parser import {parse_fn}",
                        signature=f"def {parse_fn}(text)",
                        usage="parses a model reply back into the typed response shape",
                        returns=response_class,
                    )
                )

            prompt_fn = naming.output_prompt_fn(name)
            symbols.append(
                ApiSymbol(
                    name=prompt_fn,
                    kind=ApiSymbolKind.PROMPT,
                    module=f"from .{module}_response_format import {prompt_fn}",
                    signature=f"def {prompt_fn}(overrides=None)",
                    usage="builds the response-format prompt fragment",
                    returns="str",
                )
            )
            extract_fn = naming.extractor_fn(name)
            symbols.append(
                ApiSymbol(
                    name=extract_fn,
                    kind=ApiSymbolKind.EXTRACTOR,
                    module=f"from .{module}_extractor import {extract_fn}",
                    signature=f"def {extract_fn}(root, text, opts=None)",
                    usage="extracts the strict typed response from dirty model output",
                    returns=response_class,
                )
            )

        return ApiUnit(name, _package_of(tmpl), "template", symbols)

    # ----- field shapes -------------------------------------------------------

    def _model_fields(self, entity: MetaObject) -> list[FieldShape]:
        """The entity's documented scalar/enum field shapes — one row per field the
        Pydantic model maps (object-typed fields are owned-type navs, not a scalar
        documented shape). Types via ``type_map.py_type_for``; required = own
        ``@required`` is the boolean ``True`` (the same boundary the model uses)."""
        rows: list[FieldShape] = []
        for f in entity.fields():
            if not isinstance(f, MetaField):
                continue
            if f.sub_type == fc.FIELD_SUBTYPE_OBJECT:
                continue
            type_expr = type_map.py_type_for(f).expr
            note = None
            if f.sub_type == fc.FIELD_SUBTYPE_ENUM:
                values = type_map.effective_enum_values(f)
                if values:
                    note = "allowed: " + " | ".join(values)
            required = f.get_meta_attr(fc.FIELD_ATTR_REQUIRED) is True  # ADR-0039: resolving (@required may be inherited)
            rows.append(FieldShape(f.name, type_expr, optional=not required, note=note))
        return rows

    def _payload_fields(self, vo: MetaObject) -> list[FieldShape]:
        """The payload model's documented field shapes — one row per field of the
        ``@payloadRef`` value object, with optionality from ``is_field_required``
        (shared with the payload-VO generator, so there is no skew)."""
        rows: list[FieldShape] = []
        for f in vo.fields():
            if not isinstance(f, MetaField):
                continue
            type_expr = type_map.py_type_for(f).expr
            rows.append(
                FieldShape(f.name, type_expr, optional=not is_field_required(f))
            )
        return rows


def _package_of(node: MetaData) -> str:
    """The unit's metadata package (``"acme::shop"``) — drives the doc-page layout
    path. Resolved from the nearest ancestor that carries one (objects inherit the
    file/root package)."""
    pkg = node.package
    parent = node.parent
    while pkg is None and parent is not None:
        pkg = parent.package
        parent = parent.parent
    return pkg or ""


def build_api_model(root: MetaData, project: str) -> ApiModel:
    """Module-level convenience: build the Python SDK api-surface IR."""
    return PythonApiModelBuilder().build(root, project)
