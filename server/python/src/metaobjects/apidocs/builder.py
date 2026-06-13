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
* Templates (``template.output`` only): each → PAYLOAD / RENDER / PROMPT /
  OUTPUT_PARSER / EXTRACTOR, gated by the matching generator's applies-predicate
  (RENDER/PARSER need a resolvable ``@payloadRef``; PROMPT/EXTRACTOR additionally
  need a json/xml ``@format``).

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

# Structured formats that get an output-format prompt + a tolerant extractor.
_STRUCTURED_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


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


def _template_format(tmpl: MetaData) -> str:
    fmt = tmpl.attr(tc.TEMPLATE_ATTR_FORMAT)
    return fmt if isinstance(fmt, str) and fmt else tc.TEMPLATE_FORMAT_DEFAULT


def _payload_resolves(tmpl: MetaData, root: MetaData) -> MetaObject | None:
    """The payload VO a template resolves to (``@payloadRef`` → ``object.value``),
    or ``None`` — the shared gate for payload / render / prompt / parser / extractor."""
    payload_ref = tmpl.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    return resolve_payload_vo(root, payload_ref)


def _is_email_kind(tmpl: MetaData) -> bool:
    kind = tmpl.attr(tc.TEMPLATE_ATTR_KIND)
    return isinstance(kind, str) and kind.lower() == tc.TEMPLATE_KIND_EMAIL


# ---------------------------------------------------------------------------
# Builder.
# ---------------------------------------------------------------------------


class PythonApiModelBuilder:
    """Builds the :class:`ApiModel` SDK-surface IR from a loaded ``MetaRoot``."""

    def build(self, root: MetaData, project: str) -> ApiModel:
        objects = [
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

        # Templates: only template.output is consumed by the payload/render/prompt/
        # parser/extractor generators (the other template subtypes emit nothing).
        for tmpl in root.own_children():
            if tmpl.type == TYPE_TEMPLATE and tmpl.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT:
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
        item = base_path + "/{id}"

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

        # The router registers GET list, GET /{id}, POST, PATCH /{id}, PUT /{id},
        # DELETE /{id} (PATCH + PUT share a handler but are two registered routes).
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
                "GET " + base_path + "/{id}/" + d.relation_name,
                f"M:N traversal — the related {target_name} rows",
            )

    # ----- templates ---------------------------------------------------------

    def _build_template_unit(self, tmpl: MetaData, root: MetaData) -> ApiUnit:
        name = tmpl.name
        module = naming.snake_case(name)
        symbols: list[ApiSymbol] = []
        payload_vo = _payload_resolves(tmpl, root)
        fmt = _template_format(tmpl).lower()

        if payload_vo is not None:
            # PAYLOAD — the typed Pydantic payload model the parser/prompt bind to.
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

            # RENDER — the typed render helper wrapping the render engine.
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

            # OUTPUT_PARSER — the strict ``parse_*`` back into the typed payload.
            parse_fn = naming.output_parser_fn(name)
            symbols.append(
                ApiSymbol(
                    name=parse_fn,
                    kind=ApiSymbolKind.OUTPUT_PARSER,
                    module=f"from .{module}_output_parser import {parse_fn}",
                    signature=f"def {parse_fn}(text)",
                    usage="parses model output back into the typed payload",
                    returns=naming.payload_class_name(name),
                )
            )

            # PROMPT + EXTRACTOR — only for json/xml output templates.
            if fmt in _STRUCTURED_FORMATS:
                prompt_fn = naming.output_prompt_fn(name)
                symbols.append(
                    ApiSymbol(
                        name=prompt_fn,
                        kind=ApiSymbolKind.PROMPT,
                        module=f"from .{module}_output_prompt import {prompt_fn}",
                        signature=f"def {prompt_fn}(overrides=None)",
                        usage="builds the output-format prompt fragment",
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
                        usage="extracts the strict typed payload from dirty model output",
                        returns=naming.payload_class_name(name),
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
            required = f.attr(fc.FIELD_ATTR_REQUIRED) is True
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
