"""Extractor codegen — one ``<template_name>_extractor.py`` per responding
``template.prompt`` (ADR-0052: the extract tier reads a REPLY, so it binds
``@responseRef``; ``template.output`` renders outbound and parses nothing).

The ``extract`` tier (cross-port parity with the Java ``ExtractorCodeGenerator``, the
TS ``renderExtractor``, and the Kotlin / C# ports) sits OVER the existing tolerant
extract. It turns dirty LLM text into the STRICT typed response graph (nested objects +
arrays-of-objects populated) in ONE call:

    extract_<snake>(root, text, opts=None) -> <Vo>
        r = extract_lenient_<snake>_with_loader(root, text, opts)  # nested-capable extract
        if r.report.has_lost_required(): raise ValueError(...)
        return _to_strict_<vo>(r.data)                             # mirror -> strict mapper

Why the loaded ``root``: the SELF-CONTAINED ``extract_<snake>(text)`` leaves nested
objects ``None`` (the historical FR-010 gap — it only maps a flat dict). The
nested-capable path is ``extract_<snake>_with_loader(root, text, opts)`` (emitted by
``output_parser_generator``), which delegates to the metadata-driven runtime extract and
assembles the FULL nested graph reflection-free. So ``extract`` / the re-exposed
``extract`` are loader (``MetaRoot``)-driven, mirroring the Java ``extract(loader, text)``
and the TS ``extract<Name>(root, text)``.

The extract engine returns an all-nullable ``<Vo>Extracted`` mirror (nested VOs as
``<Nested>Extracted``, arrays as ``list[...]``). ``extract`` maps that onto the value
objects' own Pydantic models (ADR-0056 — imported from the entity generator's ``<Vo>.py``
modules; this generator declares none) via a generated recursive ``_to_strict_<vo>``
mapper — one per value-object reachable through nested ``@objectRef`` fields (deduped,
cycle-safe). The mapper one-shot-constructs each model (harmless for Pydantic's mutable
models, required-by-contract for the C#/Kotlin record ports).

NO registry / binding-provider / factory and NO new flavored object-class generation —
codegen walks the whole type graph statically (the same MetaObject walk the
extract-schema / payload emitters use). ``extract`` is re-exposed unchanged under its
public name.
"""
from __future__ import annotations

from collections.abc import Callable

from metaobjects.apidocs.naming import snake_case as _snake_case
from metaobjects.codegen import fr010_field_mapping as fm
from metaobjects.codegen import extract_delegate_emitter as rde
from metaobjects.codegen.constants import generated_header
from metaobjects.codegen.format import ruff_format
from metaobjects.codegen.generator import EmittedFile, GenContext, Generator
from metaobjects.codegen.generators.find_inbound import (
    inbound_templates,
    response_shape,
)
from metaobjects.codegen.generators.entity_model import has_literal_default
from metaobjects.codegen.value_objects import is_field_required, model_class_name, pkg_of
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData

_GENERATOR_NAME = "extractor-generator"


def _mapper_name(vo: MetaData) -> str:
    """``_to_strict_<model_snake>`` — the recursive mirror→strict mapper for a VO, named
    after the value object's emitted model (ADR-0056 rule 3)."""
    return f"_to_strict_{_snake_case(model_class_name(vo))}"


def _value_expr(field: MetaData, root: MetaData, source: str) -> str:
    """The strict value built from the mirror value *source* (an expression known not to
    be ``None``): a nested object goes through its ``_to_strict_*`` mapper, an array drops
    the mirror's null elements, and a scalar/enum passes straight through."""
    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        target = rde.ref_vo(field, root)
        if target is None:
            return source  # unresolved @objectRef — pass the mirror value through
        fn = _mapper_name(target)
        return f"[{fn}(e) for e in {source}]" if fm.is_array(field) else f"{fn}({source})"
    if fm.is_array(field):
        return f"[x for x in {source} if x is not None]"
    return source


def _strict_kwarg(field: MetaData, root: MetaData) -> str:
    """The keyword argument that builds one field of the value object's model from the
    mirror ``m``, matched to the model's own optionality:

    * ``@required``          → ``f=<value>`` (extract guarantees presence when not lost;
                               a lost array reads as empty through ``or []``)
    * literal ``@default``   → ``**({"f": <value>} if m.f is not None else {})`` — the
                               model types the field ``T`` with that default, so a missing
                               value must be OMITTED; passing ``None`` fails validation
    * otherwise optional     → ``f=m.f``, or ``f=(<value> if m.f is not None else None)``
    """
    name = field.name
    mirror = f"m.{name}"
    if is_field_required(field):
        source = f"({mirror} or [])" if fm.is_array(field) else mirror
        return f"{name}={_value_expr(field, root, source)}"
    value = _value_expr(field, root, mirror)
    if has_literal_default(field):
        return f'**({{"{name}": {value}}} if {mirror} is not None else {{}})'
    if value == mirror:
        return f"{name}={mirror}"
    return f"{name}=({value} if {mirror} is not None else None)"


def _emit_mapper(vo: MetaData, root: MetaData) -> list[str]:
    """One ``_to_strict_<vo>(m) -> <Vo>`` mapper, one-shot-constructing the value object's
    model from the mirror ``m``."""
    fn = _mapper_name(vo)
    strict = model_class_name(vo)
    lines: list[str] = [
        f"def {fn}(m) -> {strict}:",
        f'    """Map the all-nullable extracted mirror onto the strict ``{strict}``.',
        '    One-shot constructed; generated."""',
        f"    return {strict}(",
    ]
    for f in fm.fields(vo):
        lines.append(f"        {_strict_kwarg(f, root)},")
    lines.append("    )")
    return lines


def render_extractor(
    template: MetaData,
    root: MetaData,
    *,
    generator: "ExtractorGenerator | None" = None,
) -> str | None:
    """Render one ``<snake>_extractor.py`` for a responding ``template.prompt`` node.

    When *generator* is supplied, its ``_emit_mapper`` override is used for each
    mirror→strict mapper (the extension seam); when ``None`` the module-level
    :func:`_emit_mapper` is used (byte-identical back-compat path).

    Returns ``None`` when the template declares no ``@responseRef`` or the ref can't
    be resolved to a payload target. ADR-0052: no format gate remains —
    ``@responseFormat`` is a closed json|xml set, so every responding prompt has a
    tolerant ``extract_lenient_*_with_loader`` to sit over."""
    # ADR-0052: the extract tier reads a REPLY, so it binds @responseRef.
    shape = response_shape(root, template, pkg_of(template))
    if shape is None:
        return None
    payload = shape.vo

    template_name = template.name
    snake = _snake_case(template_name)
    parser_module = f"{snake}_response_parser"
    extract_lenient_with_fn = f"extract_lenient_{snake}_with_loader"
    extract_lenient_fn = f"extract_lenient_{snake}"
    extract_fn = f"extract_{snake}"
    root_strict = model_class_name(payload)

    fqn = f"{payload.package}::{template_name}" if payload.package else template_name

    # The strict graph (ADR-0056): the response value object's model and every nested
    # value object's model, each imported from the entity generator's `<Vo>.py` (the
    # module name IS the class name). Reachable through @objectRef, deduped, cycle-safe.
    vos = rde.reachable_vos(payload, root)
    root_mapper = _mapper_name(payload)
    strict_imports = sorted({model_class_name(vo) for vo in vos})

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
        f"from .{parser_module} import {extract_lenient_with_fn}",
        *(f"from .{cls} import {cls}" for cls in strict_imports),
    ]
    lines.append("")
    lines.append("")

    # extract — extract then map onto the strict payload, raising on lost-required.
    lines.append(f"def {extract_fn}(root, text, opts=None) -> {root_strict}:")
    lines.append(f'    """Extract a fully-typed ``{root_strict}`` from dirty ``text`` using the')
    lines.append(f"    loaded ``root`` (which must declare the ``{payload.name}`` payload")
    lines.append("    value-object). Runs the tolerant nested-capable extract, then maps the")
    lines.append("    extracted mirror graph onto the strict Pydantic payload graph.")
    lines.append("")
    lines.append("    :raises ValueError: iff a ``@required`` field was lost (the strict gate).")
    lines.append('    """')
    lines.append(f"    r = {extract_lenient_with_fn}(root, text, opts)")
    lines.append("    if r.report.has_lost_required():")
    lines.append("        raise ValueError(")
    lines.append(
        f'            "{extract_fn}: lost required field(s): "'
    )
    lines.append('            + ", ".join(r.report.lost_required())')
    lines.append("        )")
    lines.append(f"    return {root_mapper}(r.data)")
    lines.append("")
    lines.append("")

    # extract — re-exposed under the public name, delegating to the nested-capable path.
    lines.append(f"def {extract_lenient_fn}(root, text, opts=None):")
    lines.append(f'    """Extract a best-effort ``{rde.mirror_name(payload)}`` mirror from dirty')
    lines.append("    ``text`` using the loaded ``root``; never raises. Re-exposes the")
    lines.append("    nested-capable extract; inspect ``report`` for lost / defaulted fields.")
    lines.append('    """')
    lines.append(f"    return {extract_lenient_with_fn}(root, text, opts)")
    lines.append("")
    lines.append("")

    # One mirror→strict mapper per reachable VO (root + nested), in BFS order.
    emit_mapper = generator._emit_mapper if generator is not None else _emit_mapper
    for i, vo in enumerate(vos):
        if i > 0:
            lines.append("")
            lines.append("")
        lines.extend(emit_mapper(vo, root))

    lines.append("")
    lines.append("")
    lines.append(f'__all__ = ["{extract_fn}", "{extract_lenient_fn}"]')
    lines.append("")
    return "\n".join(lines)


class ExtractorGenerator:
    """Generator wrapping ``render_extractor``. Emits one file per responding
    ``template.prompt`` declared at root level (mirrors ``OutputParserGenerator``)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        self.filter = filter

    def _emit_mapper(self, vo: MetaData, root: MetaData) -> list[str]:
        """EXTENSION SEAM — one ``_to_strict_<vo>(m) -> <Vo>`` mirror→strict mapper
        block. Defaults to the module-level :func:`_emit_mapper`; override to customize
        how the extracted mirror graph is mapped onto the value objects' models (e.g.
        coercion, post-validation, default-filling)."""
        return _emit_mapper(vo, root)

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole extractor module for one responding
        ``template.prompt``. Defaults to :func:`render_extractor` (passing this
        instance so the ``_emit_mapper`` override is honored). Override to
        pre/post-process the emitted source or replace the render path."""
        return render_extractor(template, root, generator=self)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        # ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        for tmpl in inbound_templates(root):
            content = self._render_module(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template.prompt "
                    f"'{tmpl.name}' (@responseRef does not resolve to a payload target)."
                )
                continue
            files.append(
                EmittedFile(
                    path=f"{_snake_case(tmpl.name)}_extractor.py",
                    content=ruff_format(content),
                )
            )
        return files


def extractor_generator(
    *, filter: Callable[[MetaObject], bool] | None = None
) -> Generator:
    """Factory mirroring the TS ``extractor()`` and the Java ``ExtractorCodeGenerator``."""
    return ExtractorGenerator(filter=filter)
