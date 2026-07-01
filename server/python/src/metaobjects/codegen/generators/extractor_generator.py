"""Extractor codegen — one ``<template_name>_extractor.py`` per ``template.output``.

The ``extract`` tier (cross-port parity with the Java ``ExtractorCodeGenerator``, the
TS ``renderExtractor``, and the Kotlin / C# ports) sits OVER the existing tolerant
extract. It turns dirty LLM text into the STRICT typed payload graph (nested objects +
arrays-of-objects populated) in ONE call:

    extract_<snake>(root, text, opts=None) -> <Template>Payload
        r = extract_<snake>_with_loader(root, text, opts)   # nested-capable extract
        if r.report.has_lost_required(): raise ValueError(...)
        return _to_strict_<RootVo>(r.data)                  # mirror -> strict mapper

Why the loaded ``root``: the SELF-CONTAINED ``extract_<snake>(text)`` leaves nested
objects ``None`` (the historical FR-010 gap — it only maps a flat dict). The
nested-capable path is ``extract_<snake>_with_loader(root, text, opts)`` (emitted by
``output_parser_generator``), which delegates to the metadata-driven runtime extract and
assembles the FULL nested graph reflection-free. So ``extract`` / the re-exposed
``extract`` are loader (``MetaRoot``)-driven, mirroring the Java ``extract(loader, text)``
and the TS ``extract<Name>(root, text)``.

The extract engine returns an all-nullable ``<Template>PayloadExtracted`` mirror (nested
VOs as ``<Vo>Extracted``, arrays as ``list[...]``). ``extract`` maps that onto the strict
``<Template>Payload`` Pydantic model (nested VOs as ``<Vo>Payload``, arrays as
``list[<Vo>Payload]``) via a generated recursive ``_to_strict_<vo>`` mapper — one per
value-object reachable through nested ``@objectRef`` fields (deduped, cycle-safe). The
mapper one-shot-constructs each Pydantic model (harmless for Pydantic's mutable models,
required-by-contract for the C#/Kotlin record ports).

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
from metaobjects.codegen.generators.payload_vo_generator import (
    is_field_required,
    payload_class_name,
    payload_module_name,
    resolve_payload_vo,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.template import template_constants as tc
from metaobjects.shared.base_types import TYPE_TEMPLATE

_GENERATOR_NAME = "extractor-generator"

# The extract tier only exists where the tolerant extract API does — json/xml.
_EXTRACT_FORMATS = frozenset({tc.TEMPLATE_FORMAT_JSON, tc.TEMPLATE_FORMAT_XML})


def _strict_class(vo: MetaData, root_vo: MetaData, template_name: str) -> str:
    """The strict Pydantic class name for a value-object. The ROOT payload VO maps to
    the template-named ``<Template>Payload`` (payload_vo emits the primary class under
    the template name); every nested VO maps to ``<Vo>Payload``."""
    if vo.name == root_vo.name:
        return payload_class_name(template_name)
    return payload_class_name(vo.name)


def _mapper_name(vo: MetaData) -> str:
    """``_to_strict_<vo_snake>`` — the recursive mirror→strict mapper for a VO."""
    return f"_to_strict_{_snake_case(vo.name)}"


def _strict_arg(field: MetaData, root: MetaData) -> str:
    """The strict-payload initializer expression for one field, reading the mirror
    member ``m.<name>`` and mapping it onto the strict payload's exact optionality
    (``is_field_required`` — shared with payload_vo so there is no skew).

    * required scalar/enum   → ``m.f`` (extract guarantees presence when not lost)
    * optional scalar/enum   → ``m.f`` (the strict field is ``T | None``)
    * scalar ARRAY           → ``[x for x in (m.f or []) if x is not None]`` (drop the
                               mirror's possible-null elements; the strict type is
                               ``list[T]`` / ``list[T] | None``)
    * single nested object   → ``_to_strict_<Vo>(m.f)`` (None-guarded when optional)
    * array-of-objects       → ``[_to_strict_<Vo>(e) for e in (m.f or [])]``
    """
    name = field.name
    required = is_field_required(field)

    if field.sub_type == fc.FIELD_SUBTYPE_OBJECT:
        target = rde.ref_vo(field, root)
        if target is None:
            return f"m.{name}"  # unresolved @objectRef — pass the mirror value through
        fn = _mapper_name(target)
        if fm.is_array(field):
            # Required or optional array-of-objects: map present elements (drop Nones).
            return f"[{fn}(e) for e in (m.{name} or [])]" if required else (
                f"([{fn}(e) for e in m.{name}] if m.{name} is not None else None)"
            )
        # Single nested object.
        if required:
            return f"{fn}(m.{name})"
        return f"({fn}(m.{name}) if m.{name} is not None else None)"

    # Scalar ARRAY: mirror is list[T | None] | None; strict is list[T] (/ | None).
    if fm.is_array(field):
        if required:
            return f"[x for x in (m.{name} or []) if x is not None]"
        return (
            f"([x for x in m.{name} if x is not None] "
            f"if m.{name} is not None else None)"
        )

    # Scalar / enum (single): pass the mirror value straight through. The strict field
    # is ``T`` when required (extract guarantees presence — lost-required already
    # raised) and ``T | None`` when optional, so a bare ``m.f`` fits both.
    return f"m.{name}"


def _emit_mapper(vo: MetaData, root: MetaData, root_vo: MetaData, template_name: str) -> list[str]:
    """One ``_to_strict_<vo>(m) -> <Strict>`` mapper, one-shot-constructing the strict
    Pydantic model from the mirror ``m``."""
    fn = _mapper_name(vo)
    strict = _strict_class(vo, root_vo, template_name)
    lines: list[str] = [
        f"def {fn}(m) -> {strict}:",
        f'    """Map the all-nullable extracted mirror onto the strict ``{strict}``.',
        '    One-shot constructed; generated."""',
        f"    return {strict}(",
    ]
    for f in fm.fields(vo):
        lines.append(f"        {f.name}={_strict_arg(f, root)},")
    lines.append("    )")
    return lines


def render_extractor(
    template: MetaData,
    root: MetaData,
    *,
    generator: "ExtractorGenerator | None" = None,
) -> str | None:
    """Render one ``<snake>_extractor.py`` for a ``template.output`` node.

    When *generator* is supplied, its ``_emit_mapper`` override is used for each
    mirror→strict mapper (the extension seam); when ``None`` the module-level
    :func:`_emit_mapper` is used (byte-identical back-compat path).

    Returns ``None`` when the ``@payloadRef`` can't be resolved to an ``object.value``,
    or when the target ``@format`` is not json/xml (the extract tier requires the
    tolerant extract API, which only the json/xml output-parsers emit)."""
    payload_ref = template.get_meta_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    if not isinstance(payload_ref, str) or not payload_ref:
        return None
    payload = resolve_payload_vo(root, payload_ref)
    if payload is None:
        return None

    fmt = template.get_meta_attr(tc.TEMPLATE_ATTR_FORMAT)  # ADR-0039: template attr resolves via extends (not origin; templates CAN extend)
    fmt_str = fmt if isinstance(fmt, str) else tc.TEMPLATE_FORMAT_DEFAULT
    if fmt_str.lower() not in _EXTRACT_FORMATS:
        return None

    template_name = template.name
    snake = _snake_case(template_name)
    parser_module = f"{snake}_output_parser"
    payload_module = payload_module_name(template_name)
    extract_lenient_with_fn = f"extract_lenient_{snake}_with_loader"
    extract_lenient_fn = f"extract_lenient_{snake}"
    extract_fn = f"extract_{snake}"
    root_strict = payload_class_name(template_name)
    root_mapper = _mapper_name(payload)

    fqn = f"{payload.package}::{template_name}" if payload.package else template_name

    # The strict payload graph: root payload class (template-named) + every nested
    # VO's ``<Vo>Payload`` (reachable through @objectRef, deduped/cycle-safe — the SAME
    # walk payload_vo emits the nested classes for, so each import resolves).
    vos = rde.reachable_vos(payload, root)
    strict_imports = {root_strict}
    for vo in vos:
        if vo.name != payload.name:
            strict_imports.add(payload_class_name(vo.name))

    lines: list[str] = [
        generated_header(template_name, fqn),
        "from __future__ import annotations\n",
        f"from .{parser_module} import {extract_lenient_with_fn}",
        f"from .{payload_module} import (",
    ]
    for cls in sorted(strict_imports):
        lines.append(f"    {cls},")
    lines.append(")")
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
    lines.append(f'    """Extract a best-effort ``{root_strict}Extracted`` mirror from dirty')
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
        lines.extend(emit_mapper(vo, root, payload, template_name))

    lines.append("")
    lines.append("")
    lines.append(f'__all__ = ["{extract_fn}", "{extract_lenient_fn}"]')
    lines.append("")
    return "\n".join(lines)


class ExtractorGenerator:
    """Generator wrapping ``render_extractor``. Emits one file per ``template.output``
    declared at root level (mirrors ``OutputParserGenerator``)."""

    name = _GENERATOR_NAME

    def __init__(self, *, filter: Callable[[MetaObject], bool] | None = None) -> None:
        self.filter = filter

    def _emit_mapper(
        self,
        vo: MetaData,
        root: MetaData,
        root_vo: MetaData,
        template_name: str,
    ) -> list[str]:
        """EXTENSION SEAM — one ``_to_strict_<vo>(m) -> <Strict>`` mirror→strict
        mapper block. Defaults to the module-level :func:`_emit_mapper`; override to
        customize how the extracted mirror graph is mapped onto the strict Pydantic
        payload (e.g. coercion, post-validation, default-filling)."""
        return _emit_mapper(vo, root, root_vo, template_name)

    def _render_module(self, template: MetaData, root: MetaData) -> str | None:
        """EXTENSION SEAM — render the whole extractor module for one
        ``template.output``. Defaults to :func:`render_extractor` (passing this
        instance so the ``_emit_mapper`` override is honored). Override to
        pre/post-process the emitted source or replace the render path."""
        return render_extractor(template, root, generator=self)

    def generate(self, ctx: GenContext) -> list[EmittedFile]:
        root = ctx.loaded_root
        if root is None:
            return []
        files: list[EmittedFile] = []
        outputs = sorted(
            (
                # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended, own == effective)
                c
                for c in root.own_children()
                if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT
            ),
            key=lambda c: c.name,
        )
        for tmpl in outputs:
            content = self._render_module(tmpl, root)
            if content is None:
                ctx.warn(
                    f"{_GENERATOR_NAME}: skipping template.output "
                    f"'{tmpl.name}' (no resolvable @payloadRef or non-json/xml format)."
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
